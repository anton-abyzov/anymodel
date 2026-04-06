import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ollamaToolMode,
  shouldSendTools,
  cacheToolResult,
  isToolError,
  toolCache,
} from '../providers/ollama-tools.mjs';

describe('ollamaToolMode', () => {
  const origEnv = process.env.OLLAMA_TOOLS;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.OLLAMA_TOOLS;
    else process.env.OLLAMA_TOOLS = origEnv;
  });

  it('returns "auto" by default', () => {
    delete process.env.OLLAMA_TOOLS;
    assert.equal(ollamaToolMode(), 'auto');
  });

  it('returns "on" when OLLAMA_TOOLS=on', () => {
    process.env.OLLAMA_TOOLS = 'on';
    assert.equal(ollamaToolMode(), 'on');
  });

  it('returns "off" when OLLAMA_TOOLS=off', () => {
    process.env.OLLAMA_TOOLS = 'off';
    assert.equal(ollamaToolMode(), 'off');
  });

  it('normalizes to lowercase', () => {
    process.env.OLLAMA_TOOLS = 'ON';
    assert.equal(ollamaToolMode(), 'on');
  });

  it('returns "auto" for invalid values', () => {
    process.env.OLLAMA_TOOLS = 'maybe';
    assert.equal(ollamaToolMode(), 'auto');
  });

  it('returns "auto" for empty string', () => {
    process.env.OLLAMA_TOOLS = '';
    assert.equal(ollamaToolMode(), 'auto');
  });
});

describe('shouldSendTools', () => {
  const origEnv = process.env.OLLAMA_TOOLS;

  beforeEach(() => toolCache.clear());
  afterEach(() => {
    toolCache.clear();
    if (origEnv === undefined) delete process.env.OLLAMA_TOOLS;
    else process.env.OLLAMA_TOOLS = origEnv;
  });

  it('returns false when mode is off', () => {
    process.env.OLLAMA_TOOLS = 'off';
    assert.equal(shouldSendTools('qwen3'), false);
  });

  it('returns true when mode is on', () => {
    process.env.OLLAMA_TOOLS = 'on';
    assert.equal(shouldSendTools('qwen3'), true);
  });

  it('returns true on cache miss in auto mode (optimistic)', () => {
    process.env.OLLAMA_TOOLS = 'auto';
    assert.equal(shouldSendTools('qwen3'), true);
  });

  it('returns cached true value', () => {
    process.env.OLLAMA_TOOLS = 'auto';
    cacheToolResult('qwen3', true);
    assert.equal(shouldSendTools('qwen3'), true);
  });

  it('returns cached false value', () => {
    process.env.OLLAMA_TOOLS = 'auto';
    cacheToolResult('llama2', false);
    assert.equal(shouldSendTools('llama2'), false);
  });

  it('differentiates between models', () => {
    process.env.OLLAMA_TOOLS = 'auto';
    cacheToolResult('qwen3', true);
    cacheToolResult('llama2', false);
    assert.equal(shouldSendTools('qwen3'), true);
    assert.equal(shouldSendTools('llama2'), false);
    assert.equal(shouldSendTools('unknown-model'), true); // cache miss = optimistic
  });
});

describe('cacheToolResult', () => {
  beforeEach(() => toolCache.clear());
  afterEach(() => toolCache.clear());

  it('stores true for supported models', () => {
    cacheToolResult('qwen3', true);
    assert.equal(toolCache.get('qwen3'), true);
  });

  it('stores false for unsupported models', () => {
    cacheToolResult('llama2', false);
    assert.equal(toolCache.get('llama2'), false);
  });

  it('overwrites previous cache entry', () => {
    cacheToolResult('qwen3', false);
    cacheToolResult('qwen3', true);
    assert.equal(toolCache.get('qwen3'), true);
  });
});

describe('isToolError', () => {
  it('matches "does not support tools"', () => {
    assert.equal(isToolError('model "llama2" does not support tools'), true);
  });

  it('matches "support tool use" (OpenRouter pattern)', () => {
    assert.equal(isToolError("This model doesn't support tool use"), true);
  });

  it('matches "tools are not supported"', () => {
    assert.equal(isToolError('tools are not supported by this model'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(isToolError('connection refused'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isToolError(''), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isToolError('Does Not Support Tools'), true);
  });

  it('returns false for null', () => {
    assert.equal(isToolError(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isToolError(undefined), false);
  });
});
