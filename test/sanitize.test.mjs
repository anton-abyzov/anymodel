import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody, sanitizeToolUseResponse, injectPlatformHints } from '../proxy.mjs';

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
    // Tool fields stripped, empty schema normalized (1.12.0 uses additionalProperties:false
    // instead of _unused placeholder injection — see US-004)
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

  // US-004 (1.12.0+): empty-schema handling uses additionalProperties:false
  // instead of injecting a _unused placeholder property. Real tool params named
  // `_unused` now survive end-to-end unchanged.
  it('normalizes empty tool properties to additionalProperties:false', () => {
    const body = {
      tools: [{
        name: 'no_params',
        input_schema: { type: 'object', properties: {} },
      }],
    };
    const result = sanitizeBody(body);
    const schema = result.tools[0].input_schema;
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.properties, {}, 'properties stays empty — no _unused injection');
    assert.equal(schema.additionalProperties, false, 'marks schema as closed via additionalProperties:false');
    assert.deepEqual(schema.required, []);
  });

  it('normalizes missing input_schema to valid empty object form', () => {
    const body = { tools: [{ name: 'bare' }] };
    const result = sanitizeBody(body);
    assert.equal(result.tools[0].input_schema.type, 'object');
    assert.deepEqual(result.tools[0].input_schema.properties, {});
    assert.equal(result.tools[0].input_schema.additionalProperties, false);
  });

  it('fixes nested empty object properties recursively without injecting _unused', () => {
    const body = {
      tools: [{
        name: 'nested',
        input_schema: {
          type: 'object',
          properties: {
            config: { type: 'object', properties: {} },
          },
        },
      }],
    };
    const result = sanitizeBody(body);
    const configSchema = result.tools[0].input_schema.properties.config;
    assert.deepEqual(configSchema.properties, {}, 'nested empty properties stays empty');
    assert.equal(configSchema.additionalProperties, false, 'nested empty schema gets additionalProperties:false');
  });
});

describe('sanitizeToolUseResponse', () => {
  // US-004 (1.12.0+): we no longer inject _unused/_placeholder, so we no longer
  // strip them. Real params named `_unused` survive unchanged.
  it('PRESERVES _unused and _placeholder fields in tool_use inputs (US-004)', () => {
    const resp = {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts', _unused: 'real value', _placeholder: 'also real' } },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.equal(resp.content[0].input._unused, 'real value',
      '_unused is now preserved as legitimate user data');
    assert.equal(resp.content[0].input._placeholder, 'also real');
    assert.equal(resp.content[0].input.file_path, '/a.ts');
  });

  it('PRESERVES _unused fields in nested objects (US-004)', () => {
    const resp = {
      content: [
        {
          type: 'tool_use', id: 'toolu_1', name: 'TeamCreate',
          input: {
            name: 'test-team',
            config: { _unused: 'nested real value' },
            _unused: 'top-level real value',
          },
        },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.equal(resp.content[0].input._unused, 'top-level real value');
    assert.equal(resp.content[0].input.config._unused, 'nested real value');
    assert.equal(resp.content[0].input.name, 'test-team');
  });

  it('drops tool_use blocks with no name', () => {
    const resp = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'toolu_1', name: '', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.equal(resp.content.length, 2);
    assert.equal(resp.content[0].type, 'text');
    assert.equal(resp.content[1].name, 'Read');
  });

  it('generates id when missing', () => {
    const resp = {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.ok(resp.content[0].id.startsWith('toolu_'));
  });

  it('defaults input to empty object when missing or non-object', () => {
    const resp = {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: null },
        { type: 'tool_use', id: 'toolu_2', name: 'Read' },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.deepEqual(resp.content[0].input, {});
    assert.deepEqual(resp.content[1].input, {});
  });

  it('passes through non-tool_use blocks untouched', () => {
    const resp = {
      content: [
        { type: 'text', text: 'hello' },
      ],
    };
    sanitizeToolUseResponse(resp);
    assert.equal(resp.content[0].text, 'hello');
  });

  it('handles missing or non-array content', () => {
    assert.deepEqual(sanitizeToolUseResponse({}), {});
    assert.deepEqual(sanitizeToolUseResponse({ content: 'text' }), { content: 'text' });
    assert.deepEqual(sanitizeToolUseResponse(null), null);
  });
});

describe('injectPlatformHints', () => {
  it('appends hint to array system prompt on win32', () => {
    const parsed = {
      system: [{ type: 'text', text: 'You are helpful' }],
    };
    injectPlatformHints(parsed, 'win32');
    assert.equal(parsed.system.length, 2);
    assert.ok(parsed.system[1].text.includes('Windows'));
    assert.equal(parsed.system[1].type, 'text');
  });

  it('appends hint to string system prompt on win32', () => {
    const parsed = { system: 'You are helpful' };
    injectPlatformHints(parsed, 'win32');
    assert.ok(parsed.system.includes('Windows'));
    assert.ok(parsed.system.startsWith('You are helpful\n'));
  });

  it('no-op on non-win32 platforms', () => {
    const parsed = {
      system: [{ type: 'text', text: 'You are helpful' }],
    };
    injectPlatformHints(parsed, 'darwin');
    assert.equal(parsed.system.length, 1);

    const parsed2 = { system: 'You are helpful' };
    injectPlatformHints(parsed2, 'linux');
    assert.equal(parsed2.system, 'You are helpful');
  });

  it('no-op when system is missing or undefined', () => {
    const parsed = { messages: [] };
    injectPlatformHints(parsed, 'win32');
    assert.equal(parsed.system, undefined);

    const parsed2 = {};
    injectPlatformHints(parsed2, 'win32');
    assert.equal(parsed2.system, undefined);
  });

  it('appends to empty array system prompt', () => {
    const parsed = { system: [] };
    injectPlatformHints(parsed, 'win32');
    assert.equal(parsed.system.length, 1);
    assert.ok(parsed.system[0].text.includes('Windows'));
  });
});
