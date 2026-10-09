import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxy } from '../proxy.mjs';
import openrouter from '../providers/openrouter.mjs';
import { applyFreeRequestPolicy } from '../providers/request-policy.mjs';

const base = { model: 'fixture/model:free', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 32 };
const prohibited = [
  { fallbacks: [{ model: 'openai/gpt-6.1-sol' }] },
  { models: ['openai/gpt-6.1-sol'] },
  { models: ['fixture/other:free'] },
  { preset: '@preset/paid-tools' },
  { plugins: [{ id: 'web' }] },
  { plugins: [{ id: 'future-paid-plugin' }] },
  { tools: [{ type: 'openrouter:subagent', parameters: { model: 'openai/gpt-6.1-sol' } }] },
  { tools: [{ type: 'web_search' }] },
  { tools: [{ type: 'future_server_tool' }] },
  { tool_choice: { type: 'web_search' } },
  { route: 'fallback' },
  { model: 'fixture/model:online:free' },
  { model: 'fixture/model@preset/paid:free' },
  { model: '@preset/paid:free' },
  { provider: { allow_fallbacks: true } },
  { provider: { max_price: { prompt: 1 } } },
  { provider: { future_routing: 'paid' } },
  { future_routing: { model: 'paid' } },
  { service_tier: 'priority' },
  { modalities: ['text', 'image'] },
  { previous_response_id: 'response-with-paid-tools' },
  { messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'fixture.pdf', file_data: 'fixture' } }] }] },
];

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

async function fixture(freeOnly, run, options = {}) {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-only';
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json'); res.end('{"id":"fixture","content":[]}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const point = result => ({ ...result, protocol: 'http:', hostname: '127.0.0.1', port: upstream.address().port });
  const provider = { ...openrouter, buildRequest: (...args) => point(openrouter.buildRequest(...args)), buildWireRequest: (...args) => point(openrouter.buildWireRequest(...args)) };
  const proxy = createProxy(provider, { port: 0, host: '127.0.0.1', freeOnly, rpm: 1000, ...options });
  if (!proxy.listening) await once(proxy, 'listening');
  try { await run(proxy.address().port, calls); }
  finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved;
  }
}

for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/v1/responses']) {
  it(`${path}: free primary model never authorizes billable routing or server tools`, async () => {
    await fixture(true, async (port, calls) => {
      for (const patch of prohibited) {
        const result = await request(port, path, { ...base, ...patch });
        assert.equal(result.status, 403, JSON.stringify(patch));
        assert.equal(result.body.error.type, 'permission_error');
        assert.equal(calls.length, 0, JSON.stringify(patch));
      }
    });
  });
  it(`${path}: caller tools and dictionaries survive under the zero-price ceiling`, async () => {
    await fixture(true, async (port, calls) => {
      const dictionary = { type: 'object', properties: { model: { type: 'string' } }, additionalProperties: { type: 'string' } };
      const tool = path.includes('messages') ? { name: 'read_config', input_schema: dictionary } :
        { type: 'function', function: { name: 'read_config', parameters: dictionary } };
      const payload = { ...base, tools: [tool], usage: { include: true }, reasoningEffort: 'high', provider: { only: ['fixture'], max_price: { prompt: 0 } } };
      assert.equal((await request(port, path, payload)).status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, base.model);
      assert.deepEqual(calls[0].tools[0], tool);
      assert.deepEqual(calls[0].usage, payload.usage);
      assert.equal(calls[0].reasoningEffort, 'high');
      assert.deepEqual(calls[0].provider, { only: ['fixture'], allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    });
  });
  it(`${path}: paid mode retains explicit provider features unchanged`, async () => {
    await fixture(false, async (port, calls) => {
      const extensions = { models: ['paid'], fallbacks: [{ model: 'paid' }], preset: '@preset/paid', plugins: [{ id: 'web' }],
        tools: [{ type: 'openrouter:subagent', parameters: { model: 'paid' } }], provider: { allow_fallbacks: true, max_price: { prompt: 100 } } };
      assert.equal((await request(port, path, { ...base, ...extensions })).status, 200);
      for (const [key, value] of Object.entries(extensions)) assert.deepEqual(calls[0][key], value);
    });
  });
}

it('configured free primary still rejects request-provided routing overrides', async () => {
  await fixture(true, async (port, calls) => {
    assert.equal((await request(port, '/v1/messages', { ...base, model: 'paid', models: ['paid'] })).status, 403);
    assert.equal(calls.length, 0);
  }, { model: base.model });
});

it('free policy rejects malformed or unsupported costs and never mutates rejected input', () => {
  for (const patch of [{ provider: [] }, { provider: { max_price: { completion: '0' } } }, { provider: { max_price: { audio: 0 } } },
    { provider: { allow_fallbacks: null } }, { tools: [{}] }, { functions: [{}] }, { tool_choice: [] },
    { input: [{ type: 'input_file', file_id: 'fixture' }] }, { model: 3 }, { modalities: 'text' },
    { usage: { include: true, future_service: 'paid' } }, { usage: null }, { usage: { include: 'yes' } }, { reasoningEffort: { model: 'paid' } }]) {
    const body = { ...base, ...patch }; const original = structuredClone(body);
    assert.match(applyFreeRequestPolicy(body, { freeOnly: true }), /Free-only policy/);
    assert.deepEqual(body, original);
  }
  assert.match(applyFreeRequestPolicy({ ...base }, { freeOnly: true, provider: 'openai' }), /requires the OpenRouter provider/);
  const freeRouter = { ...base, model: 'openrouter/free' };
  assert.equal(applyFreeRequestPolicy(freeRouter, { freeOnly: true }), null);
});
