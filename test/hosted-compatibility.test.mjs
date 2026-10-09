import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxy, sanitizeBody } from '../proxy.mjs';
import openai, { createStreamTranslator, translateResponse } from '../providers/openai.mjs';
import openrouter from '../providers/openrouter.mjs';

const keys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_BASE_URL', 'ANYMODEL_MAX_BODY_BYTES', 'ANYMODEL_FORWARD_EFFORT', 'ANYMODEL_STREAM_USAGE'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.OPENAI_API_KEY = 'fixture-openai';
  process.env.OPENROUTER_API_KEY = 'fixture-openrouter';
});
afterEach(() => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const message = extra => ({ model: 'gpt-6.1-sol', max_tokens: 123, messages: [{ role: 'user', content: 'fixture' }], ...extra });
const reply = { id: 'fixture', model: 'gpt-6.1-sol', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
function request(port, path, body, { method = 'POST', headers = {}, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(payload);
  });
}
async function fixture(base, options, run, respond = (_record, res) => res.end(JSON.stringify(reply))) {
  const captured = [];
  const upstream = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString();
      const record = { path: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      captured.push(record);
      res.setHeader('content-type', 'application/json');
      respond(record, res);
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const point = opts => ({ ...opts, hostname: '127.0.0.1', protocol: 'http:', port: upstream.address().port });
  const provider = { ...base, warmup: undefined, buildRequest: (...args) => point(base.buildRequest(...args)) };
  if (base.buildWireRequest) provider.buildWireRequest = (...args) => point(base.buildWireRequest(...args));
  const proxy = createProxy(provider, { port: 0, host: '127.0.0.1', ...options });
  if (!proxy.listening) await once(proxy, 'listening');
  try { await run(proxy.address().port, captured); }
  finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
  }
}

describe('hosted credentials and native endpoint routing', () => {
  for (const provider of [openai, openrouter]) {
    it(`${provider.name} selects only its own key on Messages and native wires`, async () => {
      await fixture(provider, {}, async (port, calls) => {
        for (const path of ['/v1/messages', '/v1/responses', '/v1/chat/completions']) {
          const body = path === '/v1/responses' ? { model: 'fixture', input: 'hello', reasoning: { effort: 'xhigh' }, tools: [{ type: 'web_search' }] } : message();
          assert.equal((await request(port, path, body)).status, 200);
          assert.equal(calls.at(-1).headers.authorization, `Bearer fixture-${provider.name}`);
          if (path !== '/v1/messages') assert.deepEqual(calls.at(-1).body, body);
          assert.equal(calls.at(-1).path, provider.name === 'openrouter' ? '/api' + path : path === '/v1/messages' ? '/v1/chat/completions' : path);
        }
        assert.equal((await request(port, '/v1/models', undefined, { method: 'GET' })).status, 200);
        assert.equal(calls.at(-1).method, 'GET');
        assert.equal(calls.at(-1).headers.authorization, `Bearer fixture-${provider.name}`);
      });
    });
  }
  it('does not borrow the other provider key when the chosen credential is absent', async () => {
    delete process.env.OPENAI_API_KEY;
    await fixture(openai, {}, async (port, calls) => {
      for (const path of ['/v1/messages', '/v1/responses']) {
        const result = await request(port, path, message());
        assert.equal(result.status, 401);
        assert.ok(result.body.includes('OPENAI_API_KEY'));
      }
      assert.equal(calls.length, 0);
    });
  });
  it('preserves native error status and never fabricates successful auth', async () => {
    await fixture(openrouter, {}, async port => {
      const result = await request(port, '/v1/responses', { model: 'fixture', input: 'hi' });
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(result.body).error.message, 'provider denied');
    }, (_, res) => { res.statusCode = 403; res.end('{"error":{"message":"provider denied"}}'); });
  });
  it('never substitutes a free model on insufficient credits', async () => {
    await fixture(openrouter, {}, async (port, calls) => {
      const result = await request(port, '/v1/messages', message());
      assert.equal(result.status, 402);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.model, 'gpt-6.1-sol');
    }, (_, res) => { res.statusCode = 402; res.end('{"error":{"message":"insufficient credits"}}'); });
  });
});

describe('request boundaries apply before every route', () => {
  it('requires token even on unsupported paths and former auth stubs', async () => {
    await fixture(openrouter, { token: 'fixture-token' }, async (port, calls) => {
      for (const path of ['/v1/messages', '/v1/responses', '/v1/chat/completions', '/unknown', '/api/auth/session']) {
        assert.equal((await request(port, path, {})).status, 401);
        assert.equal((await request(port, path, {}, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      }
      assert.equal(calls.length, 0);
      const result = await request(port, '/unknown', {}, { headers: { authorization: 'Bearer fixture-token' } });
      assert.equal(result.status, 404);
      assert.equal(calls.length, 0);
    });
  });
  it('ignores spoofed forwarding headers for rate limits on all routes', async () => {
    await fixture(openrouter, { rpm: 1 }, async (port, calls) => {
      assert.equal((await request(port, '/unknown', {}, { headers: { 'x-forwarded-for': 'first' } })).status, 404);
      assert.equal((await request(port, '/v1/responses', {}, { headers: { 'x-forwarded-for': 'second' } })).status, 429);
      assert.equal(calls.length, 0);
    });
  });
  it('bounds declared bodies on unknown paths and chunked bodies on cloud wires', async () => {
    process.env.ANYMODEL_MAX_BODY_BYTES = '64';
    await fixture(openrouter, {}, async (port, calls) => {
      assert.equal((await request(port, '/unknown', 'x'.repeat(100), { headers: { 'content-length': '100' } })).status, 413);
      const chunked = await request(port, '/v1/responses', null, { chunks: ['{"input":"', 'x'.repeat(100), '"}'] });
      assert.equal(chunked.status, 413);
      assert.equal(calls.length, 0);
    });
  });
  it('rejects unsupported cloud adapters and mismatched methods explicitly', async () => {
    const provider = { name: 'custom', displayInfo: () => 'fixture', buildRequest: () => { throw new Error('must not route'); } };
    const server = createProxy(provider, { port: 0 }); await once(server, 'listening');
    try {
      assert.equal((await request(server.address().port, '/v1/responses', {})).status, 501);
      assert.equal((await request(server.address().port, '/v1/models', {})).status, 405);
      assert.equal((await request(server.address().port, '/v1/messages/other', {})).status, 404);
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  });
});

describe('reasoning, budgets and tool schemas survive conversion', () => {
  it('preserves requested OpenRouter effort at the real HTTP boundary', async () => {
    await fixture(openrouter, {}, async (port, calls) => {
      for (const effort of ['high', 'xhigh', 'max']) {
        await request(port, '/v1/messages', message({ output_config: { effort }, thinking: { type: 'adaptive' } }));
        assert.deepEqual(calls.at(-1).body.output_config, { effort });
        assert.deepEqual(calls.at(-1).body.thinking, { type: 'adaptive' });
        assert.equal(calls.at(-1).body.__anymodel_effort, undefined);
      }
    });
  });
  it('forwards current native reasoning levels without lowering and uses modern budgets', () => {
    for (const model of ['o3', 'o4-mini', 'gpt-5.4', 'gpt-6.1-sol', 'gpt-10']) {
      for (const effort of ['none', 'minimal', 'high', 'xhigh', 'max']) {
        const input = message({ model, output_config: { effort }, stream: true });
        sanitizeBody(input);
        const output = openai.transformRequest(input);
        assert.equal(output.reasoning_effort, effort);
        assert.equal(output.max_completion_tokens, 123);
        assert.equal(output.max_tokens, undefined);
        assert.deepEqual(output.stream_options, { include_usage: true });
      }
    }
    assert.equal(openai.transformRequest(message({ model: 'gpt-4o' })).max_tokens, 123);
  });
  it('retains explicit dictionaries and pattern properties, including nested schemas', () => {
    for (const dict of [{ type: 'object' }, { type: 'object', properties: {} }, { type: 'object', additionalProperties: { type: 'string' } }, { type: 'object', properties: {}, additionalProperties: true }, { type: 'object', properties: {}, patternProperties: { '^x': { type: 'string' } } }]) {
      const original = structuredClone(dict);
      const body = message({ tools: [{ name: 'dictionary', input_schema: dict }, { name: 'nested', input_schema: { type: 'object', properties: { env: structuredClone(dict) } } }] });
      sanitizeBody(body, { keepCache: true, preserveNative: true });
      const output = openai.transformRequest(body);
      for (const schema of [output.tools[0].function.parameters, output.tools[1].function.parameters.properties.env]) {
        assert.deepEqual(schema.additionalProperties, original.additionalProperties);
        assert.deepEqual(schema.patternProperties, original.patternProperties);
      }
    }
  });
});

describe('streamed failures and usage remain truthful', () => {
  it('propagates a mid-stream failure without a normal completion event', async () => {
    await fixture(openai, {}, async port => {
      const result = await request(port, '/v1/messages', message({ stream: true }));
      assert.equal(result.status, 200);
      assert.ok(result.body.includes('event: error'));
      assert.ok(result.body.includes('provider disconnected'));
      assert.ok(!result.body.includes('event: message_stop'));
      assert.ok(!result.body.includes('"stop_reason":"end_turn"'));
    }, (_, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"id":"fixture","choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"provider disconnected"},"choices":[{"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]\n\n');
    });
  });
  it('forwards native Responses failure events without translation', async () => {
    const wire = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"fixture failure"}}}\n\n';
    await fixture(openrouter, {}, async port => {
      const result = await request(port, '/v1/responses', { model: 'fixture', input: 'hi', stream: true });
      assert.equal(result.body, wire);
    }, (_, res) => { res.setHeader('content-type', 'text/event-stream'); res.end(wire); });
  });
  it('reports missing usage as null and preserves measured zero', () => {
    const t = createStreamTranslator();
    const wire = t.transform('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    assert.ok(wire.includes('"input_tokens":null'));
    assert.ok(wire.includes('"output_tokens":null'));
    assert.equal(translateResponse({ ...reply, usage: undefined }).usage.output_tokens, null);
    assert.equal(translateResponse({ ...reply, usage: { prompt_tokens: 0, completion_tokens: 0 } }).usage.output_tokens, 0);
  });
  it('handles an error before the first text chunk and stops after error', () => {
    const t = createStreamTranslator();
    assert.ok(t.transform('data: {"error":{"message":"rejected"}}\n\n').includes('event: error'));
    assert.equal(t.transform('data: [DONE]\n\n'), '');
    assert.equal(t.flush(), '');
  });
});
