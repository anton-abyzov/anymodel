// Tier 2 (T-013): streaming input_tokens (P2.1) + malformed-arg observability
// (P2.4) + tool_use id uniqueness (P2.7).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStreamTranslator, translateResponse } from '../providers/openai.mjs';
import { sanitizeToolUseResponse } from '../proxy.mjs';

describe('P2.1 streaming input_tokens', () => {
  it('forwards prompt_tokens as input_tokens in message_delta', () => {
    const t = createStreamTranslator();
    let out = t.transform('data: {"id":"c","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n');
    // dedicated usage chunk after finish (LM Studio shape)
    out += t.transform('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":321,"completion_tokens":12}}\n\n');
    out += t.transform('data: [DONE]\n\n');
    assert.ok(out.includes('"input_tokens":321'), 'input_tokens populated, not 0');
    assert.ok(out.includes('"output_tokens":12'));
  });
});

describe('P2.4 malformed tool-arg observability', () => {
  it('still emits the named tool_use with input:{} on unparseable args', () => {
    const r = translateResponse({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path": "a' } }] }, finish_reason: 'tool_calls' }],
    });
    const tu = r.content.find(b => b.type === 'tool_use');
    assert.equal(tu.name, 'read_file');
    assert.deepEqual(tu.input, {});
  });
});

describe('P2.7 unique synthesized tool_use ids', () => {
  it('assigns collision-free ids to id-less tool_use blocks', () => {
    const resp = { content: [
      { type: 'tool_use', name: 'a', input: {} },
      { type: 'tool_use', name: 'b', input: {} },
    ] };
    sanitizeToolUseResponse(resp);
    const [id1, id2] = resp.content.map(b => b.id);
    assert.ok(id1 && id2 && id1 !== id2, 'parallel id-less tool calls get distinct ids');
    assert.ok(id1.startsWith('toolu_'));
  });
});
