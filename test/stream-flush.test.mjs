// P0.1: createStreamTranslator.flush() must finalize the Anthropic stream when
// the upstream closes WITHOUT a `data: [DONE]` sentinel (LM Studio/MLX, llama.cpp,
// vLLM frequently do this). Without flush() the client never sees message_stop and
// the agentic loop hangs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamTranslator } from '../providers/openai.mjs';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
function feed(tr, ...chunks) { let out = ''; for (const c of chunks) out += tr.transform(c); return out; }

test('P0.1 — flush finalizes stream without [DONE]', async (t) => {
  await t.test('text stream closed without [DONE]: flush emits content_block_stop + message_delta + message_stop', () => {
    const tr = createStreamTranslator();
    const body = feed(tr,
      sse({ id: 'x', model: 'm', choices: [{ delta: { content: 'Hello' } }] }),
      sse({ choices: [{ delta: { content: ' world' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      // NOTE: no [DONE] — server just closed the socket
    );
    // Before flush, the stop must NOT have been committed.
    assert.doesNotMatch(body, /message_stop/);
    const tail = tr.flush();
    assert.match(tail, /content_block_stop/);
    assert.match(tail, /message_delta/);
    assert.match(tail, /message_stop/);
    assert.match(tail, /"stop_reason":"end_turn"/);
  });

  await t.test('flush is idempotent when [DONE] already arrived (no double stop)', () => {
    const tr = createStreamTranslator();
    const body = feed(tr,
      sse({ id: 'x', model: 'm', choices: [{ delta: { content: 'Hi' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    );
    assert.match(body, /message_stop/);
    const tail = tr.flush();           // must be a no-op
    assert.doesNotMatch(tail, /message_stop/);
    assert.strictEqual(tail, '');
  });

  await t.test('flush preserves tool_use stop_reason when finish_reason was tool_calls', () => {
    const tr = createStreamTranslator();
    feed(tr,
      sse({ id: 'x', model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'run_bash', arguments: '' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      // no [DONE]
    );
    const tail = tr.flush();
    assert.match(tail, /"stop_reason":"tool_use"/);
    assert.match(tail, /message_stop/);
  });
});
