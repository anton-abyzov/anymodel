// anymodel Cloudflare Worker handler
// Shared logic for both CF Workers and local testing
// Uses fetch() API — no Node.js http/https modules
import { applyFreeRequestPolicy, isExplicitFreeModel } from '../providers/request-policy.mjs';

export const DEFAULT_FREE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

export function checkAuth(headers, token) {
  if (!token) return true;
  // Either slot may hold the gateway token; the other may carry a BYOK key.
  return [headers.authorization, headers['x-api-key']].some(
    auth => auth === `Bearer ${token}` || auth === token,
  );
}

export function isFreeTierModel(modelId, freeOnly) {
  if (!freeOnly) return true;
  return isExplicitFreeModel(modelId);
}

// Rate limiter factory — returns a stateful checker
checkRateLimit.create = function(rpm) {
  const windows = {};
  return {
    check(ip) {
      const minute = Math.floor(Date.now() / 60000);
      const key = `${ip}:${minute}`;
      // Clean old entries
      for (const k of Object.keys(windows)) {
        if (!k.endsWith(`:${minute}`)) delete windows[k];
      }
      windows[key] = (windows[key] || 0) + 1;
      return windows[key] <= rpm;
    }
  };
};

export function checkRateLimit(ip, rpm, state) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${ip}:${minute}`;
  for (const k of Object.keys(state)) {
    if (!k.endsWith(`:${minute}`)) delete state[k];
  }
  state[key] = (state[key] || 0) + 1;
  return state[key] <= rpm;
}

export function buildOpenRouterRequest(path, apiKey) {
  return {
    url: `https://openrouter.ai/api${path}`,
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'http-referer': 'https://anymodel.dev',
      'x-title': 'anymodel',
    },
  };
}

// Strip Anthropic-specific fields (same logic as proxy.mjs but standalone for Workers)
export function sanitizeBody(body) {
  delete body.betas;
  delete body.metadata;
  delete body.speed;
  // OpenRouter's native Messages API accepts output_config.effort and thinking.
  // Preserve them; dropping effort silently changes the requested reasoning level.
  delete body.context_management;
  // Preserve body.thinking — reasoning models (DeepSeek R1) need it for chain-of-thought

  if (Array.isArray(body.system)) {
    body.system = body.system.map(block => {
      if (block && typeof block === 'object' && block.cache_control) {
        const { cache_control, ...rest } = block;
        return rest;
      }
      return block;
    });
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map(block => {
          if (block && typeof block === 'object' && block.cache_control) {
            const { cache_control, ...rest } = block;
            return rest;
          }
          return block;
        });
      }
    }
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
      const { cache_control, defer_loading, eager_input_streaming, strict, ...rest } = tool;
      return rest;
    });
  }

  if (typeof body.tool_choice === 'string') {
    body.tool_choice = { type: body.tool_choice };
  }

  return body;
}

const MAX_RETRIES = 3;

function calcDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
};
const MESSAGE_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const DEFAULT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { ...CORS_HEADERS, 'content-type': 'application/json', ...headers },
  });
}
function errorResponse(status, type, message, headers) {
  return jsonResponse(status, { type: 'error', error: { type, message } }, headers);
}
export function bodyLimit(env = {}) {
  const value = Number(env.ANYMODEL_MAX_BODY_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_BODY_BYTES) : DEFAULT_BODY_BYTES;
}

// Limit bytes before decoding/parsing JSON. The Worker memory limit makes an
// unbounded request.json() unsafe even when the gateway token is configured.
export async function readRequestBody(request, limit) {
  const tooLarge = () => Object.assign(new Error('Request body exceeds limit'), { code: 'BODY_TOO_LARGE' });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    if (request.body) await request.body.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

function callerOpenRouterKey(headers, token) {
  for (const raw of [headers['x-api-key'], headers.authorization]) {
    const key = (raw || '').replace(/^Bearer\s+/i, '');
    if (key !== token && key.startsWith('sk-or-')) return key;
  }
  return '';
}

// Policy: public BYOK never uses a server key. A configured gateway token gates
// every non-public route, including BYOK. Server funding additionally requires
// that configured token, so forgetting ANYMODEL_TOKEN cannot expose server spend.
// context.clientIp is supplied by the local HTTP adapter from its socket, never
// a request header. On Cloudflare, cf-connecting-ip is populated by the edge.
export async function handleRequest(request, env = {}, context = {}) {
  const url = new URL(request.url);
  const token = env.ANYMODEL_TOKEN || '';
  const apiKey = env.OPENROUTER_API_KEY || '';
  const freeOnly = env.FREE_ONLY !== 'false';
  const configuredRpm = Number(env.RPM);
  const rpm = Number.isSafeInteger(configuredRpm) && configuredRpm > 0 ? configuredRpm : 60;
  const model = env.MODEL || '';

  // These public endpoints do not read a body, expose keys, or contact upstream.
  if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/health') {
    return jsonResponse(200, {
      status: 'ok', provider: 'openrouter', model: model || null, freeOnly,
      fundingPolicy: token ? 'authenticated' : 'byok-only',
      timestamp: new Date().toISOString(),
    });
  }
  if (request.method === 'OPTIONS' && MESSAGE_PATHS.has(url.pathname)) {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'access-control-max-age': '86400' } });
  }

  const headers = Object.fromEntries(request.headers.entries());
  if (!checkAuth(headers, token)) {
    return errorResponse(401, 'authentication_error', 'Invalid or missing AnyModel gateway token.');
  }

  // X-Forwarded-For is caller-controlled unless a trusted ingress validates it.
  const clientIp = context.clientIp || headers['cf-connecting-ip'] || 'unknown';
  if (!handleRequest._rateState) handleRequest._rateState = {};
  if (!checkRateLimit(clientIp, rpm, handleRequest._rateState)) {
    return errorResponse(429, 'rate_limit_error', `Rate limit: ${rpm} requests/minute exceeded`);
  }
  if (!MESSAGE_PATHS.has(url.pathname)) {
    return errorResponse(404, 'not_found_error', 'Unsupported route. This worker supports POST /v1/messages and /v1/messages/count_tokens.');
  }
  if (request.method !== 'POST') {
    return errorResponse(405, 'invalid_request_error', 'This route requires POST.', { allow: 'POST' });
  }

  const callerKey = callerOpenRouterKey(headers, token);
  const effectiveKey = callerKey || (token ? apiKey : '');
  if (!effectiveKey) {
    return errorResponse(401, 'authentication_error', 'An OpenRouter API key is required. Send your key in x-api-key (or Authorization when no gateway token is configured). Server funding requires ANYMODEL_TOKEN.');
  }

  let body;
  const limit = bodyLimit(env);
  try {
    body = JSON.parse(await readRequestBody(request, limit));
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') return errorResponse(413, 'invalid_request_error', `Request body exceeds ${limit} bytes.`);
    return errorResponse(400, 'invalid_request_error', 'Invalid JSON request body.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Array.isArray(body.messages) || (!model && (typeof body.model !== 'string' || !body.model.trim()))) {
    return errorResponse(400, 'invalid_request_error', 'Request body must be an object with a model string and messages array.');
  }
  if (model) body.model = model;
  if (freeOnly && !isFreeTierModel(body.model, true)) {
    return errorResponse(403, 'permission_error', 'Free-only policy requires an explicit :free model or openrouter/free. No replacement model was selected.');
  }
  const policyError = applyFreeRequestPolicy(body, { freeOnly });
  if (policyError) return errorResponse(403, 'permission_error', policyError);

  sanitizeBody(body);
  const payload = JSON.stringify(body);
  const orReq = buildOpenRouterRequest(url.pathname + url.search, effectiveKey);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(orReq.url, {
        method: 'POST', headers: orReq.headers, body: payload, redirect: 'error',
      });
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        // Release failed upstream bodies without buffering an unbounded error page.
        if (response.body) await response.body.cancel().catch(() => {});
        await new Promise(r => setTimeout(r, calcDelay(attempt)));
        continue;
      }
      return new Response(response.body, {
        status: response.status,
        headers: { ...CORS_HEADERS, 'content-type': response.headers.get('content-type') || 'application/json' },
      });
    } catch {
      if (attempt === MAX_RETRIES) return errorResponse(502, 'api_error', 'OpenRouter request failed.');
      await new Promise(r => setTimeout(r, calcDelay(attempt)));
    }
  }
}
