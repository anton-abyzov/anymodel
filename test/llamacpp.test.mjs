import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import llamacpp from '../providers/llamacpp.mjs';

describe('llamacpp provider — interface', () => {
  it('has name "llamacpp"', () => {
    assert.equal(llamacpp.name, 'llamacpp');
  });

  it('exports required interface', () => {
    assert.equal(typeof llamacpp.buildRequest, 'function');
    assert.equal(typeof llamacpp.transformRequest, 'function');
    assert.equal(typeof llamacpp.transformResponse, 'function');
    assert.equal(typeof llamacpp.createStreamTranslator, 'function');
    assert.equal(typeof llamacpp.displayInfo, 'function');
    assert.equal(typeof llamacpp.detect, 'function');
    assert.equal(typeof llamacpp.listModels, 'function');
  });
});

describe('llamacpp.buildRequest', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LLAMACPP_BASE_URL;
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LLAMACPP_BASE_URL = savedBase;
    } else {
      delete process.env.LLAMACPP_BASE_URL;
    }
  });

  it('returns correct options with default env', () => {
    delete process.env.LLAMACPP_BASE_URL;
    const payload = JSON.stringify({ model: 'test', messages: [] });
    const opts = llamacpp.buildRequest('/v1/messages', payload);
    assert.equal(opts.hostname, 'localhost');
    assert.equal(opts.port, '8080');
    assert.equal(opts.protocol, 'http:');
    assert.equal(opts.path, '/v1/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['content-length'], Buffer.byteLength(payload));
    assert.ok(opts.headers['authorization'].startsWith('Bearer '), 'auth header must start with Bearer');
    assert.equal(opts.headers['authorization'], 'Bearer no-key');
  });

  it('honors LLAMACPP_BASE_URL override', () => {
    process.env.LLAMACPP_BASE_URL = 'http://example.com:9999/v1';
    const opts = llamacpp.buildRequest('/v1/messages', '{}');
    assert.equal(opts.hostname, 'example.com');
    assert.equal(opts.port, '9999');
    assert.equal(opts.path, '/v1/chat/completions');
  });
});

describe('llamacpp translation delegates', () => {
  it('transformRequest delegates to openai translator', () => {
    const result = llamacpp.transformRequest({
      model: 'llama-3.2-3b-instruct-q4_k_m',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.model, 'llama-3.2-3b-instruct-q4_k_m');
    assert.ok(Array.isArray(result.messages), 'should have messages array');
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'hello');
  });

  it('transformResponse delegates to openai translator', () => {
    const result = llamacpp.transformResponse({
      id: 'chatcmpl-1',
      model: 'llama-3.2-3b-instruct-q4_k_m',
      choices: [{
        message: { role: 'assistant', content: 'Hi there' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    assert.equal(result.type, 'message');
    assert.equal(result.role, 'assistant');
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hi there');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.usage.input_tokens, 5);
    assert.equal(result.usage.output_tokens, 3);
  });
});

describe('llamacpp.displayInfo', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LLAMACPP_BASE_URL;
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LLAMACPP_BASE_URL = savedBase;
    } else {
      delete process.env.LLAMACPP_BASE_URL;
    }
  });

  it('formats with model and base url', () => {
    delete process.env.LLAMACPP_BASE_URL;
    const info = llamacpp.displayInfo('llama-3.2-3b-instruct-q4_k_m');
    assert.ok(info.includes('llama-3.2-3b-instruct-q4_k_m'), 'should include model');
    assert.ok(info.includes('http://localhost:8080/v1'), 'should include base URL');
  });

  it('formats without model', () => {
    delete process.env.LLAMACPP_BASE_URL;
    const info = llamacpp.displayInfo();
    assert.ok(info.includes('http://localhost:8080/v1'), 'should include base URL');
  });
});

describe('llamacpp.detect and listModels — no server', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LLAMACPP_BASE_URL;
    // Point at an unused port — assume nothing is listening there
    process.env.LLAMACPP_BASE_URL = 'http://localhost:59998/v1';
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LLAMACPP_BASE_URL = savedBase;
    } else {
      delete process.env.LLAMACPP_BASE_URL;
    }
  });

  it('detect() returns false when nothing listening', async () => {
    const detected = await llamacpp.detect();
    assert.equal(detected, false);
  });

  it('listModels() returns [] when server unreachable', async () => {
    const models = await llamacpp.listModels();
    assert.deepEqual(models, []);
  });
});

describe('llamacpp.detect and listModels — mock server', () => {
  let savedBase;
  let server;
  let port;

  beforeEach(async () => {
    savedBase = process.env.LLAMACPP_BASE_URL;
    server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'llama-3.2-3b-instruct-q4_k_m' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    process.env.LLAMACPP_BASE_URL = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    if (savedBase !== undefined) {
      process.env.LLAMACPP_BASE_URL = savedBase;
    } else {
      delete process.env.LLAMACPP_BASE_URL;
    }
  });

  it('detect() returns true when server responds', async () => {
    const detected = await llamacpp.detect();
    assert.equal(detected, true);
  });

  it('listModels() returns parsed ids', async () => {
    const models = await llamacpp.listModels();
    assert.deepEqual(models, ['llama-3.2-3b-instruct-q4_k_m']);
  });
});
