// Follow-up fixes from the adversarial review of increment 0008:
//   P1.1  late-arriving streamed tool name (defer content_block_start until named)
//   P1.2  document block inside a tool_result must carry a marker (never silent drop)
//   P1.6  retry-exhaustion / non-200 upstream errors → canonical Anthropic envelope
//   P1.9  count_tokens mock body read is capped (via readCappedBody, tested in
//         security-defaults.test.mjs) — here we pin the helper used for messages.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStreamTranslator, translateRequest } from '../providers/openai.mjs';
import { extractUpstreamErrorMessage as proxyExtract } from '../proxy.mjs';

function collectBlocks(sse) {
  const blocks = new Map();
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let evt; try { evt = JSON.parse(line.slice(6)); } catch { continue; }
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

describe('P1.1 late-arriving streamed tool name', () => {
  it('still emits the correct name when the name chunk arrives after an args fragment', () => {
    const t = createStreamTranslator();
    let out = '';
    // First fragment for index 0 carries id + args but NO name
    out += t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"arguments":"{\\"path\\":"}}]}}]}\n\n');
    // Name arrives in a later chunk
    out += t.transform('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"\\"a.txt\\"}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');

    const tool = [...collectBlocks(out).values()].find(b => b.type === 'tool_use');
    assert.equal(tool.name, 'read_file', 'late name is captured, not dropped to empty');
    assert.deepEqual(JSON.parse(tool.json), { path: 'a.txt' }, 'buffered + later args both present, in order');
  });

  it('synthesizes a name (not empty) if the stream ends with the name never arriving', () => {
    const t = createStreamTranslator();
    let out = '';
    out += t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"arguments":"{}"}}]}}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    const tool = [...collectBlocks(out).values()].find(b => b.type === 'tool_use');
    assert.ok(tool && tool.name && tool.name.length > 0, 'no empty-name tool_use block escapes');
  });
});

describe('P1.2 document inside tool_result', () => {
  it('emits a [document omitted] marker instead of dropping it', () => {
    const out = translateRequest({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 't1',
        content: [{ type: 'text', text: 'see: ' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'X' } }],
      }] }],
    }).messages;
    const tool = out.find(m => m.role === 'tool');
    assert.equal(tool.content, 'see: [document omitted]');
  });
});

describe('P1.6 canonical envelope helpers', () => {
  it('extractUpstreamErrorMessage handles OpenAI/LM-Studio/bare shapes and rejects HTML', () => {
    assert.equal(proxyExtract('{"error":{"message":"rate limited"}}'), 'rate limited');
    assert.equal(proxyExtract('{"error":"insufficient quota"}'), 'insufficient quota');
    assert.equal(proxyExtract('plain text error'), 'plain text error');
    assert.equal(proxyExtract('<html>502 Bad Gateway</html>'), '');
    assert.equal(proxyExtract(''), '');
  });
});
