// Regression guard: in OLLAMA_TOOLS=auto mode with an uncached model, the proxy
// must FORWARD tools to the upstream (not blanket-strip them). This was the
// pre-v1.12.0 behavior and it broke slash commands like `/openspec propose`,
// file tools (Read/Write/Edit), and WebFetch on tool-capable local models.
//
// If this test fails, someone re-introduced blanket-stripping. See SKILL.md and
// KNOWLEDGE-BASE.md "capability-aware tool handling" sections.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../proxy.mjs';
import ollamaProvider from '../providers/ollama.mjs';
import { toolCache } from '../providers/ollama-tools.mjs';

function postJSON(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Spin up a stub Ollama upstream that captures the forwarded body and echoes a
// minimal valid non-streaming chat response.
function startStubOllama() {
  return new Promise(resolve => {
    const captured = { lastBody: null };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { captured.lastBody = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { captured.lastBody = null; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: captured.lastBody?.model || 'stub',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

describe('Ollama tool passthrough (proxy integration)', () => {
  const origMode = process.env.OLLAMA_TOOLS;
  let stub;
  let proxy;
  let proxyPort;

  before(async () => {
    stub = await startStubOllama();
    // Clone the real Ollama provider but point it at our stub server.
    const testProvider = {
      ...ollamaProvider,
      buildRequest: (_url, payload) => ({
        hostname: '127.0.0.1',
        port: stub.port,
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }),
    };
    proxy = createProxy(testProvider, { port: 0, model: 'qwen3-coder:stub' });
    await new Promise(resolve => {
      if (proxy.listening) { proxyPort = proxy.address().port; resolve(); }
      else proxy.on('listening', () => { proxyPort = proxy.address().port; resolve(); });
    });
  });

  after(() => {
    proxy?.close();
    stub?.server.close();
    if (origMode === undefined) delete process.env.OLLAMA_TOOLS;
    else process.env.OLLAMA_TOOLS = origMode;
  });

  beforeEach(() => {
    toolCache.clear();
    stub.captured.lastBody = null;
  });

  const toolsFixture = [{
    name: 'Write',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  }];

  it('auto mode: forwards tools to upstream for an uncached model', async () => {
    process.env.OLLAMA_TOOLS = 'auto';
    const res = await postJSON(proxyPort, '/v1/messages', {
      model: 'qwen3-coder:stub',
      max_tokens: 50,
      tools: toolsFixture,
      messages: [{ role: 'user', content: 'write /tmp/x' }],
    });
    assert.equal(res.status, 200);
    assert.ok(stub.captured.lastBody, 'upstream received a body');
    assert.ok(
      Array.isArray(stub.captured.lastBody.tools) && stub.captured.lastBody.tools.length > 0,
      'tools array must be present on upstream body (not blanket-stripped)'
    );
    const fn = stub.captured.lastBody.tools[0];
    assert.equal(fn.type, 'function', 'translated to OpenAI function format');
    assert.equal(fn.function.name, 'Write', 'tool name preserved');
  });

  it('auto mode: strips tools for a model cached as no-tool-support', async () => {
    process.env.OLLAMA_TOOLS = 'auto';
    // Simulate a prior tool-unsupport error cached for this model.
    toolCache.set('qwen3-coder:stub', false);
    const res = await postJSON(proxyPort, '/v1/messages', {
      model: 'qwen3-coder:stub',
      max_tokens: 50,
      tools: toolsFixture,
      messages: [{ role: 'user', content: 'write /tmp/x' }],
    });
    assert.equal(res.status, 200);
    assert.ok(stub.captured.lastBody, 'upstream received a body');
    assert.ok(
      !stub.captured.lastBody.tools || stub.captured.lastBody.tools.length === 0,
      'tools must be stripped when model is cached as no-tool-support'
    );
  });

  it('off mode: always strips tools (legacy behavior)', async () => {
    process.env.OLLAMA_TOOLS = 'off';
    const res = await postJSON(proxyPort, '/v1/messages', {
      model: 'qwen3-coder:stub',
      max_tokens: 50,
      tools: toolsFixture,
      messages: [{ role: 'user', content: 'write /tmp/x' }],
    });
    assert.equal(res.status, 200);
    assert.ok(
      !stub.captured.lastBody.tools || stub.captured.lastBody.tools.length === 0,
      'OLLAMA_TOOLS=off must always strip tools'
    );
  });

  it('on mode: always forwards tools even on fresh cache', async () => {
    process.env.OLLAMA_TOOLS = 'on';
    const res = await postJSON(proxyPort, '/v1/messages', {
      model: 'qwen3-coder:stub',
      max_tokens: 50,
      tools: toolsFixture,
      messages: [{ role: 'user', content: 'write /tmp/x' }],
    });
    assert.equal(res.status, 200);
    assert.ok(
      Array.isArray(stub.captured.lastBody.tools) && stub.captured.lastBody.tools.length > 0,
      'OLLAMA_TOOLS=on must always forward tools'
    );
  });

  it('strips tool_choice for ollama regardless of mode', async () => {
    process.env.OLLAMA_TOOLS = 'on';
    const res = await postJSON(proxyPort, '/v1/messages', {
      model: 'qwen3-coder:stub',
      max_tokens: 50,
      tools: toolsFixture,
      tool_choice: { type: 'tool', name: 'Write' },
      messages: [{ role: 'user', content: 'write /tmp/x' }],
    });
    assert.equal(res.status, 200);
    assert.equal(stub.captured.lastBody.tool_choice, undefined, 'tool_choice must be removed for Ollama');
  });
});
