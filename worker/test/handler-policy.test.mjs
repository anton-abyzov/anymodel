import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.mjs';
import { handleRequest } from '../handler.mjs';

const token = 'fixture-gateway-token';
const serverKey = 'sk-or-fixture-server';
const callerKey = 'sk-or-fixture-caller';
const baseEnv = { ANYMODEL_TOKEN: token, OPENROUTER_API_KEY: serverKey, FREE_ONLY: 'true' };
const body = { model: 'fixture/model:free', max_tokens: 32, messages: [{ role: 'user', content: 'Synthetic fixture.' }] };
function request({ path = '/v1/messages', method = 'POST', headers = {}, payload = body } = {}) {
  return new Request(`https://worker.invalid${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
}
function stubUpstream(t) {
  return t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ type: 'message', content: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

describe('Worker real-handler funding policies', () => {
  beforeEach(() => { handleRequest._rateState = {}; });
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-api-key': callerKey }]) {
    it(`rejects missing/wrong gateway token without using any provider key: ${JSON.stringify(headers)}`, async t => {
      const upstream = stubUpstream(t);
      const response = await handleRequest(request({ headers }), baseEnv);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, 'authentication_error');
      assert.equal(upstream.mock.callCount(), 0);
    });
  }
  for (const headers of [{ authorization: `Bearer ${token}` }, { 'x-api-key': token }]) {
    it(`uses the server key only after gateway authentication: ${Object.keys(headers)[0]}`, async t => {
      const upstream = stubUpstream(t);
      const response = await handleRequest(request({ headers }), baseEnv);
      assert.equal(response.status, 200);
      assert.equal(upstream.mock.calls[0].arguments[1].headers.authorization, `Bearer ${serverKey}`);
    });
  }
  it('allows caller-funded BYOK without any configured gateway token or server key', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await handleRequest(request({ headers: { authorization: `Bearer ${callerKey}` } }), {})).status, 200);
    assert.equal(upstream.mock.calls[0].arguments[1].headers.authorization, `Bearer ${callerKey}`);
  });
  it('never falls back to an unprotected configured server key', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await handleRequest(request(), { OPENROUTER_API_KEY: serverKey })).status, 401);
    assert.equal(upstream.mock.callCount(), 0);
    assert.equal((await handleRequest(request({ headers: { 'x-api-key': callerKey } }), { OPENROUTER_API_KEY: serverKey })).status, 200);
    assert.equal(upstream.mock.calls[0].arguments[1].headers.authorization, `Bearer ${callerKey}`);
  });
  for (const headers of [
    { authorization: `Bearer ${token}`, 'x-api-key': callerKey },
    { authorization: `Bearer ${callerKey}`, 'x-api-key': token },
  ]) {
    it(`separates gateway token and caller key in both header arrangements: ${headers.authorization}`, async t => {
      const upstream = stubUpstream(t);
      assert.equal((await handleRequest(request({ headers }), baseEnv)).status, 200);
      assert.equal(upstream.mock.calls[0].arguments[1].headers.authorization, `Bearer ${callerKey}`);
    });
  }
  it('requires a caller key when gateway auth succeeds but no server key exists', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await handleRequest(request({ headers: { authorization: token } }), { ANYMODEL_TOKEN: token })).status, 401);
    assert.equal(upstream.mock.callCount(), 0);
  });
});

describe('Worker route, resource and model policies', () => {
  beforeEach(() => { handleRequest._rateState = {}; });
  for (const path of ['/v1/messages-evil', '/v1/messages/unknown', '/v1/responses', '/v1/chat/completions', '/api/auth', '/unrecognized']) {
    it(`rejects ${path} instead of forwarding to Anthropic`, async t => {
      const upstream = stubUpstream(t);
      assert.equal((await handleRequest(request({ path }), baseEnv)).status, 401);
      assert.equal((await handleRequest(request({ path, headers: { authorization: token } }), baseEnv)).status, 404);
      assert.equal(upstream.mock.callCount(), 0);
    });
  }
  it('allows unauthenticated health and supported CORS preflight without upstream traffic', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await worker.fetch(request({ path: '/health', method: 'GET' }), baseEnv)).status, 200);
    assert.equal((await worker.fetch(request({ method: 'OPTIONS', payload: '' }), baseEnv)).status, 204);
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('returns 405 for unsupported methods on a known route', async t => {
    const upstream = stubUpstream(t);
    const response = await handleRequest(request({ method: 'GET', headers: { authorization: token } }), baseEnv);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('forwards only the exact count_tokens route and retains query parameters', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await handleRequest(request({ path: '/v1/messages/count_tokens?beta=true', headers: { authorization: token } }), baseEnv)).status, 200);
    assert.equal(upstream.mock.calls[0].arguments[0], 'https://openrouter.ai/api/v1/messages/count_tokens?beta=true');
  });
  it('rejects a declared body larger than the configured cap', async t => {
    const upstream = stubUpstream(t);
    const response = await handleRequest(request({ headers: { authorization: token, 'content-length': '9999' } }), { ...baseEnv, ANYMODEL_MAX_BODY_BYTES: '256' });
    assert.equal(response.status, 413);
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('enforces the streamed byte count without Content-Length', async t => {
    const upstream = stubUpstream(t);
    const response = await handleRequest(request({ headers: { authorization: token }, payload: 'x'.repeat(257) }), { ...baseEnv, ANYMODEL_MAX_BODY_BYTES: '256' });
    assert.equal(response.status, 413);
    assert.equal(upstream.mock.callCount(), 0);
  });
  for (const payload of ['{broken', 'null', '[]', '{}', '{"model":13,"messages":[]}']) {
    it(`rejects invalid request ${payload}`, async t => {
      const upstream = stubUpstream(t);
      assert.equal((await handleRequest(request({ headers: { authorization: token }, payload }), baseEnv)).status, 400);
      assert.equal(upstream.mock.callCount(), 0);
    });
  }
  it('does not let X-Forwarded-For reset a Cloudflare client rate limit', async t => {
    const upstream = stubUpstream(t);
    const env = { ...baseEnv, RPM: '1' };
    assert.equal((await handleRequest(request({ headers: { authorization: token, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': 'fixture-a' } }), env)).status, 200);
    assert.equal((await handleRequest(request({ headers: { authorization: token, 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': 'fixture-b' } }), env)).status, 429);
    assert.equal(upstream.mock.callCount(), 1);
  });
  it('ignores X-Forwarded-For even when no Cloudflare client header is supplied', async t => {
    const upstream = stubUpstream(t);
    const env = { ...baseEnv, RPM: '1' };
    assert.equal((await handleRequest(request({ headers: { authorization: token, 'x-forwarded-for': 'fixture-a' } }), env)).status, 200);
    assert.equal((await handleRequest(request({ headers: { authorization: token, 'x-forwarded-for': 'fixture-b' } }), env)).status, 429);
    assert.equal(upstream.mock.callCount(), 1);
  });
  it('rejects paid models under free-only policy without silently replacing them', async t => {
    const upstream = stubUpstream(t);
    assert.equal((await handleRequest(request({ headers: { authorization: token }, payload: { ...body, model: 'fixture/paid' } }), baseEnv)).status, 403);
    assert.equal(upstream.mock.callCount(), 0);
  });
  it('requires explicit FREE_ONLY=false to allow paid model requests', async t => {
    const upstream = stubUpstream(t);
    const req = () => request({ headers: { 'x-api-key': callerKey }, payload: { ...body, model: 'fixture/paid' } });
    assert.equal((await handleRequest(req(), {})).status, 403);
    assert.equal((await handleRequest(req(), { FREE_ONLY: 'false' })).status, 200);
    assert.equal(JSON.parse(upstream.mock.calls[0].arguments[1].body).model, 'fixture/paid');
  });
  it('preserves native Messages reasoning effort and dictionary tool schemas', async t => {
    const upstream = stubUpstream(t);
    const schema = { type: 'object', properties: { headers: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } } };
    const payload = { ...body, output_config: { effort: 'high' }, thinking: { type: 'adaptive' }, tools: [{ name: 'fixture', input_schema: schema }] };
    assert.equal((await handleRequest(request({ headers: { authorization: token }, payload }), baseEnv)).status, 200);
    const forwarded = JSON.parse(upstream.mock.calls[0].arguments[1].body);
    assert.deepEqual(forwarded.output_config, payload.output_config);
    assert.deepEqual(forwarded.thinking, payload.thinking);
    assert.deepEqual(forwarded.tools[0].input_schema, schema);
    assert.deepEqual(forwarded.provider, { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
  });
});

describe('Worker free-only whole-request policy', () => {
  beforeEach(() => { handleRequest._rateState = {}; });
  const prohibited = [
    { fallbacks: [{ model: 'openai/gpt-6.1-sol' }] }, { models: ['openai/gpt-6.1-sol'] },
    { preset: '@preset/paid-tools' }, { plugins: [{ id: 'web' }] },
    { tools: [{ type: 'openrouter:subagent', parameters: { model: 'paid' } }] },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { model: 'fixture/model:online:free' }, { model: '@preset/paid:free' },
    { provider: { allow_fallbacks: true } }, { provider: { max_price: { request: 1 } } },
    { provider: { unknown: 'routing' } }, { route: 'fallback' }, { future_option: 'paid' },
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://fixture.invalid/file.pdf' } }] }] },
  ];
  for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
    it(`${path}: rejects alternate spend before any server-funded or BYOK fetch`, async t => {
      const upstream = stubUpstream(t);
      for (const env of [baseEnv, {}]) {
        for (const patch of prohibited) {
          const response = await handleRequest(request({ path, headers: { authorization: token, 'x-api-key': callerKey }, payload: { ...body, ...patch } }), env);
          assert.equal(response.status, 403, JSON.stringify(patch));
          assert.equal((await response.json()).error.type, 'permission_error');
          assert.equal(upstream.mock.callCount(), 0);
        }
      }
    });
  }
  it('preserves paid routing options when the operator explicitly disables free-only', async t => {
    const upstream = stubUpstream(t);
    const options = { fallbacks: [{ model: 'paid' }], models: ['paid'], preset: '@preset/paid', plugins: [{ id: 'web' }], tools: [{ type: 'openrouter:subagent', parameters: { model: 'paid' } }], provider: { allow_fallbacks: true } };
    const response = await handleRequest(request({ headers: { authorization: token }, payload: { ...body, ...options } }), { ...baseEnv, FREE_ONLY: 'false' });
    assert.equal(response.status, 200);
    const forwarded = JSON.parse(upstream.mock.calls[0].arguments[1].body);
    for (const [key, value] of Object.entries(options)) assert.deepEqual(forwarded[key], value);
  });
});
