import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../cli.mjs';

describe('detectProvider', () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('returns openrouter when OPENROUTER_API_KEY is set', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test-123';
    const provider = await detectProvider();
    assert.equal(provider, 'openrouter');
  });

  it('detects only fixture backends when no cloud key is configured', async t => {
    delete process.env.OPENROUTER_API_KEY;
    const previousOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { default: ollama } = await import('../providers/ollama.mjs');
    const { default: lmstudio } = await import('../providers/lmstudio.mjs');
    const { default: llamacpp } = await import('../providers/llamacpp.mjs');
    const calls = [];
    t.mock.method(ollama, 'detect', async () => { calls.push('ollama'); return false; });
    t.mock.method(lmstudio, 'detect', async () => { calls.push('lmstudio'); return false; });
    t.mock.method(llamacpp, 'detect', async () => { calls.push('llamacpp'); return true; });
    try {
      assert.equal(await detectProvider(), 'llamacpp');
      assert.deepEqual(calls, ['ollama', 'lmstudio', 'llamacpp']);
    } finally {
      if (previousOpenAI !== undefined) process.env.OPENAI_API_KEY = previousOpenAI;
    }
  });
});

describe('provider configs', () => {
  it('openrouter provider exports required interface', async () => {
    const { default: openrouter } = await import('../providers/openrouter.mjs');
    assert.equal(openrouter.name, 'openrouter');
    assert.equal(typeof openrouter.buildRequest, 'function');
    assert.equal(typeof openrouter.displayInfo, 'function');
  });

  it('ollama provider exports required interface', async () => {
    const { default: ollama } = await import('../providers/ollama.mjs');
    assert.equal(ollama.name, 'ollama');
    assert.equal(typeof ollama.buildRequest, 'function');
    assert.equal(typeof ollama.displayInfo, 'function');
    assert.equal(typeof ollama.detect, 'function');
  });

  it('openrouter buildRequest returns correct options', async () => {
    const { default: openrouter } = await import('../providers/openrouter.mjs');
    const opts = openrouter.buildRequest('/v1/messages', 'test-payload', 'sk-key-123');
    assert.equal(opts.hostname, 'openrouter.ai');
    assert.equal(opts.path, '/api/v1/messages');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['authorization'], 'Bearer sk-key-123');
  });

  it('ollama buildRequest returns correct options', async () => {
    const { default: ollama } = await import('../providers/ollama.mjs');
    const opts = ollama.buildRequest('/v1/messages', 'test-payload');
    assert.equal(opts.hostname, 'localhost');
    assert.equal(opts.port, 11434);
    assert.equal(opts.path, '/api/chat');
  });

  it('lmstudio provider exports required interface', async () => {
    const { default: lmstudio } = await import('../providers/lmstudio.mjs');
    assert.equal(lmstudio.name, 'lmstudio');
    assert.equal(typeof lmstudio.buildRequest, 'function');
    assert.equal(typeof lmstudio.displayInfo, 'function');
    assert.equal(typeof lmstudio.detect, 'function');
  });

  it('llamacpp provider exports required interface', async () => {
    const { default: llamacpp } = await import('../providers/llamacpp.mjs');
    assert.equal(llamacpp.name, 'llamacpp');
    assert.equal(typeof llamacpp.buildRequest, 'function');
    assert.equal(typeof llamacpp.displayInfo, 'function');
    assert.equal(typeof llamacpp.detect, 'function');
  });

  it('lmstudio buildRequest returns correct options', async () => {
    const { default: lmstudio } = await import('../providers/lmstudio.mjs');
    const opts = lmstudio.buildRequest('/v1/messages', 'test-payload');
    assert.equal(opts.hostname, '127.0.0.1');
    assert.equal(opts.port, '1234');
    assert.equal(opts.path, '/v1/chat/completions');
  });

  it('llamacpp buildRequest returns correct options', async () => {
    const { default: llamacpp } = await import('../providers/llamacpp.mjs');
    const opts = llamacpp.buildRequest('/v1/messages', 'test-payload');
    assert.equal(opts.hostname, '127.0.0.1');
    assert.equal(opts.port, '8080');
    assert.equal(opts.path, '/v1/chat/completions');
  });
});
