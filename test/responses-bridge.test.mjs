// 1.14.0 — OpenAI Responses-wire bridge for LOCAL providers (current Codex CLI).
//
// Codex dropped wire_api="chat", so it only POSTs /v1/responses (streaming SSE).
// This bridge translates Responses→ChatCompletions for the local server and emits a
// synthetic Responses SSE stream back. Tests cover:
//   - request translation (instructions→system, input messages, tool flattening,
//     non-function tool drop, function_call / function_call_output round-trip)
//   - output-item construction (message + function_call, XML tool-call recovery)
//   - SSE serialization (created → output_item.added/done → completed)
//   - LIVE: POST /v1/responses through a real proxy + fake local backend, asserting
//     ok.txt-style tool call survives end to end.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy, isResponsesRoute, isOpenAIRoute } from '../proxy.mjs';
import {
  responsesToChat,
  chatResponseToOutputItems,
  buildResponsesSSE,
  buildResponsesError,
} from '../providers/responses.mjs';

// ── translation unit tests ──────────────────────────────────────────────────

describe('responsesToChat', () => {
  it('maps instructions→system and input messages (developer→system)', () => {
    const { chat } = responsesToChat({
      model: 'qwen', instructions: 'be terse',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev note' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] },
      ],
    });
    assert.equal(chat.stream, false);
    assert.deepEqual(chat.messages[0], { role: 'system', content: 'be terse' });
    assert.deepEqual(chat.messages[1], { role: 'system', content: 'dev note' });
    assert.deepEqual(chat.messages[2], { role: 'user', content: 'Say hi' });
  });

  it('flattens Responses function tools to Chat shape and drops non-function tools', () => {
    const { chat, droppedTools } = responsesToChat({
      model: 'qwen', input: [],
      tools: [
        { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
        { type: 'web_search' },
        { type: 'image_generation' },
        { type: 'namespace', name: 'x' },
      ],
    });
    assert.equal(droppedTools, 3);
    assert.equal(chat.tools.length, 1);
    assert.deepEqual(chat.tools[0], {
      type: 'function',
      function: { name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    });
  });

  it('round-trips function_call and function_call_output items', () => {
    const { chat } = responsesToChat({
      model: 'qwen',
      input: [
        { type: 'message', role: 'user', content: 'do it' },
        { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"ok.txt"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'written' },
      ],
    });
    const asst = chat.messages.find(m => m.role === 'assistant');
    assert.equal(asst.tool_calls[0].id, 'c1');
    assert.equal(asst.tool_calls[0].function.name, 'write_file');
    const tool = chat.messages.find(m => m.role === 'tool');
    assert.deepEqual(tool, { role: 'tool', tool_call_id: 'c1', content: 'written' });
  });

  it('honors max_output_tokens → max_tokens', () => {
    const { chat } = responsesToChat({ model: 'qwen', input: [], max_output_tokens: 256 });
    assert.equal(chat.max_tokens, 256);
  });
});

describe('chatResponseToOutputItems', () => {
  it('emits a message item for plain assistant text', () => {
    const { items } = chatResponseToOutputItems({ choices: [{ message: { content: 'hello' } }] }, { localProvider: true });
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'message');
    assert.equal(items[0].content[0].text, 'hello');
    assert.equal(items[0].content[0].type, 'output_text');
  });

  it('emits function_call items for structured tool_calls', () => {
    const { items } = chatResponseToOutputItems({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] } }],
    }, { localProvider: true });
    const fc = items.find(i => i.type === 'function_call');
    assert.equal(fc.call_id, 'c1');
    assert.equal(fc.name, 'shell');
    assert.equal(JSON.parse(fc.arguments).cmd, 'ls');
  });

  it('recovers Qwen XML from the text channel into a function_call item', () => {
    const { items } = chatResponseToOutputItems({
      choices: [{ message: { content: 'sure <function=write_file><parameter=path>ok.txt</parameter></function>' } }],
    }, { localProvider: true });
    const fc = items.find(i => i.type === 'function_call');
    assert.ok(fc, 'a function_call was recovered');
    assert.equal(fc.name, 'write_file');
    assert.equal(JSON.parse(fc.arguments).path, 'ok.txt');
    // residual prose preserved as a message item
    const msg = items.find(i => i.type === 'message');
    assert.match(msg.content[0].text, /sure/);
  });
});

describe('buildResponsesSSE', () => {
  it('emits created → output_item.added/done per item → completed', () => {
    const items = [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi' }] }];
    const chunks = buildResponsesSSE({ responseId: 'r1', model: 'qwen', items, usage: { input_tokens: 1, output_tokens: 1 } });
    const all = chunks.join('');
    assert.match(all, /event: response\.created/);
    assert.match(all, /event: response\.output_item\.added/);
    assert.match(all, /event: response\.output_item\.done/);
    assert.match(all, /event: response\.completed/);
    // completed event carries the final response with output + status:completed
    const completed = chunks[chunks.length - 1];
    const data = JSON.parse(completed.split('data: ')[1]);
    assert.equal(data.response.status, 'completed');
    assert.equal(data.response.output[0].content[0].text, 'hi');
  });
});

describe('buildResponsesError', () => {
  it('emits a response.failed event with the message', () => {
    const s = buildResponsesError('boom');
    assert.match(s, /event: response\.failed/);
    assert.match(s, /boom/);
  });
});

describe('isResponsesRoute / isOpenAIRoute', () => {
  it('isResponsesRoute matches only /v1/responses', () => {
    assert.equal(isResponsesRoute('/v1/responses'), true);
    assert.equal(isResponsesRoute('/v1/responses?x=1'), true);
    assert.equal(isResponsesRoute('/v1/chat/completions'), false);
  });
  it('isOpenAIRoute now also covers /v1/responses', () => {
    assert.equal(isOpenAIRoute('/v1/responses'), true);
  });
});

// ── live proxy integration ──────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve(server.address().port);
    server.on('listening', () => resolve(server.address().port));
  });
}
function post(port, path, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /v1/responses — live proxy', () => {
  let backend, backendPort, lastChatBody;
  let chatBehavior;
  let proxy, port;

  before(async () => {
    backend = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        lastChatBody = JSON.parse(Buffer.concat(chunks).toString());
        chatBehavior(req, res);
      });
    });
    backend.listen(0, '127.0.0.1');
    backendPort = await listen(backend);

    const provider = {
      name: 'lmstudio',
      buildRequest(url, payload) {
        return { hostname: '127.0.0.1', port: backendPort, protocol: 'http:', path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } };
      },
      listModels: async () => [],
      displayInfo: () => 'local',
    };
    proxy = createProxy(provider, { port: 0, model: 'qwen/qwen3-coder-30b' });
    port = await listen(proxy);
  });
  after(() => { backend.close(); proxy.close(); });
  beforeEach(() => { chatBehavior = () => {}; lastChatBody = null; });

  it('translates Responses→chat, forwards non-streaming, returns a Responses SSE completion', async () => {
    chatBehavior = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cmpl-1', model: 'qwen/qwen3-coder-30b', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi there' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    };
    const res = await post(port, '/v1/responses', {
      model: 'qwen/qwen3-coder-30b', stream: true, instructions: 'be terse',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }, { type: 'web_search' }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body, /event: response\.completed/);
    assert.match(res.body, /hi there/);
    // upstream chat body must be non-streaming with the flattened single function tool
    assert.equal(lastChatBody.stream, false);
    assert.equal(lastChatBody.tools.length, 1);
    assert.equal(lastChatBody.tools[0].function.name, 'shell');
    assert.equal(lastChatBody.messages[0].role, 'system');
  });

  it('recovers a Qwen XML tool call into a Responses function_call output item', async () => {
    chatBehavior = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'cmpl-2', model: 'qwen/qwen3-coder-30b', choices: [{ finish_reason: 'stop', message: { content: '<function=write_file><parameter=path>ok.txt</parameter><parameter=content>CODEX_VIA_ANYMODEL_QWEN</parameter></function>' } }] }));
    };
    const res = await post(port, '/v1/responses', { model: 'qwen/qwen3-coder-30b', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write ok.txt' }] }] });
    assert.equal(res.status, 200);
    assert.match(res.body, /response\.output_item\.done/);
    assert.match(res.body, /"type":"function_call"/);
    assert.match(res.body, /"name":"write_file"/);
    assert.match(res.body, /ok\.txt/);
  });

  it('emits response.failed (not a hang) on an upstream error', async () => {
    chatBehavior = (req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })); };
    const res = await post(port, '/v1/responses', { model: 'qwen/qwen3-coder-30b', stream: true, input: [{ type: 'message', role: 'user', content: 'x' }] });
    assert.equal(res.status, 200, 'SSE already opened with 200');
    assert.match(res.body, /event: response\.failed/);
  });
});
