// P1.4 (sampling parity: top_p / stop_sequences / max_output_tokens) and
// P1.5 (unified finish_reason map; content_filter → refusal).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { translateRequest, translateResponse, mapFinishReason, createStreamTranslator } from '../providers/openai.mjs';
import ollama from '../providers/ollama.mjs';

describe('P1.4 sampling parity (openai)', () => {
  it('forwards top_p', () => {
    const b = translateRequest({ model: 'm', max_tokens: 10, top_p: 0.9, messages: [] });
    assert.equal(b.top_p, 0.9);
  });

  it('maps stop_sequences → stop', () => {
    const b = translateRequest({ model: 'm', max_tokens: 10, stop_sequences: ['\nObservation', 'END'], messages: [] });
    assert.deepEqual(b.stop, ['\nObservation', 'END']);
  });

  it('does not set stop for an empty stop_sequences array', () => {
    const b = translateRequest({ model: 'm', max_tokens: 10, stop_sequences: [], messages: [] });
    assert.equal('stop' in b, false);
  });

  it('falls back max_tokens ← max_output_tokens when max_tokens is absent', () => {
    const b = translateRequest({ model: 'm', max_output_tokens: 256, messages: [] });
    assert.equal(b.max_tokens, 256);
  });

  it('prefers max_tokens when both are present', () => {
    const b = translateRequest({ model: 'm', max_tokens: 128, max_output_tokens: 256, messages: [] });
    assert.equal(b.max_tokens, 128);
  });
});

describe('P1.4 sampling parity (ollama mirror)', () => {
  it('mirrors top_p and stop into ollama options', () => {
    const b = ollama.transformRequest({ model: 'm', max_tokens: 10, top_p: 0.8, stop_sequences: ['X'], messages: [] });
    assert.equal(b.options.top_p, 0.8);
    assert.deepEqual(b.options.stop, ['X']);
  });
});

describe('P1.5 finish_reason unification', () => {
  it('maps content_filter → refusal (not end_turn)', () => {
    assert.equal(mapFinishReason('content_filter'), 'refusal');
  });

  it('maps the standard reasons', () => {
    assert.equal(mapFinishReason('tool_calls'), 'tool_use');
    assert.equal(mapFinishReason('length'), 'max_tokens');
    assert.equal(mapFinishReason('stop'), 'end_turn');
    assert.equal(mapFinishReason('anything_else'), 'end_turn');
  });

  it('non-streaming response uses refusal for content_filter', () => {
    const r = translateResponse({ choices: [{ message: { content: 'blocked' }, finish_reason: 'content_filter' }] });
    assert.equal(r.stop_reason, 'refusal');
  });

  it('streaming agrees with non-streaming for content_filter', () => {
    const t = createStreamTranslator();
    let out = t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"content":"x"}}]}\n\n');
    out += t.transform('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n');
    out += t.transform('data: [DONE]\n\n');
    assert.ok(out.includes('"stop_reason":"refusal"'));
  });
});
