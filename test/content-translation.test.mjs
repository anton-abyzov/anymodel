// P1.2 (image/document translation) + P1.3 (tool_result.is_error marker).
// Both exercised through translateRequest, which is shared by openai-local
// (LM Studio / llama.cpp) and ollama.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { translateRequest, blocksToOpenAIContent } from '../providers/openai.mjs';

const msg = (content) => translateRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content }] }).messages;

describe('P1.2 image/document content translation', () => {
  it('translates a base64 image to an OpenAI image_url data URI', () => {
    const out = msg([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
    const user = out.find(m => m.role === 'user');
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0].type, 'image_url');
    assert.equal(user.content[0].image_url.url, 'data:image/png;base64,AAAA');
  });

  it('translates a url image source verbatim', () => {
    const out = msg([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
    const user = out.find(m => m.role === 'user');
    assert.equal(user.content[0].image_url.url, 'https://x/y.png');
  });

  it('keeps mixed text+image as an ordered parts array', () => {
    const out = msg([
      { type: 'text', text: 'look:' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Z' } },
    ]);
    const user = out.find(m => m.role === 'user');
    assert.deepEqual(user.content.map(p => p.type), ['text', 'image_url']);
    assert.equal(user.content[0].text, 'look:');
  });

  it('hoists an image inside a tool_result into a following user message', () => {
    const out = translateRequest({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'tu_1',
        content: [{ type: 'text', text: 'screenshot:' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMG' } }],
      }] }],
    }).messages;
    const tool = out.find(m => m.role === 'tool');
    assert.equal(tool.content, 'screenshot:');
    const user = out.find(m => m.role === 'user');
    assert.equal(user.content[0].image_url.url, 'data:image/png;base64,IMG');
  });

  it('substitutes a visible marker for documents (no silent drop)', () => {
    const out = msg([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'PDF' } }]);
    const user = out.find(m => m.role === 'user');
    assert.equal(user.content, '[document omitted]');
  });

  it('substitutes [image omitted] when the source is unresolvable', () => {
    const out = msg([{ type: 'image', source: { type: 'weird' } }]);
    assert.equal(out.find(m => m.role === 'user').content, '[image omitted]');
  });

  it('keeps a text-only turn as a plain string (byte-stable, no array regression)', () => {
    const out = msg([{ type: 'text', text: 'hello' }]);
    assert.equal(out.find(m => m.role === 'user').content, 'hello');
    assert.equal(typeof blocksToOpenAIContent([{ type: 'text', text: 'x' }]), 'string');
  });
});

describe('P1.3 tool_result.is_error preservation', () => {
  const toolResult = (block) => translateRequest({
    model: 'm', max_tokens: 10,
    messages: [{ role: 'user', content: [block] }],
  }).messages.find(m => m.role === 'tool');

  it('prefixes [tool_error] for a failed string tool_result', () => {
    const tool = toolResult({ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'command not found' });
    assert.equal(tool.content, '[tool_error] command not found');
  });

  it('prefixes [tool_error] for a failed array tool_result', () => {
    const tool = toolResult({ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'exit 1' }] });
    assert.equal(tool.content, '[tool_error] exit 1');
  });

  it('does not add the marker for a successful tool_result', () => {
    const tool = toolResult({ type: 'tool_result', tool_use_id: 't1', content: 'ok' });
    assert.equal(tool.content, 'ok');
  });
});
