// 1.15.0 — attached-image support on the two paths that previously dropped images:
//   (1) Anthropic /v1/messages → Ollama native /api/chat (needs message.images
//       base64 array, NOT OpenAI image_url parts)
//   (2) OpenAI /v1/responses → local Chat Completions (input_image must become a
//       Chat image_url part, not be flattened to text)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ollamaProvider, { toOllamaNativeMessages, dataUriToBase64 } from '../providers/ollama.mjs';
import { responsesToChat, responsesContentToChatParts } from '../providers/responses.mjs';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAA';
const PNG_B64 = 'iVBORw0KGgoAAAA';

describe('Ollama native image translation', () => {
  it('strips the data: prefix to raw base64', () => {
    assert.equal(dataUriToBase64(PNG_DATA_URI), PNG_B64);
    assert.equal(dataUriToBase64('https://x/y.png'), null);
    assert.equal(dataUriToBase64(undefined), null);
  });

  it('hoists a base64 image into message.images with content as a plain string', () => {
    const out = toOllamaNativeMessages([
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: PNG_DATA_URI } },
      ] },
    ]);
    assert.equal(out[0].content, 'what is this?');
    assert.deepEqual(out[0].images, [PNG_B64]);
  });

  it('leaves a text-only message untouched (no images field)', () => {
    const out = toOllamaNativeMessages([{ role: 'user', content: 'plain' }]);
    assert.equal(out[0].content, 'plain');
    assert.equal(out[0].images, undefined);
  });

  it('marks a URL image visibly instead of silently dropping it (native takes base64 only)', () => {
    const out = toOllamaNativeMessages([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
    ]);
    assert.equal(out[0].images, undefined);
    assert.match(out[0].content, /https:\/\/x\/y\.png/);
  });

  it('end-to-end: transformRequest carries an attached image into the native body', () => {
    const body = ollamaProvider.transformRequest({
      model: 'llava', max_tokens: 64,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      ] }],
    });
    const user = body.messages.find(m => m.role === 'user');
    assert.equal(user.content, 'describe');
    assert.deepEqual(user.images, [PNG_B64]);
  });
});

describe('Responses input_image → Chat Completions image_url', () => {
  it('keeps a text-only content as a plain string (byte-stable)', () => {
    assert.equal(responsesContentToChatParts([{ type: 'input_text', text: 'hi' }]), 'hi');
    assert.equal(responsesContentToChatParts('hi'), 'hi');
  });

  it('converts input_image (string image_url) to a Chat image_url object part', () => {
    const parts = responsesContentToChatParts([
      { type: 'input_text', text: 'look:' },
      { type: 'input_image', image_url: PNG_DATA_URI, detail: 'high' },
    ]);
    assert.ok(Array.isArray(parts));
    assert.deepEqual(parts[0], { type: 'text', text: 'look:' });
    assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: PNG_DATA_URI, detail: 'high' } });
  });

  it('drops the Responses-only detail "original" (Chat rejects it)', () => {
    const parts = responsesContentToChatParts([{ type: 'input_image', image_url: PNG_DATA_URI, detail: 'original' }]);
    assert.deepEqual(parts[0], { type: 'image_url', image_url: { url: PNG_DATA_URI } });
  });

  it('marks a file_id-only image instead of silently dropping it', () => {
    const parts = responsesContentToChatParts([{ type: 'input_image', file_id: 'file-abc' }]);
    assert.equal(parts, '[image file file-abc omitted — local server can\'t fetch uploaded files]');
  });

  it('responsesToChat: a user message image reaches the chat body as a vision part', () => {
    const { chat } = responsesToChat({
      model: 'qwen-vl',
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'what is in this image?' },
        { type: 'input_image', image_url: PNG_DATA_URI },
      ] }],
    });
    const user = chat.messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[1].type, 'image_url');
    assert.equal(user.content[1].image_url.url, PNG_DATA_URI);
  });

  it('hoists a tool-result image into a following user turn (tool role is text-only)', () => {
    const { chat } = responsesToChat({
      model: 'qwen-vl',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'screenshot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: [
          { type: 'output_text', text: 'captured:' },
          { type: 'input_image', image_url: PNG_DATA_URI },
        ] },
      ],
    });
    const tool = chat.messages.find(m => m.role === 'tool');
    assert.equal(tool.content, 'captured:');
    const user = chat.messages.find(m => m.role === 'user');
    assert.equal(user.content[0].image_url.url, PNG_DATA_URI);
  });
});
