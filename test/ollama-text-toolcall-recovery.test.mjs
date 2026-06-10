// 0018: text-channel tool-call recovery + tool-call echo normalization for the
// NATIVE Ollama wire (providers/ollama.mjs) — parity with openai.mjs. Found via
// the AnyModel-vs-OpenCode benchmark: qwen3-coder:30b over /api/chat parks calls
// in the text channel (<function=X><parameter=k>v</parameter></function>), and
// assistant tool_call echoes with STRING arguments 400 the next native request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ollama, { toOllamaNativeMessages } from '../providers/ollama.mjs';

const QWEN_XML = '<function=Write>\n<parameter=file_path>\ngreeting.txt\n</parameter>\n<parameter=content>\nHELLO BENCH\n</parameter>\n</function>\n</tool_call>';

function nativeResp(content, extra = {}) {
  return {
    model: 'qwen3-coder:30b',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 100,
    eval_count: 30,
    ...extra,
  };
}

function collectSSE(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const ev = /event: (\S+)/.exec(block)?.[1];
    const data = /data: (.*)/.exec(block)?.[1];
    if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
  }
  return events;
}

test('ollama non-streaming — Qwen-XML text tool call recovers to tool_use', () => {
  const out = ollama.transformResponse(nativeResp(QWEN_XML), null);
  const toolUse = out.content.filter(b => b.type === 'tool_use');
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0].name, 'Write');
  assert.equal(toolUse[0].input.file_path, 'greeting.txt');
  assert.equal(toolUse[0].input.content, 'HELLO BENCH');
  assert.equal(out.stop_reason, 'tool_use');
  // dangling </tool_call> must not survive as visible prose
  const text = out.content.find(b => b.type === 'text');
  if (text) assert.ok(!text.text.includes('<function='));
});

test('ollama non-streaming — plain prose is untouched', () => {
  const out = ollama.transformResponse(nativeResp('Just an answer, no tools.'), null);
  assert.equal(out.content.filter(b => b.type === 'tool_use').length, 0);
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(out.content[0].text, 'Just an answer, no tools.');
});

test('ollama non-streaming — structured tool_calls win; text channel not re-parsed', () => {
  const resp = nativeResp('ignored prose', {});
  resp.message.tool_calls = [{ id: 't1', function: { name: 'Read', arguments: { file_path: 'a.txt' } } }];
  const out = ollama.transformResponse(resp, null);
  const tools = out.content.filter(b => b.type === 'tool_use');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
});

test('ollama streaming — buffered text recovers Qwen-XML call at done', () => {
  const tr = ollama.createStreamTranslator(null);
  let raw = '';
  // emission split across chunks mid-tag to prove buffering works
  raw += tr.transform(JSON.stringify({ model: 'q', message: { content: QWEN_XML.slice(0, 40) }, done: false }) + '\n');
  raw += tr.transform(JSON.stringify({ model: 'q', message: { content: QWEN_XML.slice(40) }, done: false }) + '\n');
  raw += tr.transform(JSON.stringify({ model: 'q', message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 20 }) + '\n');
  const events = collectSSE(raw);
  const starts = events.filter(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.content_block.name, 'Write');
  const deltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta');
  const input = JSON.parse(deltas.map(d => d.data.delta.partial_json).join(''));
  assert.equal(input.file_path, 'greeting.txt');
  const stop = events.find(e => e.event === 'message_delta');
  assert.equal(stop.data.delta.stop_reason, 'tool_use');
  assert.ok(events.some(e => e.event === 'message_stop'));
});

test('ollama streaming — structured tool_calls still translate; no recovery double-fire', () => {
  const tr = ollama.createStreamTranslator(null);
  let raw = '';
  raw += tr.transform(JSON.stringify({ model: 'q', message: { tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: { command: 'ls' } } }] }, done: false }) + '\n');
  raw += tr.transform(JSON.stringify({ model: 'q', message: { content: '' }, done: true, done_reason: 'stop' }) + '\n');
  const events = collectSSE(raw);
  const starts = events.filter(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.content_block.name, 'Bash');
  assert.equal(events.find(e => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('ollama streaming — flush() without done:true still emits message_stop (P0.1 parity)', () => {
  const tr = ollama.createStreamTranslator(null);
  let raw = tr.transform(JSON.stringify({ model: 'q', message: { content: 'partial answer' }, done: false }) + '\n');
  raw += tr.flush();
  const events = collectSSE(raw);
  assert.ok(events.some(e => e.event === 'message_stop'), 'message_stop missing after flush');
  // buffered text must not be lost
  const textDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta');
  assert.equal(textDelta.data.delta.text, 'partial answer');
});

test('ollama streaming — flush() recovers a parked text tool call when stream dies', () => {
  const tr = ollama.createStreamTranslator(null);
  let raw = tr.transform(JSON.stringify({ model: 'q', message: { content: QWEN_XML }, done: false }) + '\n');
  raw += tr.flush();
  const events = collectSSE(raw);
  const starts = events.filter(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.content_block.name, 'Write');
});

test('toOllamaNativeMessages — assistant tool_call STRING arguments parse to objects', () => {
  const msgs = toOllamaNativeMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"file_path":"config.json"}' } }] },
  ]);
  assert.deepEqual(msgs[0].tool_calls[0].function.arguments, { file_path: 'config.json' });
});

test('toOllamaNativeMessages — truncated/unparseable string arguments fall back to {}', () => {
  const msgs = toOllamaNativeMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"file_path":"conf' } }] },
  ]);
  assert.deepEqual(msgs[0].tool_calls[0].function.arguments, {});
});

test('toOllamaNativeMessages — object arguments pass through; content arrays still collapse', () => {
  const msgs = toOllamaNativeMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }], tool_calls: [{ id: 't1', function: { name: 'Bash', arguments: { command: 'ls' } } }] },
  ]);
  assert.equal(msgs[0].content, 'hi');
  assert.deepEqual(msgs[0].tool_calls[0].function.arguments, { command: 'ls' });
});
