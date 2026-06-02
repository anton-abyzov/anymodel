// US-003 (0013): tool_result image/document blocks must never be silently dropped.
// Vision-capable backends forward the image; non-vision backends get a descriptive
// `[image omitted: N bytes, mime]` marker so the model knows a screenshot existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractToolResultParts, blocksToOpenAIContent, translateRequest, imageMarker, isVisionModel,
} from '../providers/openai.mjs';

const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(40) } };

test('US-003 — imageMarker is descriptive', () => {
  assert.match(imageMarker(PNG), /^\[image omitted: \d+ bytes, image\/png\]$/);
  assert.equal(imageMarker({ type: 'image', source: { type: 'url', url: 'http://x/a.png', media_type: 'image/png' } }),
    '[image omitted: image/png, http://x/a.png]');
  assert.equal(imageMarker({ type: 'image', source: {} }), '[image omitted]');
});

test('US-003 — isVisionModel heuristic + LOCAL_VISION override', (t) => {
  const KEY = 'LOCAL_VISION';
  const orig = process.env[KEY];
  t.after(() => { if (orig === undefined) delete process.env[KEY]; else process.env[KEY] = orig; });

  delete process.env[KEY]; // auto
  assert.equal(isVisionModel('qwen/qwen3-coder-30b'), false);
  assert.equal(isVisionModel('deepseek-coder-v2'), false);
  assert.equal(isVisionModel('qwen2-vl-7b'), true);
  assert.equal(isVisionModel('llava-1.6'), true);
  assert.equal(isVisionModel('google/gemma-4-26b'), true);
  process.env[KEY] = 'off';
  assert.equal(isVisionModel('qwen2-vl-7b'), false, 'off forces non-vision');
  process.env[KEY] = 'on';
  assert.equal(isVisionModel('qwen3-coder-30b'), true, 'on forces vision');
});

test('US-003 — tool_result image: non-vision → marker, no hoist', () => {
  const block = { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot:' }, PNG] };
  const { text, imageUrls } = extractToolResultParts(block, { visionCapable: false });
  assert.equal(imageUrls.length, 0, 'no image forwarded to a blind model');
  assert.match(text, /shot:\[image omitted: \d+ bytes, image\/png\]/);
});

test('US-003 — tool_result image: vision → forwarded as image_url', () => {
  const block = { type: 'tool_result', tool_use_id: 't1', content: [PNG] };
  const { imageUrls } = extractToolResultParts(block, { visionCapable: true });
  assert.equal(imageUrls.length, 1);
  assert.match(imageUrls[0], /^data:image\/png;base64,/);
});

test('US-003 — document block always gets a marker', () => {
  const block = { type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: {} }] };
  const { text } = extractToolResultParts(block, { visionCapable: true });
  assert.equal(text, '[document omitted]');
});

test('US-003 — is_error prefix still applied with image marker', () => {
  const block = { type: 'tool_result', tool_use_id: 't', is_error: true, content: [PNG] };
  const { text } = extractToolResultParts(block, { visionCapable: false });
  assert.match(text, /^\[tool_error\] \[image omitted:/);
});

test('US-003 — blocksToOpenAIContent: non-vision image → text marker, not parts array', () => {
  const out = blocksToOpenAIContent([{ type: 'text', text: 'see ' }, PNG], { visionCapable: false });
  assert.equal(typeof out, 'string', 'no image part emitted for non-vision');
  assert.match(out, /see \[image omitted: \d+ bytes, image\/png\]/);
});

test('US-003 — translateRequest threads visionCapable to a bare user image', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: [PNG] }] };
  const vis = translateRequest(body, { visionCapable: true });
  const nonVis = translateRequest(body, { visionCapable: false });
  // vision: array content with an image_url part
  const visUser = vis.messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(visUser.content) && visUser.content.some(p => p.type === 'image_url'));
  // non-vision: string marker
  const nvUser = nonVis.messages.find(m => m.role === 'user');
  assert.equal(typeof nvUser.content, 'string');
  assert.match(nvUser.content, /\[image omitted:/);
});
