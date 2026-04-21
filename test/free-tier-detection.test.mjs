// US-005 regression: free-tier detection must trust the `:free` suffix + keep
// `openrouter/free` as auto-router special case. FREE_MODELS allowlist removed in 1.12.0.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFreeTierModel } from '../cli.mjs';

describe('isFreeTierModel — suffix-based detection (US-005)', () => {
  it('returns true for ANY model ending in :free — even models not in any hardcoded list', () => {
    assert.equal(isFreeTierModel('some/brand-new-model:free'), true);
    assert.equal(isFreeTierModel('random-org/whatever-2027:free'), true);
    assert.equal(isFreeTierModel('qwen/qwen3-coder:free'), true);
    assert.equal(isFreeTierModel('meta-llama/llama-3.3-70b-instruct:free'), true);
  });

  it('returns true for openrouter/free auto-router special case', () => {
    assert.equal(isFreeTierModel('openrouter/free'), true);
  });

  it('returns false for models without :free suffix', () => {
    assert.equal(isFreeTierModel('openai/gpt-5.4'), false);
    assert.equal(isFreeTierModel('anthropic/claude-opus-4-7'), false);
    assert.equal(isFreeTierModel('qwen/qwen3-coder'), false); // paid variant
  });

  it('handles empty/null model id gracefully', () => {
    assert.equal(isFreeTierModel(''), false);
    assert.equal(isFreeTierModel(null), false);
    assert.equal(isFreeTierModel(undefined), false);
  });

  it('is case-sensitive on the :free suffix', () => {
    // :FREE, :Free etc are not recognized — OpenRouter's convention is lowercase
    assert.equal(isFreeTierModel('model:FREE'), false);
    assert.equal(isFreeTierModel('model:Free'), false);
  });
});

describe('isFreeTierModel — no more FREE_MODELS allowlist', () => {
  it('cli.mjs no longer exports FREE_MODELS', async () => {
    const cli = await import('../cli.mjs');
    assert.equal(cli.FREE_MODELS, undefined, 'FREE_MODELS export should be removed');
  });
});
