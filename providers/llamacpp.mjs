// llama.cpp provider for anymodel
// Thin delegator to the OpenAI provider — llama-server (llama.cpp) exposes an
// OpenAI-compatible endpoint at /v1 by default. The Bearer token is ignored by
// the server but must be non-empty, so we send a placeholder.

import http from 'http';
import { translateRequest, translateResponse, createStreamTranslator } from './openai.mjs';

const DEFAULT_BASE_URL = 'http://localhost:8080/v1';

function getBaseUrl() {
  return process.env.LLAMACPP_BASE_URL || DEFAULT_BASE_URL;
}

export default {
  name: 'llamacpp',

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
        'authorization': 'Bearer no-key',
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

  // GET /v1/models → { data: [{id, ...}] } — return array of ids, [] on error
  listModels() {
    return new Promise(resolve => {
      const parsedUrl = new URL(getBaseUrl());
      const req = http.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: `${parsedUrl.pathname.replace(/\/$/, '')}/models`,
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const ids = (parsed.data || []).map(m => m.id).filter(Boolean);
            resolve(ids);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(1000, () => { req.destroy(); resolve([]); });
    });
  },
};
