// US-004 regression: a tool that legitimately has a parameter named `_unused`
// (or `_placeholder`) must survive a full request→response roundtrip with its
// value INTACT. Pre-fix, AnyModel's belt-and-suspenders stripping would silently
// delete any field named `_unused` from tool_use input — corrupting legitimate data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translateRequest, translateResponse, createStreamTranslator } from '../providers/openai.mjs';

describe('_unused param preservation (US-004)', () => {
  it('translateResponse preserves a real `_unused` field in tool_use input', () => {
    const openaiResp = {
      id: 'x', model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'c1',
            function: {
              name: 'weird_tool',
              arguments: '{"_unused":"this value matters","other":"x"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10 },
    };
    const result = translateResponse(openaiResp);
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse, 'must have tool_use block');
    assert.equal(toolUse.input._unused, 'this value matters',
      'a real _unused param must survive; AnyModel must not strip it');
    assert.equal(toolUse.input.other, 'x');
  });

  it('translateResponse preserves a real `_placeholder` field', () => {
    const openaiResp = {
      id: 'x', model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'c2',
            function: {
              name: 't',
              arguments: '{"_placeholder":"keep me","real":"yes"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const result = translateResponse(openaiResp);
    const tu = result.content.find(b => b.type === 'tool_use');
    assert.equal(tu.input._placeholder, 'keep me');
    assert.equal(tu.input.real, 'yes');
  });

  it('stream translator preserves real _unused in streamed tool arguments', () => {
    const t = createStreamTranslator();
    const chunks = [
      'data: {"id":"1","model":"x","choices":[{"delta":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"t"}}]}}]}\n\n',
      'data: {"id":"1","model":"x","choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"_unused\\":\\"keep this\\",\\"other\\":\\"ok\\"}"}}]}}]}\n\n',
      'data: {"id":"1","model":"x","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const out = chunks.map(c => t.transform(c)).join('');
    // The streamed input_json_delta must carry the _unused field
    assert.ok(out.includes('_unused'),
      'stream translator must NOT strip real _unused values (no silent data corruption)');
    assert.ok(out.includes('keep this'),
      'the _unused value must be preserved end-to-end');
  });

  it('translateRequest no longer injects _unused placeholder for empty tool schemas', () => {
    const body = {
      model: 'gpt-4o',
      max_tokens: 100,
      tools: [{
        name: 'simple_tool',
        description: 'does a thing',
        // Empty properties — used to trigger _unused injection in 1.11 and earlier
        input_schema: { type: 'object', properties: {} },
      }],
      messages: [{ role: 'user', content: 'test' }],
    };
    const out = translateRequest(body);
    assert.ok(out.tools, 'tools forwarded');
    const params = out.tools[0].function.parameters;
    assert.ok(!params.properties || !('_unused' in (params.properties || {})),
      'empty-schema fallback must NOT inject _unused into properties');
    // Must still be a valid JSON Schema object
    assert.equal(params.type, 'object');
  });
});
