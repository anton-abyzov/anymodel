// US-006 regression: `usage.output_tokens` must be forwarded in the final
// `message_delta` SSE event. OpenAI-compat streams typically emit usage in a
// dedicated chunk AFTER finish_reason, not in the finish_reason chunk itself.
// Pre-fix: we pulled usage only from the finish_reason chunk → always 0.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamTranslator } from '../providers/openai.mjs';

function runStream(translator, chunks) {
  return chunks.map(c => translator.transform(c)).join('');
}

function extractMessageDelta(sseOutput) {
  // Find the last `data: {type:"message_delta" ...}` line
  const lines = sseOutput.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('data: ')) {
      try {
        const obj = JSON.parse(lines[i].slice(6));
        if (obj.type === 'message_delta') return obj;
      } catch {}
    }
  }
  return null;
}

describe('createStreamTranslator — usage.output_tokens forwarding (US-006)', () => {
  it('forwards output_tokens when usage arrives in a separate chunk AFTER finish_reason', () => {
    const t = createStreamTranslator();
    // Simulates LMStudio / OpenAI streaming: content chunks, then finish_reason,
    // then a dedicated usage chunk (no choices.delta), then [DONE]
    const chunks = [
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      // Separate usage-only chunk — this is where the real token count lives
      'data: {"id":"1","model":"qwen","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":42,"total_tokens":47}}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = runStream(t, chunks);
    const md = extractMessageDelta(out);
    assert.ok(md, 'must emit a message_delta event');
    assert.equal(md.usage.output_tokens, 42, 'output_tokens must match upstream completion_tokens (42), not 0');
  });

  it('forwards output_tokens when usage is embedded in the finish_reason chunk', () => {
    const t = createStreamTranslator();
    const chunks = [
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      // Some streams include usage in the finish_reason chunk directly
      'data: {"id":"1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":17}}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = runStream(t, chunks);
    const md = extractMessageDelta(out);
    assert.ok(md);
    assert.equal(md.usage.output_tokens, 17);
  });

  it('handles upstream that never emits usage (remains 0, does NOT throw)', () => {
    const t = createStreamTranslator();
    const chunks = [
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = runStream(t, chunks);
    const md = extractMessageDelta(out);
    assert.ok(md);
    assert.equal(md.usage.output_tokens, 0);
  });

  it('emits only one final message_delta (not two) even when both finish_reason chunk and [DONE] arrive', () => {
    const t = createStreamTranslator();
    const chunks = [
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":"X"}}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[],"usage":{"completion_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = runStream(t, chunks);
    const count = (out.match(/"type":"message_delta"/g) || []).length;
    assert.equal(count, 1, 'must emit exactly one message_delta');
  });

  it('preserves correct stop_reason (not always end_turn)', () => {
    const t = createStreamTranslator();
    const chunks = [
      'data: {"id":"1","model":"qwen","choices":[{"delta":{"content":"X"}}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      'data: {"id":"1","model":"qwen","choices":[],"usage":{"completion_tokens":99}}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = runStream(t, chunks);
    const md = extractMessageDelta(out);
    assert.equal(md.delta.stop_reason, 'max_tokens');
    assert.equal(md.usage.output_tokens, 99);
  });
});
