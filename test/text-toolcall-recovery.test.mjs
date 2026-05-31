// P0.2: recover tool calls that a local model parked in the TEXT channel
// (Hermes <tool_call>, Qwen XML <function=>, fenced ```json) instead of the
// structured tool_calls array. Gated by ANYMODEL_PARSE_TEXT_TOOLCALLS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTextToolCalls, translateResponse } from '../providers/openai.mjs';

function resp(content, finish = 'stop') {
  return { id: 'r1', model: 'qwen', choices: [{ message: { content }, finish_reason: finish }] };
}

test('P0.2 — extractTextToolCalls', async (t) => {
  await t.test('Hermes <tool_call> with object arguments', () => {
    const { calls, cleanedText } = extractTextToolCalls(
      'Let me check.\n<tool_call>{"name":"run_bash","arguments":{"cmd":"ls -la"}}</tool_call>'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_bash');
    assert.deepEqual(calls[0].input, { cmd: 'ls -la' });
    assert.equal(cleanedText, 'Let me check.');
  });

  await t.test('Hermes with arguments as a JSON STRING', () => {
    const { calls } = extractTextToolCalls(
      '<tool_call>{"name":"read","arguments":"{\\"path\\":\\"/tmp/x\\"}"}</tool_call>'
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { path: '/tmp/x' });
  });

  await t.test('Qwen XML <function=...><parameter=...>', () => {
    const { calls } = extractTextToolCalls(
      '<function=run_bash><parameter=cmd>echo hi</parameter></function>'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'run_bash');
    assert.equal(calls[0].input.cmd, 'echo hi');
  });

  await t.test('fenced ```json tool-call block', () => {
    const { calls } = extractTextToolCalls(
      '```json\n{"name":"search","arguments":{"q":"foo"}}\n```'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'search');
    assert.deepEqual(calls[0].input, { q: 'foo' });
  });

  await t.test('parallel: two Hermes calls in one message', () => {
    const { calls } = extractTextToolCalls(
      '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call>'
      + '<tool_call>{"name":"b","arguments":{"y":2}}</tool_call>'
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.name), ['a', 'b']);
  });

  // ── False-positive guards ──
  await t.test('prose mentioning <tool_call> with no valid JSON is NOT converted', () => {
    const text = 'You can wrap a call in <tool_call> ... </tool_call> tags like this.';
    const { calls, cleanedText } = extractTextToolCalls(text);
    assert.equal(calls.length, 0);
    assert.equal(cleanedText, text.trim());
  });

  await t.test('plain prose is untouched', () => {
    const { calls, cleanedText } = extractTextToolCalls('Just a normal answer.');
    assert.equal(calls.length, 0);
    assert.equal(cleanedText, 'Just a normal answer.');
  });

  await t.test('fenced json that is NOT a tool-call shape is left alone', () => {
    const { calls } = extractTextToolCalls('```json\n{"result": 42}\n```');
    assert.equal(calls.length, 0);
  });
});

test('P0.2 — translateResponse recovery gating', async (t) => {
  const KEY = 'ANYMODEL_PARSE_TEXT_TOOLCALLS';
  const orig = process.env[KEY];
  t.after(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });

  await t.test('localProvider + auto: recovers to tool_use + stop_reason tool_use', () => {
    delete process.env[KEY]; // default 'auto'
    const out = translateResponse(
      resp('<tool_call>{"name":"run_bash","arguments":{"cmd":"pwd"}}</tool_call>'),
      { localProvider: true }
    );
    const toolUse = out.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse, 'must produce a tool_use block');
    assert.equal(toolUse.name, 'run_bash');
    assert.deepEqual(toolUse.input, { cmd: 'pwd' });
    assert.equal(out.stop_reason, 'tool_use');
    assert.ok(toolUse.id && toolUse.id.startsWith('toolu_'));
  });

  await t.test('cloud (localProvider=false) + auto: does NOT touch text', () => {
    delete process.env[KEY];
    const out = translateResponse(
      resp('<tool_call>{"name":"run_bash","arguments":{"cmd":"pwd"}}</tool_call>'),
      { localProvider: false }
    );
    assert.equal(out.content.filter(b => b.type === 'tool_use').length, 0);
    assert.equal(out.stop_reason, 'end_turn');
  });

  await t.test('off: never recovers even for local', () => {
    process.env[KEY] = 'off';
    const out = translateResponse(
      resp('<tool_call>{"name":"x","arguments":{}}</tool_call>'),
      { localProvider: true }
    );
    assert.equal(out.content.filter(b => b.type === 'tool_use').length, 0);
  });

  await t.test('on: recovers even for cloud', () => {
    process.env[KEY] = 'on';
    const out = translateResponse(
      resp('<tool_call>{"name":"x","arguments":{"a":1}}</tool_call>'),
      { localProvider: false }
    );
    assert.equal(out.content.filter(b => b.type === 'tool_use').length, 1);
  });

  await t.test('structured tool_calls take precedence — no double-emit', () => {
    delete process.env[KEY];
    const r = {
      id: 'r', model: 'qwen',
      choices: [{
        message: {
          content: 'noise <tool_call>{"name":"ghost","arguments":{}}</tool_call>',
          tool_calls: [{ id: 't1', function: { name: 'real', arguments: '{"a":1}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const out = translateResponse(r, { localProvider: true });
    const tu = out.content.filter(b => b.type === 'tool_use');
    assert.equal(tu.length, 1, 'only the structured call, not the text ghost');
    assert.equal(tu[0].name, 'real');
  });

  await t.test('mixed text + recovered call: keeps the surrounding prose', () => {
    delete process.env[KEY];
    const out = translateResponse(
      resp('Sure, running it now.\n<tool_call>{"name":"run_bash","arguments":{"cmd":"ls"}}</tool_call>'),
      { localProvider: true }
    );
    const text = out.content.find(b => b.type === 'text');
    assert.ok(text && /running it now/.test(text.text));
    assert.ok(out.content.find(b => b.type === 'tool_use'));
  });
});
