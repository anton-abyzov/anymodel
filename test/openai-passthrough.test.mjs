// 1.14.0 — OpenAI-wire passthrough for LOCAL providers (Codex CLI support).
//
// Covers the new route added in proxy.mjs:
//   - POST /v1/chat/completions  (non-streaming + streaming, OpenAI-in/OpenAI-out)
//   - GET  /v1/models            (local model list mapped to OpenAI shape)
//   - tool-call text-channel recovery (Qwen/Hermes XML → structured tool_calls)
//   - non-function tool filtering (the LM Studio "type invalid_string" blocker)
//   - OpenAI error envelope on failures (Codex parses {error:{...}}, not Anthropic)
//   - regression guard: cloud providers + /v1/messages do NOT enter the new branch
//
// Strategy: stand up a fake "local OpenAI backend" HTTP server and a provider named
// "lmstudio" whose buildRequest targets it. The proxy's sendRequest() then forwards
// to our fake backend exactly as it would to a real LM Studio.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createProxy,
  isOpenAIRoute,
  isProviderRoute,
  openaiError,
  filterOpenAITools,
} from '../proxy.mjs';
import { recoverOpenAIToolCalls } from '../providers/openai.mjs';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve(server.address().port);
    server.on('listening', () => resolve(server.address().port));
  });
}

function post(port, path, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function mockRes() {
  return {
    statusCode: null, headers: null, body: '', writableEnded: false, headersSent: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h; this.headersSent = true; },
    write(c) { this.body += c; return true; },
    end(c) { if (c) this.body += c; this.writableEnded = true; },
  };
}

// ── Fake local OpenAI backend ───────────────────────────────────────────────
// `behavior` is swapped per-test to control the upstream response.

let backend, backendPort;
let behavior = () => {};

before(async () => {
  backend = http.createServer((req, res) => behavior(req, res));
  backend.listen(0, '127.0.0.1');
  backendPort = await listen(backend);
});
after(() => backend.close());

// Provider that looks like lmstudio (local) but points buildRequest at the fake backend.
function makeLocalProvider(name = 'lmstudio') {
  return {
    name,
    buildRequest(url, payload) {
      return {
        hostname: '127.0.0.1', port: backendPort, protocol: 'http:',
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      };
    },
    listModels: async () => ([
      { id: 'qwen/qwen3-coder-30b', loaded: true, capabilities: ['tool_use'] },
      { id: 'gemma-4', loaded: false, capabilities: [] },
    ]),
    displayInfo: () => 'local',
  };
}

// ── Pure helper unit tests ─────────────────────────────────────────────────

describe('isOpenAIRoute', () => {
  it('matches /v1/chat/completions and /v1/models (with query/trailing slash)', () => {
    assert.equal(isOpenAIRoute('/v1/chat/completions'), true);
    assert.equal(isOpenAIRoute('/v1/chat/completions?x=1'), true);
    assert.equal(isOpenAIRoute('/v1/models/'), true);
    assert.equal(isOpenAIRoute('/v1/models'), true);
  });
  it('matches /v1/responses (Responses wire)', () => {
    assert.equal(isOpenAIRoute('/v1/responses'), true);
  });
  it('does NOT match /v1/messages or unrelated paths', () => {
    assert.equal(isOpenAIRoute('/v1/messages'), false);
    assert.equal(isOpenAIRoute('/v1/messages/count_tokens'), false);
    assert.equal(isOpenAIRoute('/health'), false);
  });
  it('never overlaps with isProviderRoute (the Anthropic matcher)', () => {
    for (const u of ['/v1/chat/completions', '/v1/models']) {
      assert.equal(isProviderRoute(u), false, `${u} must not be an Anthropic provider route`);
    }
  });
});

describe('openaiError', () => {
  it('emits the OpenAI envelope {error:{message,type,code}} (NOT Anthropic shape)', () => {
    const res = mockRes();
    openaiError(res, 401, 'bad token', 'authentication_error');
    assert.equal(res.statusCode, 401);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.type, undefined, 'must not carry Anthropic top-level type');
    assert.deepEqual(parsed.error, { message: 'bad token', type: 'authentication_error', code: null });
  });
  it('is a no-op once the response is ended', () => {
    const res = mockRes(); res.writableEnded = true;
    assert.doesNotThrow(() => openaiError(res, 500, 'late'));
    assert.equal(res.statusCode, null);
  });
});

describe('filterOpenAITools', () => {
  it('drops non-function tools and reports the count', () => {
    const tools = [
      { type: 'function', function: { name: 'shell' } },
      { type: 'web_search' },
      { type: 'image_generation' },
      { type: 'function', function: { name: 'apply_patch' } },
    ];
    const { tools: kept, dropped } = filterOpenAITools(tools);
    assert.equal(dropped, 2);
    assert.deepEqual(kept.map(t => t.function.name), ['shell', 'apply_patch']);
  });
  it('passes through non-arrays untouched', () => {
    assert.deepEqual(filterOpenAITools(undefined), { tools: undefined, dropped: 0 });
  });
});

describe('recoverOpenAIToolCalls', () => {
  it('converts Qwen XML in the text channel to structured tool_calls', () => {
    const resp = {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Sure.<function=write_file><parameter=path>ok.txt</parameter><parameter=content>HI</parameter></function>' },
      }],
    };
    recoverOpenAIToolCalls(resp, { localProvider: true });
    const m = resp.choices[0].message;
    assert.equal(resp.choices[0].finish_reason, 'tool_calls');
    assert.equal(m.tool_calls.length, 1);
    assert.equal(m.tool_calls[0].type, 'function');
    assert.equal(m.tool_calls[0].function.name, 'write_file');
    const args = JSON.parse(m.tool_calls[0].function.arguments);
    assert.equal(args.path, 'ok.txt');
    assert.equal(args.content, 'HI');
    assert.equal(m.content, 'Sure.', 'residual prose preserved');
  });
  it('nulls content when the whole message was the tool call', () => {
    const resp = { choices: [{ finish_reason: 'stop', message: { content: '<function=ls><parameter=dir>.</parameter></function>' } }] };
    recoverOpenAIToolCalls(resp, { localProvider: true });
    assert.equal(resp.choices[0].message.content, null);
  });
  it('is a no-op when structured tool_calls already exist', () => {
    const resp = { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] } }] };
    const before = JSON.stringify(resp);
    recoverOpenAIToolCalls(resp, { localProvider: true });
    assert.equal(JSON.stringify(resp), before);
  });
  it('is a no-op for plain prose with no tool syntax', () => {
    const resp = { choices: [{ finish_reason: 'stop', message: { content: 'just text' } }] };
    recoverOpenAIToolCalls(resp, { localProvider: true });
    assert.equal(resp.choices[0].message.tool_calls, undefined);
    assert.equal(resp.choices[0].finish_reason, 'stop');
  });
});

// ── Live proxy integration ──────────────────────────────────────────────────

describe('local OpenAI passthrough — live proxy', () => {
  let proxy, port;
  before(async () => {
    proxy = createProxy(makeLocalProvider('lmstudio'), { port: 0, model: 'qwen/qwen3-coder-30b' });
    port = await listen(proxy);
  });
  after(() => proxy.close());
  beforeEach(() => { behavior = () => {}; });

  it('GET /v1/models serves the local list in OpenAI shape', async () => {
    const res = await get(port, '/v1/models');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map(m => m.id), ['qwen/qwen3-coder-30b', 'gemma-4']);
    for (const m of body.data) {
      assert.equal(m.object, 'model');
      assert.equal(m.owned_by, 'lmstudio');
      // internal {loaded,capabilities} must NOT leak through
      assert.equal('loaded' in m, false);
      assert.equal('capabilities' in m, false);
    }
  });

  it('POST /v1/chat/completions (non-streaming) returns the local completion verbatim-ish', async () => {
    behavior = (req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-1', object: 'chat.completion', model: 'qwen/qwen3-coder-30b',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }));
      });
    };
    const res = await post(port, '/v1/chat/completions', {
      model: 'qwen/qwen3-coder-30b', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8,
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'OK');
  });

  it('non-streaming: recovers Qwen XML from the text channel into tool_calls', async () => {
    behavior = (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-2', object: 'chat.completion', model: 'qwen/qwen3-coder-30b',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '<function=write_file><parameter=path>ok.txt</parameter><parameter=content>CODEX</parameter></function>' } }],
        }));
      });
    };
    const res = await post(port, '/v1/chat/completions', { model: 'qwen/qwen3-coder-30b', messages: [{ role: 'user', content: 'write ok.txt' }] });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write_file');
    assert.equal(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).path, 'ok.txt');
  });

  it('streaming: passes OpenAI SSE through verbatim and synthesizes [DONE] when missing', async () => {
    behavior = (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"c","choices":[{"delta":{"content":"He"}}]}\n\n');
        res.write('data: {"id":"c","choices":[{"delta":{"content":"llo"}}]}\n\n');
        // NOTE: deliberately close WITHOUT a [DONE] sentinel (LM Studio/MLX behavior)
        res.end();
      });
    };
    const res = await post(port, '/v1/chat/completions', { model: 'qwen/qwen3-coder-30b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /"content":"He"/);
    assert.match(res.body, /"content":"llo"/);
    assert.match(res.body, /data: \[DONE\]/, 'proxy must synthesize a terminal [DONE]');
  });

  it('streaming: does NOT double-emit [DONE] when upstream already sent it', async () => {
    behavior = (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    };
    const res = await post(port, '/v1/chat/completions', { model: 'qwen/qwen3-coder-30b', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const count = (res.body.match(/\[DONE\]/g) || []).length;
    assert.equal(count, 1, 'exactly one [DONE]');
  });

  it('forwards a body the upstream actually receives with non-function tools removed', async () => {
    let received = null;
    behavior = (req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }));
      });
    };
    await post(port, '/v1/chat/completions', {
      model: 'qwen/qwen3-coder-30b',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: {} } } },
        { type: 'web_search' },
        { type: 'image_generation' },
      ],
    });
    assert.ok(received, 'backend received a request');
    assert.equal(received.tools.length, 1, 'only the function tool survives');
    assert.equal(received.tools[0].function.name, 'shell');
  });

  it('emits an OpenAI error envelope (not Anthropic) on an upstream 400', async () => {
    behavior = (req, res) => { req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad' } })); }); };
    const res = await post(port, '/v1/chat/completions', { model: 'qwen/qwen3-coder-30b', messages: [] });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.type, undefined, 'no Anthropic top-level type');
    assert.ok(body.error && typeof body.error.message === 'string');
  });

  it('rejects invalid JSON with an OpenAI invalid_request_error', async () => {
    const res = await post(port, '/v1/chat/completions', '{not json');
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error.type, 'invalid_request_error');
  });
});

// ── Regression guard: cloud providers / Anthropic path are NOT touched ──────

describe('regression: non-local providers do NOT enter the OpenAI branch', () => {
  // The dispatcher gate is `isLocalProvider && isOpenAIRoute(url)`, where
  // isLocalProvider === provider.name ∈ {ollama,lmstudio,llamacpp}. For a cloud
  // provider that conjunction is false, so /v1/chat/completions + /v1/models fall
  // through to the existing Anthropic passthrough — unchanged behavior. We assert
  // this offline (no live api.anthropic.com call) by replicating the exact guard.
  const LOCAL = new Set(['ollama', 'lmstudio', 'llamacpp']);
  const wouldServeLocally = (providerName, url) => LOCAL.has(providerName) && isOpenAIRoute(url);

  it('cloud providers (openai/openrouter) never serve /v1/chat/completions or /v1/models locally', () => {
    for (const cloud of ['openai', 'openrouter']) {
      assert.equal(wouldServeLocally(cloud, '/v1/chat/completions'), false);
      assert.equal(wouldServeLocally(cloud, '/v1/models'), false);
    }
  });
  it('local providers DO serve the OpenAI routes', () => {
    for (const local of ['ollama', 'lmstudio', 'llamacpp']) {
      assert.equal(wouldServeLocally(local, '/v1/chat/completions'), true);
      assert.equal(wouldServeLocally(local, '/v1/models'), true);
    }
  });
  it('the new branch never captures /v1/messages for ANY provider (Anthropic path intact)', () => {
    for (const p of ['lmstudio', 'ollama', 'llamacpp', 'openai', 'openrouter']) {
      assert.equal(wouldServeLocally(p, '/v1/messages'), false);
      assert.equal(isProviderRoute('/v1/messages'), true, 'Anthropic matcher still owns /v1/messages');
    }
  });
});
