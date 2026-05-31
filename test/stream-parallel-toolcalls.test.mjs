// P1.1 (US-4) — streamed parallel tool calls must route argument fragments by
// `tc.index`, not by the most-recently-opened block. Regression for the
// hard-coded `blockIndex-1` misroute that cross-assigned fragments.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStreamTranslator } from '../providers/openai.mjs';

// Parse emitted Anthropic SSE into a map of block index → { name, json }.
function collectBlocks(sse) {
  const blocks = new Map();
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let evt;
    try { evt = JSON.parse(line.slice(6)); } catch { continue; }
    if (evt.type === 'content_block_start') {
      const cb = evt.content_block || {};
      blocks.set(evt.index, { name: cb.name ?? null, type: cb.type, json: '' });
    } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
      const b = blocks.get(evt.index);
      if (b) b.json += evt.delta.partial_json;
    }
  }
  return blocks;
}

describe('P1.1 streamed parallel tool calls', () => {
  it('routes interleaved argument fragments to their own blocks by tc.index', () => {
    const t = createStreamTranslator();
    let out = '';
    // Two tool calls open (indices 0 and 1)
    out += t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"read_file","arguments":""}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","function":{"name":"write_file","arguments":""}}]}}]}\n\n');
    // Interleaved argument fragments across indices
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"path\\":\\"b.txt\\"}"}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');

    const blocks = collectBlocks(out);
    // Find the two tool_use blocks by name
    const byName = {};
    for (const b of blocks.values()) if (b.type === 'tool_use') byName[b.name] = b.json;

    assert.deepEqual(JSON.parse(byName.read_file), { path: 'a.txt' }, 'read_file got only its own args');
    assert.deepEqual(JSON.parse(byName.write_file), { path: 'b.txt' }, 'write_file got only its own args');
  });

  it('keeps tool block indices correct when text precedes the tool call', () => {
    const t = createStreamTranslator();
    let out = '';
    out += t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"content":"Let me read that. "}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"content":"One sec. "}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"grep","arguments":"{\\"q\\":"}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"foo\\"}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');

    const blocks = collectBlocks(out);
    const tool = [...blocks.values()].find(b => b.type === 'tool_use');
    assert.equal(tool.name, 'grep');
    assert.deepEqual(JSON.parse(tool.json), { q: 'foo' }, 'args not inflated by per-text-delta blockIndex bump');
  });

  it('regression: a single sequential tool call still accumulates its full JSON', () => {
    const t = createStreamTranslator();
    let out = '';
    out += t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"fn","arguments":"{\\"a\\":1"}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"b\\":2}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const tool = [...collectBlocks(out).values()].find(b => b.type === 'tool_use');
    assert.deepEqual(JSON.parse(tool.json), { a: 1, b: 2 });
  });
});
