// 0009 — P1.10 capability cache covers all local providers, and Ollama streaming
// usage parity (input_tokens).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { toolCache, shouldSendTools, cacheToolResult } from '../providers/ollama-tools.mjs';
import ollama from '../providers/ollama.mjs';

describe('P1.10 tool-capability cache is provider-agnostic (model-keyed)', () => {
  beforeEach(() => toolCache.clear());

  it('a no-tool-support result cached for an lmstudio model is honored by shouldSendTools', () => {
    // proxy.mjs now calls cacheToolResult for ALL local providers (isLocal), not just ollama.
    cacheToolResult('lmstudio-weak-model', false);
    assert.equal(shouldSendTools('lmstudio-weak-model'), false, 'lmstudio model learns no-tool-support');
  });

  it('a success result keeps tools enabled', () => {
    cacheToolResult('qwen/qwen3-coder-30b', true);
    assert.equal(shouldSendTools('qwen/qwen3-coder-30b'), true);
  });

  it('an uncached model defaults to sending tools (try-then-cache)', () => {
    assert.equal(shouldSendTools('never-seen-model'), true);
  });
});

describe('Ollama streaming usage parity (input_tokens)', () => {
  it('final message_delta carries input_tokens from prompt_eval_count', () => {
    const t = ollama.createStreamTranslator();
    let out = t.transform(JSON.stringify({ model: 'm', message: { content: 'hi' }, done: false }) + '\n');
    out += t.transform(JSON.stringify({ model: 'm', message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 222, eval_count: 9 }) + '\n');
    // find message_delta usage
    const deltaLine = out.split('\n').find(l => l.startsWith('data:') && l.includes('message_delta'));
    const usage = JSON.parse(deltaLine.slice(5)).usage;
    assert.equal(usage.input_tokens, 222);
    assert.equal(usage.output_tokens, 9);
  });
});
