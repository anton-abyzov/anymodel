// 0009 US-1 — streaming text-channel tool-call recovery for local providers.
// createStreamTranslator({ localProvider: true }) buffers the text channel and,
// at end-of-message, recovers a parked Hermes/Qwen-XML/fenced tool call into a
// real tool_use block + stop_reason:'tool_use'. Cloud (localProvider:false) is
// unchanged (incremental text). Gated by ANYMODEL_PARSE_TEXT_TOOLCALLS (auto=local).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createStreamTranslator } from '../providers/openai.mjs';

let savedEnv;
before(() => { savedEnv = process.env.ANYMODEL_PARSE_TEXT_TOOLCALLS; process.env.ANYMODEL_PARSE_TEXT_TOOLCALLS = 'auto'; });
after(() => { if (savedEnv === undefined) delete process.env.ANYMODEL_PARSE_TEXT_TOOLCALLS; else process.env.ANYMODEL_PARSE_TEXT_TOOLCALLS = savedEnv; });

// Stream an array of OpenAI text-delta contents, then [DONE]. Returns raw SSE.
function streamText(translator, contents) {
  let out = '';
  for (const c of contents) {
    out += translator.transform(`data: {"id":"x","model":"m","choices":[{"delta":{"content":${JSON.stringify(c)}}}]}\n\n`);
  }
  out += translator.transform('data: [DONE]\n\n');
  return out;
}

function parse(sse) {
  const blocks = new Map();
  let stopReason = null, stops = 0, order = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
    if (e.type === 'content_block_start') { const cb = e.content_block || {}; blocks.set(e.index, { type: cb.type, name: cb.name ?? null, text: '', json: '' }); order.push(cb.type); }
    else if (e.type === 'content_block_delta') {
      const b = blocks.get(e.index); if (!b) continue;
      if (e.delta?.type === 'text_delta') b.text += e.delta.text;
      if (e.delta?.type === 'input_json_delta') b.json += e.delta.partial_json;
    }
    else if (e.type === 'message_delta') stopReason = e.delta?.stop_reason;
    else if (e.type === 'message_stop') stops++;
  }
  return { blocks: [...blocks.values()], stopReason, stops, order };
}

describe('0009 US-1 streaming text-channel recovery (local)', () => {
  it('recovers a Qwen-XML tool call streamed across text deltas', () => {
    const t = createStreamTranslator({ localProvider: true });
    const out = streamText(t, ['Sure, let me read it. ', '<function=read_file><parameter=path>a.txt</parameter></function>']);
    const { blocks, stopReason, stops } = parse(out);
    assert.equal(stopReason, 'tool_use');
    assert.equal(stops, 1, 'exactly one message_stop');
    const tool = blocks.find(b => b.type === 'tool_use');
    assert.equal(tool.name, 'read_file');
    assert.deepEqual(JSON.parse(tool.json), { path: 'a.txt' });
    const text = blocks.find(b => b.type === 'text');
    assert.ok(text && text.text.includes('let me read it'));
    assert.ok(!text.text.includes('<function='), 'tool-call span stripped from text');
  });

  it('recovers a Hermes tool call streamed in the text channel', () => {
    const t = createStreamTranslator({ localProvider: true });
    const out = streamText(t, ['<tool_call>{"name": "grep", "arguments": {"q": "foo"}}</tool_call>']);
    const { blocks, stopReason } = parse(out);
    assert.equal(stopReason, 'tool_use');
    const tool = blocks.find(b => b.type === 'tool_use');
    assert.equal(tool.name, 'grep');
    assert.deepEqual(JSON.parse(tool.json), { q: 'foo' });
  });

  it('does NOT convert prose that merely mentions the tag (false-positive guard)', () => {
    const t = createStreamTranslator({ localProvider: true });
    const out = streamText(t, ['You can call a tool by emitting a <tool_call> block in your output.']);
    const { blocks, stopReason } = parse(out);
    assert.notEqual(stopReason, 'tool_use');
    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 0);
    assert.ok(blocks.find(b => b.type === 'text').text.includes('<tool_call>'));
  });

  it('plain local text turn emits a text block + exactly one message_stop', () => {
    const t = createStreamTranslator({ localProvider: true });
    const out = streamText(t, ['One, ', 'two, ', 'three.']);
    const { blocks, stops, stopReason } = parse(out);
    assert.equal(stops, 1);
    assert.equal(stopReason, 'end_turn');
    assert.equal(blocks.find(b => b.type === 'text').text, 'One, two, three.');
  });

  it('structured tool_calls present: buffered text emitted before the tool block, no recovery', () => {
    const t = createStreamTranslator({ localProvider: true });
    let out = '';
    out += t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"Let me check. "}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const { blocks, order } = parse(out);
    assert.deepEqual(order, ['text', 'tool_use'], 'text precedes tool_use');
    assert.equal(blocks.find(b => b.type === 'text').text, 'Let me check. ');
    assert.equal(blocks.find(b => b.type === 'tool_use').name, 'ls');
  });

  it('cloud (localProvider:false) still streams text incrementally — no buffering regression', () => {
    const t = createStreamTranslator(); // no opts → cloud
    let out = t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"Hel"}}]}\n\n');
    // text_delta should appear immediately, before [DONE]
    assert.ok(out.includes('"text_delta"') && out.includes('Hel'), 'incremental text emitted mid-stream');
  });
});
