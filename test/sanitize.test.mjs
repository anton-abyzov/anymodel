import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody } from '../proxy.mjs';

describe('sanitizeBody', () => {
  it('strips top-level Anthropic-specific fields', () => {
    const body = {
      model: 'claude-3-opus',
      messages: [],
      betas: ['beta1'],
      metadata: { user_id: '123' },
      speed: 'fast',
      output_config: { format: 'json' },
      context_management: { enabled: true },
      thinking: { type: 'enabled', budget_tokens: 5000 },
    };
    const result = sanitizeBody(body);
    assert.equal(result.betas, undefined);
    assert.equal(result.metadata, undefined);
    assert.equal(result.speed, undefined);
    assert.equal(result.output_config, undefined);
    assert.equal(result.context_management, undefined);
    // thinking is preserved for reasoning models (DeepSeek R1, etc.)
    assert.deepEqual(result.thinking, { type: 'enabled', budget_tokens: 5000 });
    // Preserves non-Anthropic fields
    assert.equal(result.model, 'claude-3-opus');
    assert.deepEqual(result.messages, []);
  });

  it('strips cache_control from system blocks', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are helpful', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Be concise' },
      ],
    };
    const result = sanitizeBody(body);
    assert.deepEqual(result.system, [
      { type: 'text', text: 'You are helpful' },
      { type: 'text', text: 'Be concise' },
    ]);
  });

  it('strips cache_control from message content blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'World' },
          ],
        },
      ],
    };
    const result = sanitizeBody(body);
    assert.deepEqual(result.messages[0].content, [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ]);
  });

  it('handles messages with string content (no-op)', () => {
    const body = {
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const result = sanitizeBody(body);
    assert.equal(result.messages[0].content, 'Hello');
  });

  it('strips Anthropic-only tool fields', () => {
    const body = {
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
          defer_loading: true,
          eager_input_streaming: true,
          strict: true,
        },
      ],
    };
    const result = sanitizeBody(body);
    // Tool fields stripped, empty properties gets _unused placeholder
    assert.equal(result.tools[0].cache_control, undefined);
    assert.equal(result.tools[0].defer_loading, undefined);
    assert.equal(result.tools[0].name, 'get_weather');
    assert.equal(result.tools[0].input_schema.type, 'object');
  });

  it('normalizes tool_choice string to object', () => {
    const body = { tool_choice: 'auto' };
    const result = sanitizeBody(body);
    assert.deepEqual(result.tool_choice, { type: 'auto' });
  });

  it('preserves tool_choice when already an object', () => {
    const body = { tool_choice: { type: 'tool', name: 'get_weather' } };
    const result = sanitizeBody(body);
    assert.deepEqual(result.tool_choice, { type: 'tool', name: 'get_weather' });
  });

  it('handles empty body gracefully', () => {
    const result = sanitizeBody({});
    assert.deepEqual(result, {});
  });

  it('handles body with no system/messages/tools', () => {
    const body = { model: 'test', max_tokens: 100 };
    const result = sanitizeBody(body);
    assert.equal(result.model, 'test');
    assert.equal(result.max_tokens, 100);
  });

  it('handles null content blocks without throwing', () => {
    const body = {
      system: [null, { type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [null, { type: 'text', text: 'hi' }] },
      ],
    };
    const result = sanitizeBody(body);
    assert.equal(result.system[0], null);
    assert.deepEqual(result.system[1], { type: 'text', text: 'ok' });
    assert.equal(result.messages[0].content[0], null);
    assert.deepEqual(result.messages[0].content[1], { type: 'text', text: 'hi' });
  });

  it('preserves tool_choice when null or undefined', () => {
    assert.deepEqual(sanitizeBody({ tool_choice: null }), { tool_choice: null });
    assert.deepEqual(sanitizeBody({}), {});
  });
});
