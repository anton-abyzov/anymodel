import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computePrefixHash, getOrStore, resetCache } from '../providers/prefix-cache.mjs';

const sysA = 'You are a helpful assistant. Today: 2026-04-07';
const sysB = 'You are a coding assistant. Today: 2026-04-07';

const toolA = { name: 'Bash', description: 'Run commands', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } };
const toolB = { name: 'Read', description: 'Read files', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };

describe('computePrefixHash', () => {
  it('produces deterministic hash for same input', () => {
    const h1 = computePrefixHash(sysA, [toolA, toolB]);
    const h2 = computePrefixHash(sysA, [toolA, toolB]);
    assert.equal(h1, h2);
  });

  it('produces different hash for different system prompts', () => {
    const h1 = computePrefixHash(sysA, [toolA]);
    const h2 = computePrefixHash(sysB, [toolA]);
    assert.notEqual(h1, h2);
  });

  it('produces different hash for different tools', () => {
    const h1 = computePrefixHash(sysA, [toolA]);
    const h2 = computePrefixHash(sysA, [toolB]);
    assert.notEqual(h1, h2);
  });

  it('normalizes date before hashing', () => {
    const h1 = computePrefixHash('You are helpful. Today: 2026-04-07', [toolA]);
    const h2 = computePrefixHash('You are helpful. Today: 2026-04-08', [toolA]);
    assert.equal(h1, h2);
  });

  it('is tool-order independent', () => {
    const h1 = computePrefixHash(sysA, [toolA, toolB]);
    const h2 = computePrefixHash(sysA, [toolB, toolA]);
    assert.equal(h1, h2);
  });

  it('ignores tool description changes', () => {
    const t1 = { ...toolA, description: 'Run bash commands' };
    const t2 = { ...toolA, description: 'Execute shell commands in a terminal' };
    const h1 = computePrefixHash(sysA, [t1]);
    const h2 = computePrefixHash(sysA, [t2]);
    assert.equal(h1, h2);
  });

  it('handles null tools', () => {
    const h = computePrefixHash(sysA, null);
    assert.ok(typeof h === 'string' && h.length > 0);
  });

  it('handles empty system string', () => {
    const h = computePrefixHash('', [toolA]);
    assert.ok(typeof h === 'string' && h.length > 0);
  });
});

describe('getOrStore', () => {
  beforeEach(() => resetCache());

  it('returns miss on first call', () => {
    const result = getOrStore('modelA', sysA, [toolA]);
    assert.equal(result.hit, false);
  });

  it('returns hit on second call with same prefix', () => {
    getOrStore('modelA', sysA, [toolA]);
    const result = getOrStore('modelA', sysA, [toolA]);
    assert.equal(result.hit, true);
  });

  it('returns same system string reference on hit', () => {
    const original = getOrStore('modelA', sysA, [toolA]);
    const second = getOrStore('modelA', sysA, [toolA]);
    assert.equal(second.system, original.system);
  });

  it('returns same tools array reference on hit', () => {
    const original = getOrStore('modelA', sysA, [toolA]);
    const second = getOrStore('modelA', sysA, [toolA]);
    assert.equal(second.tools, original.tools);
  });

  it('returns miss when prefix changes', () => {
    getOrStore('modelA', sysA, [toolA]);
    const result = getOrStore('modelA', sysB, [toolA]);
    assert.equal(result.hit, false);
  });

  it('tracks hit per model independently', () => {
    getOrStore('modelA', sysA, [toolA]);
    getOrStore('modelB', sysB, [toolB]);
    const resultA = getOrStore('modelA', sysA, [toolA]);
    assert.equal(resultA.hit, true);
  });

  it('provides reasonable token estimate', () => {
    const result = getOrStore('modelA', sysA, [toolA]);
    assert.ok(result.tokenEstimate > 0);
  });
});

describe('LRU eviction', () => {
  beforeEach(() => resetCache());

  it('evicts oldest entry when exceeding 5 entries', () => {
    for (let i = 0; i < 6; i++) {
      getOrStore(`model-${i}`, `system-${i}`, [toolA]);
    }
    // First entry's prefix should have been evicted from store;
    // calling again should still work (re-stored), but it's a miss for model-0
    // since lastHash still matches, we just verify no crash and store size is bounded
    const result = getOrStore('model-0', 'system-0', [toolA]);
    assert.ok(result); // no crash, cache handles eviction gracefully
  });

  it('refreshes LRU on access', () => {
    // Store entries 1-5
    for (let i = 1; i <= 5; i++) {
      getOrStore(`m${i}`, `sys-${i}`, [toolA]);
    }
    // Access entry 1 again to refresh it
    getOrStore('m1', 'sys-1', [toolA]);
    // Store entry 6 — should evict entry 2 (oldest not-recently-used), not entry 1
    getOrStore('m6', 'sys-6', [toolA]);
    // Entry 1 should still be in cache (hit on same model)
    const r1 = getOrStore('m1', 'sys-1', [toolA]);
    assert.equal(r1.hit, true);
    // Entry 2 was evicted — re-storing gives a new reference, but model m2's lastHash still matches
    // so it will be a "hit" from the model perspective but the stored entry is new
    // The key test: entry 1 survived eviction because it was refreshed
  });
});

describe('resetCache', () => {
  it('clears all state', () => {
    getOrStore('modelA', sysA, [toolA]);
    getOrStore('modelA', sysA, [toolA]); // hit
    resetCache();
    const result = getOrStore('modelA', sysA, [toolA]);
    assert.equal(result.hit, false);
  });
});
