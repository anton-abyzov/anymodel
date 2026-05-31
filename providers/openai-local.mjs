// Factory for "local OpenAI-compatible" providers (LMStudio, llama-server, any
// localhost OpenAI-compat endpoint). Merges the near-duplicate `lmstudio.mjs`
// and `llamacpp.mjs` modules into a single configurable factory (US-001, 1.12.0).
//
// Differences captured in the config parameter:
//   - name:         "lmstudio" | "llamacpp" | custom
//   - defaultPort:  1234 for LMStudio, 8080 for llama-server
//   - envVar:       "LMSTUDIO_BASE_URL" | "LLAMACPP_BASE_URL" | custom
//   - bearerStub:   placeholder bearer token — server ignores but requires present
//   - v0Probe:      true to also probe /api/v0/models for loaded-state info (LMStudio-only)

import http from 'http';
import https from 'https';
import { translateRequest, translateResponse, createStreamTranslator } from './openai.mjs';

export function makeOpenAILocalProvider({
  name,
  defaultPort,
  envVar,
  bearerStub,
  v0Probe = false,
} = {}) {
  if (!name || !defaultPort || !envVar || !bearerStub) {
    throw new Error(`makeOpenAILocalProvider: missing required option (name=${name}, defaultPort=${defaultPort}, envVar=${envVar}, bearerStub=${bearerStub})`);
  }

  // Use 127.0.0.1 — Node's http.get resolves "localhost" to ::1 (IPv6) which
  // LMStudio/llama-server do not listen on by default, causing ECONNREFUSED.
  const DEFAULT_BASE_URL = `http://127.0.0.1:${defaultPort}/v1`;

  const getBaseUrl = () => process.env[envVar] || DEFAULT_BASE_URL;

  return {
    name,

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
          'authorization': `Bearer ${bearerStub}`,
          'content-length': Buffer.byteLength(payload),
        },
      };
    },

    transformRequest: translateRequest,
    // P0.2: mark responses as coming from a LOCAL provider so text-channel
    // tool-call recovery engages under ANYMODEL_PARSE_TEXT_TOOLCALLS=auto.
    transformResponse: (body) => translateResponse(body, { localProvider: true }),
    createStreamTranslator,

    displayInfo(model) {
      const base = getBaseUrl();
      return model ? `(${model} @ ${base})` : `(${base})`;
    },

    // Probe GET /v1/models — any HTTP response means the server is up.
    detect() {
      return new Promise(resolve => {
        const parsedUrl = new URL(getBaseUrl());
        const transport = parsedUrl.protocol === 'https:' ? https : http;
        const req = transport.get({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: `${parsedUrl.pathname.replace(/\/$/, '')}/models`,
        }, res => { res.resume(); resolve(true); });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      });
    },

    // Returns [{ id, loaded, capabilities }]. For LMStudio (v0Probe=true) we
    // first try /api/v0/models which reports `loaded` state; fall back to the
    // OpenAI-compatible /v1/models which doesn't surface loaded state.
    listModels() {
      const parsedUrl = new URL(getBaseUrl());
      const hostname = parsedUrl.hostname;
      const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const getJson = (path, shapeMapper) => new Promise(resolve => {
        const req = transport.get({ hostname, port, path }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try { resolve(shapeMapper(JSON.parse(body))); }
            catch { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(1000, () => { req.destroy(); resolve(null); });
      });

      const v0Mapper = parsed => (parsed.data || [])
        .filter(m => m.type !== 'embeddings' && !/embed/i.test(m.id || ''))
        .map(m => ({ id: m.id, loaded: m.state === 'loaded', capabilities: m.capabilities || [] }));

      const v1Mapper = parsed => (parsed.data || [])
        .filter(m => !/embed/i.test(m.id || ''))
        .map(m => ({ id: m.id, loaded: undefined, capabilities: [] }));

      const v1Path = `${parsedUrl.pathname.replace(/\/$/, '')}/models`;

      if (v0Probe) {
        return getJson('/api/v0/models', v0Mapper).then(v0 => (v0 && v0.length)
          ? v0
          : getJson(v1Path, v1Mapper).then(r => r || []));
      }
      return getJson(v1Path, v1Mapper).then(r => r || []);
    },
  };
}
