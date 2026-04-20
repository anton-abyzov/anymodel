import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../proxy.mjs';
import ollamaProvider from '../providers/ollama.mjs';

// ── count_tokens mock ──

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
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('count_tokens mock', () => {
  let server;
  let port;

  // Use a non-openrouter provider so the mock activates
  const mockProvider = {
    name: 'ollama',
    buildRequest: () => ({ hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST', headers: {} }),
    displayInfo: () => 'test',
  };

  before(async () => {
    server = createProxy(mockProvider, { port: 0, model: 'test-model' });
    await new Promise(resolve => {
      if (server.listening) { port = server.address().port; resolve(); }
      else server.on('listening', () => { port = server.address().port; resolve(); });
    });
  });

  after(() => server.close());

  it('returns 200 with input_tokens', async () => {
    const res = await postJSON(port, '/v1/messages/count_tokens', {
      model: 'test',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('input_tokens' in body, 'response should contain input_tokens');
    assert.equal(typeof body.input_tokens, 'number');
    assert.ok(body.input_tokens > 0, 'input_tokens should be positive');
  });

  it('handles beta query param', async () => {
    const res = await postJSON(port, '/v1/messages/count_tokens?beta=true', {
      model: 'test',
      messages: [{ role: 'user', content: 'Test' }],
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok('input_tokens' in body);
  });

  it('scales with payload size', async () => {
    const small = await postJSON(port, '/v1/messages/count_tokens', { model: 'test', messages: [{ role: 'user', content: 'Hi' }] });
    const large = await postJSON(port, '/v1/messages/count_tokens', { model: 'test', messages: [{ role: 'user', content: 'x'.repeat(10000) }] });
    const smallTokens = JSON.parse(small.body).input_tokens;
    const largeTokens = JSON.parse(large.body).input_tokens;
    assert.ok(largeTokens > smallTokens, 'larger payload should estimate more tokens');
  });
});

// ── Tool description trimming ──

// Description trimming tests moved to test/tool-compressor.test.mjs
// (trimming now happens in tool-compressor.mjs, upstream of transformRequest)

describe('Ollama tool passthrough (post-compressor)', () => {
  it('passes tools through without modification', () => {
    const body = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'Bash',
        description: 'Already trimmed by compressor.',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      }],
    };
    const result = ollamaProvider.transformRequest(body);
    assert.equal(result.tools[0].function.description, 'Already trimmed by compressor.');
  });

  it('handles tools with no description', () => {
    const body = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'NoDesc',
        input_schema: { type: 'object', properties: { x: { type: 'string' } } },
      }],
    };
    const result = ollamaProvider.transformRequest(body);
    assert.equal(result.tools[0].function.description, '');
  });
});
