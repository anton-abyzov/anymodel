import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import lmstudio from '../providers/lmstudio.mjs';

describe('lmstudio provider — interface', () => {
  it('has name "lmstudio"', () => {
    assert.equal(lmstudio.name, 'lmstudio');
  });

  it('exports required interface', () => {
    assert.equal(typeof lmstudio.buildRequest, 'function');
    assert.equal(typeof lmstudio.transformRequest, 'function');
    assert.equal(typeof lmstudio.transformResponse, 'function');
    assert.equal(typeof lmstudio.createStreamTranslator, 'function');
    assert.equal(typeof lmstudio.displayInfo, 'function');
    assert.equal(typeof lmstudio.detect, 'function');
    assert.equal(typeof lmstudio.listModels, 'function');
  });
});

describe('lmstudio.buildRequest', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LMSTUDIO_BASE_URL;
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LMSTUDIO_BASE_URL = savedBase;
    } else {
      delete process.env.LMSTUDIO_BASE_URL;
    }
  });

  it('returns correct options with default env', () => {
    delete process.env.LMSTUDIO_BASE_URL;
    const payload = JSON.stringify({ model: 'test', messages: [] });
    const opts = lmstudio.buildRequest('/v1/messages', payload);
    assert.equal(opts.hostname, '127.0.0.1');
    assert.equal(opts.port, '1234');
    assert.equal(opts.protocol, 'http:');
    assert.equal(opts.path, '/v1/chat/completions');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['content-length'], Buffer.byteLength(payload));
    assert.ok(opts.headers['authorization'].startsWith('Bearer '), 'auth header must start with Bearer');
  });

  it('honors LMSTUDIO_BASE_URL override', () => {
    process.env.LMSTUDIO_BASE_URL = 'http://example.com:9999/v1';
    const opts = lmstudio.buildRequest('/v1/messages', '{}');
    assert.equal(opts.hostname, 'example.com');
    assert.equal(opts.port, '9999');
    assert.equal(opts.path, '/v1/chat/completions');
  });
});

describe('lmstudio translation delegates', () => {
  it('transformRequest delegates to openai translator', () => {
    const result = lmstudio.transformRequest({
      model: 'qwen2.5-coder-7b',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.model, 'qwen2.5-coder-7b');
    assert.ok(Array.isArray(result.messages), 'should have messages array');
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'hello');
  });

  it('transformResponse delegates to openai translator', () => {
    const result = lmstudio.transformResponse({
      id: 'chatcmpl-1',
      model: 'qwen2.5-coder-7b',
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

describe('lmstudio.displayInfo', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LMSTUDIO_BASE_URL;
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LMSTUDIO_BASE_URL = savedBase;
    } else {
      delete process.env.LMSTUDIO_BASE_URL;
    }
  });

  it('formats with model and base url', () => {
    delete process.env.LMSTUDIO_BASE_URL;
    const info = lmstudio.displayInfo('qwen2.5-coder-7b');
    assert.ok(info.includes('qwen2.5-coder-7b'), 'should include model');
    assert.ok(info.includes('http://127.0.0.1:1234/v1'), 'should include base URL');
  });

  it('formats without model', () => {
    delete process.env.LMSTUDIO_BASE_URL;
    const info = lmstudio.displayInfo();
    assert.ok(info.includes('http://127.0.0.1:1234/v1'), 'should include base URL');
  });
});

describe('lmstudio.detect and listModels — no server', () => {
  let savedBase;

  beforeEach(() => {
    savedBase = process.env.LMSTUDIO_BASE_URL;
    // Point at an unused port — assume nothing is listening there
    process.env.LMSTUDIO_BASE_URL = 'http://localhost:59999/v1';
  });

  afterEach(() => {
    if (savedBase !== undefined) {
      process.env.LMSTUDIO_BASE_URL = savedBase;
    } else {
      delete process.env.LMSTUDIO_BASE_URL;
    }
  });

  it('detect() returns false when nothing listening', async () => {
    const detected = await lmstudio.detect();
    assert.equal(detected, false);
  });

  it('listModels() returns [] when server unreachable', async () => {
    const models = await lmstudio.listModels();
    assert.deepEqual(models, []);
  });
});

describe('lmstudio.detect and listModels — mock server', () => {
  let savedBase;
  let server;
  let port;

  beforeEach(async () => {
    savedBase = process.env.LMSTUDIO_BASE_URL;
    server = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder-7b' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    process.env.LMSTUDIO_BASE_URL = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    if (savedBase !== undefined) {
      process.env.LMSTUDIO_BASE_URL = savedBase;
    } else {
      delete process.env.LMSTUDIO_BASE_URL;
    }
  });

  it('detect() returns true when server responds', async () => {
    const detected = await lmstudio.detect();
    assert.equal(detected, true);
  });

  it('listModels() returns parsed ids', async () => {
    const models = await lmstudio.listModels();
    assert.deepEqual(models, ['qwen2.5-coder-7b']);
  });
});
