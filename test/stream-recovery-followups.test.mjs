// 0009 review follow-ups:
//  #1 post-tool text must not be dropped on the local buffered path
//  #2 stop_reason:'tool_use' even when the server omits a finish_reason chunk
//  #3 fenced ```json is NOT recovered under 'auto' (coding-agent false positive),
//     but Hermes/Qwen-XML still are; fenced recovers under explicit 'on'

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createStreamTranslator } from '../providers/openai.mjs';

const KEY = 'ANYMODEL_PARSE_TEXT_TOOLCALLS';
let saved;
before(() => { saved = process.env[KEY]; });
after(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

function parse(sse) {
  const blocks = new Map(); let stopReason = null, stops = 0, order = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
    if (e.type === 'content_block_start') { const cb = e.content_block || {}; blocks.set(e.index, { type: cb.type, name: cb.name ?? null, text: '', json: '' }); order.push(cb.type); }
    else if (e.type === 'content_block_delta') { const b = blocks.get(e.index); if (!b) continue; if (e.delta?.type === 'text_delta') b.text += e.delta.text; if (e.delta?.type === 'input_json_delta') b.json += e.delta.partial_json; }
    else if (e.type === 'message_delta') stopReason = e.delta?.stop_reason;
    else if (e.type === 'message_stop') stops++;
  }
  return { blocks: [...blocks.values()], stopReason, stops, order };
}

describe('#1 post-tool text not dropped (local)', () => {
  it('emits text that arrives AFTER a structured tool_call', () => {
    process.env[KEY] = 'auto';
    const t = createStreamTranslator({ localProvider: true });
    let out = '';
    out += t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"before tool "}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"content":"AFTER tool text"}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const { blocks } = parse(out);
    const texts = blocks.filter(b => b.type === 'text').map(b => b.text).join('|');
    assert.ok(texts.includes('before tool'), 'pre-tool text present');
    assert.ok(texts.includes('AFTER tool text'), 'post-tool text NOT dropped');
    assert.equal(blocks.find(b => b.type === 'tool_use').name, 'ls');
  });
});

describe('#2 stop_reason tool_use without finish_reason chunk', () => {
  it('cloud structured tool call + no finish_reason → stop_reason tool_use', () => {
    process.env[KEY] = 'off';
    const t = createStreamTranslator(); // cloud
    let out = '';
    out += t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"read","arguments":"{}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n'); // NO finish_reason chunk
    assert.equal(parse(out).stopReason, 'tool_use');
  });
});

describe('#3 fenced json gating', () => {
  it('does NOT recover a fenced ```json tool-shape under auto (coding-agent safe)', () => {
    process.env[KEY] = 'auto';
    const t = createStreamTranslator({ localProvider: true });
    let out = '';
    out += t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"Here is a config: "}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{"content":"```json\\n{\\"name\\":\\"svc\\",\\"arguments\\":{\\"x\\":1}}\\n```"}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const { blocks, stopReason } = parse(out);
    assert.notEqual(stopReason, 'tool_use', 'fenced json not misclassified as a tool call');
    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 0);
    assert.ok(blocks.find(b => b.type === 'text').text.includes('```json'), 'fenced block kept as text');
  });

  it('still recovers unambiguous Qwen-XML under auto', () => {
    process.env[KEY] = 'auto';
    const t = createStreamTranslator({ localProvider: true });
    let out = t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"<function=read_file><parameter=path>a.txt</parameter></function>"}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const { blocks, stopReason } = parse(out);
    assert.equal(stopReason, 'tool_use');
    assert.equal(blocks.find(b => b.type === 'tool_use').name, 'read_file');
  });

  it('recovers fenced json under explicit on', () => {
    process.env[KEY] = 'on';
    const t = createStreamTranslator({ localProvider: true });
    let out = t.transform('data: {"id":"x","model":"m","choices":[{"delta":{"content":"```json\\n{\\"name\\":\\"svc\\",\\"arguments\\":{\\"x\\":1}}\\n```"}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const { blocks, stopReason } = parse(out);
    assert.equal(stopReason, 'tool_use');
    assert.equal(blocks.find(b => b.type === 'tool_use').name, 'svc');
  });
});
