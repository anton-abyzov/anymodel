// LMStudio provider for anymodel
// Thin delegator to the OpenAI provider — LMStudio exposes an OpenAI-compatible
// endpoint at /v1 by default. The Bearer token is ignored by the server but
// must be present, so we send a placeholder.

import http from 'http';
import { translateRequest, translateResponse, createStreamTranslator } from './openai.mjs';

// Use 127.0.0.1 — Node's http.get resolves "localhost" to ::1 (IPv6) which
// LMStudio doesn't listen on by default, producing ECONNREFUSED.
const DEFAULT_BASE_URL = 'http://127.0.0.1:1234/v1';

function getBaseUrl() {
  return process.env.LMSTUDIO_BASE_URL || DEFAULT_BASE_URL;
}

export default {
  name: 'lmstudio',

  buildRequest(url, payload) {
    const parsedUrl = new URL(getBaseUrl());
    return {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      protocol: parsedUrl.protocol,
      path: `${parsedUrl.pathname.replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer lm-studio',
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  transformRequest: translateRequest,
  transformResponse: translateResponse,
  createStreamTranslator,

  displayInfo(model) {
    const base = getBaseUrl();
    return model ? `(${model} @ ${base})` : `(${base})`;
  },

  // Probe GET /v1/models — any HTTP response (2xx/4xx) means the server is up.
  detect() {
    return new Promise(resolve => {
      const parsedUrl = new URL(getBaseUrl());
      const req = http.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: `${parsedUrl.pathname.replace(/\/$/, '')}/models`,
      }, res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  },

  // Try LMStudio-native /api/v0/models (includes `state: "loaded"`), fall back
  // to OpenAI-compatible /v1/models. Returns array of { id, loaded, capabilities }.
  listModels() {
    const parsedUrl = new URL(getBaseUrl());
    const hostname = parsedUrl.hostname;
    const port = parsedUrl.port || 80;

    const tryV0 = new Promise(resolve => {
      const req = http.get({ hostname, port, path: '/api/v0/models' }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const entries = (parsed.data || [])
              .filter(m => m.type !== 'embeddings' && !/embed/i.test(m.id || ''))
              .map(m => ({
                id: m.id,
                loaded: m.state === 'loaded',
                capabilities: m.capabilities || [],
              }));
            resolve(entries);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(1000, () => { req.destroy(); resolve(null); });
    });

    const tryV1 = new Promise(resolve => {
      const req = http.get({
        hostname, port,
        path: `${parsedUrl.pathname.replace(/\/$/, '')}/models`,
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const entries = (parsed.data || [])
              .filter(m => !/embed/i.test(m.id || ''))
              .map(m => ({ id: m.id, loaded: undefined, capabilities: [] }));
            resolve(entries);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(1000, () => { req.destroy(); resolve([]); });
    });

    return tryV0.then(v0 => v0 && v0.length ? v0 : tryV1);
  },
};
