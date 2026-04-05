// anymodel Cloudflare Worker handler
// Shared logic for both CF Workers and local testing
// Uses fetch() API — no Node.js http/https modules

export const FREE_MODELS = [
  'openrouter/free',
  'qwen/qwen3-coder:free',
  'qwen/qwen3.6-plus:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'stepfun/step-3.5-flash:free',
  'minimax/minimax-m2.5:free',
];

export function checkAuth(headers, token) {
  if (!token) return true;
  const auth = headers.authorization || headers['x-api-key'] || '';
  // Exact token match (x-api-key or Bearer prefix)
  if (auth === `Bearer ${token}` || auth === token) return true;
  return false;
}

export function isFreeTierModel(modelId, freeOnly) {
  if (!freeOnly) return true;
  if (!modelId) return false;
  return modelId.endsWith(':free') || FREE_MODELS.includes(modelId);
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

export function buildOpenRouterRequest(path, apiKey, model) {
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
  delete body.output_config;
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

// Main request handler — works with fetch() API (CF Workers + Node 18+)
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const token = env.ANYMODEL_TOKEN || '';
  const apiKey = env.OPENROUTER_API_KEY || '';
  const freeOnly = env.FREE_ONLY === 'true'; // default false — set FREE_ONLY=true to restrict to free models
  const rpm = parseInt(env.RPM || '60', 10);
  const model = env.MODEL || '';

  // Health endpoint
  if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/health') {
    return new Response(JSON.stringify({
      status: 'ok',
      provider: 'openrouter',
      model: model || null,
      freeOnly,
      timestamp: new Date().toISOString(),
    }), { headers: { 'content-type': 'application/json' } });
  }

  // Passthrough non-message requests to api.anthropic.com (auth, bootstrap, feature flags)
  if (!url.pathname.startsWith('/v1/messages')) {
    const anthropicUrl = `https://api.anthropic.com${url.pathname}${url.search}`;
    const passthroughHeaders = new Headers(request.headers);
    passthroughHeaders.set('host', 'api.anthropic.com');
    passthroughHeaders.delete('cf-connecting-ip');
    passthroughHeaders.delete('cf-ray');
    passthroughHeaders.delete('cf-ipcountry');
    try {
      const upstream = await fetch(anthropicUrl, {
        method: request.method,
        headers: passthroughHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    } catch (e) {
      return new Response(JSON.stringify({
        error: { type: 'proxy_error', message: `Passthrough to Anthropic failed: ${e.message}` }
      }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  }

  // BYOK: Use the user's key from the request header, fall back to server key
  const headers = Object.fromEntries(request.headers.entries());
  const userKey = headers['x-api-key'] || headers['authorization']?.replace('Bearer ', '') || '';
  const effectiveKey = (userKey && userKey.startsWith('sk-or-')) ? userKey : apiKey;

  if (!effectiveKey) {
    return new Response(JSON.stringify({
      error: { type: 'auth_error', message: 'OpenRouter API key required. Set ANTHROPIC_API_KEY to your OpenRouter key (starts with sk-or-).' }
    }), { status: 401, headers: { 'content-type': 'application/json' } });
  }

  // Rate limit (using global state for Workers)
  const clientIp = headers['cf-connecting-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!handleRequest._rateState) handleRequest._rateState = {};
  if (!checkRateLimit(clientIp, rpm, handleRequest._rateState)) {
    return new Response(JSON.stringify({
      error: { type: 'rate_limit', message: `Rate limit: ${rpm} requests/minute exceeded` }
    }), { status: 429, headers: { 'content-type': 'application/json' } });
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({
      error: { type: 'invalid_request', message: 'Invalid JSON' }
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  // Model override
  if (model) body.model = model;

  // Free-only: auto-replace paid models with best free model
  const defaultFreeModel = env.DEFAULT_FREE_MODEL || FREE_MODELS[0];
  if (freeOnly && !isFreeTierModel(body.model, true)) {
    const originalModel = body.model;
    body.model = defaultFreeModel;
    // Add a header so client knows model was swapped
    console.log(`[FREE-ONLY] Swapped ${originalModel} → ${body.model}`);
  }

  // Sanitize
  sanitizeBody(body);
  const payload = JSON.stringify(body);

  // Forward to OpenRouter with retries (using user's key or server fallback)
  const orReq = buildOpenRouterRequest(url.pathname, effectiveKey);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(orReq.url, {
        method: 'POST',
        headers: { ...orReq.headers, 'content-length': new TextEncoder().encode(payload).length.toString() },
        body: payload,
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_RETRIES) {
          return new Response(await response.text(), {
            status: response.status,
            headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
          });
        }
        await new Promise(r => setTimeout(r, calcDelay(attempt)));
        continue;
      }

      // Stream response back
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*',
        },
      });

    } catch (e) {
      if (attempt === MAX_RETRIES) {
        return new Response(JSON.stringify({
          error: { type: 'proxy_error', message: e.message }
        }), { status: 502, headers: { 'content-type': 'application/json' } });
      }
      await new Promise(r => setTimeout(r, calcDelay(attempt)));
    }
  }
}
