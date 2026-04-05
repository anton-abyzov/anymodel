import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateRequest,
  translateResponse,
  createStreamTranslator,
} from '../providers/openai.mjs';

// ── translateRequest ────────────────────────────────────

describe('translateRequest', () => {
  it('translates basic model, max_tokens, and stream', () => {
    const result = translateRequest({ model: 'gpt-4o', max_tokens: 1024, stream: true });
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.max_tokens, 1024);
    assert.equal(result.stream, true);
  });

  it('defaults stream to false', () => {
    const result = translateRequest({ model: 'gpt-4o', max_tokens: 100 });
    assert.equal(result.stream, false);
  });

  it('translates string system message', () => {
    const result = translateRequest({ model: 'x', system: 'You are helpful' });
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[0].content, 'You are helpful');
  });

  it('translates array system blocks', () => {
    const result = translateRequest({
      model: 'x',
      system: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    });
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[0].content, 'First\nSecond');
  });

  it('translates simple user string message', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Hello');
  });

  it('translates user message with content blocks', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
      }],
    });
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Hello world');
  });

  it('translates assistant message with text blocks', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Sure thing' }],
      }],
    });
    assert.equal(result.messages[0].role, 'assistant');
    assert.equal(result.messages[0].content, 'Sure thing');
  });

  it('translates assistant message with tool_use blocks', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } },
        ],
      }],
    });
    const msg = result.messages[0];
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'Calling tool');
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].id, 'call_1');
    assert.equal(msg.tool_calls[0].type, 'function');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    assert.equal(msg.tool_calls[0].function.arguments, '{"city":"NYC"}');
  });

  it('translates tool_result blocks into tool role messages', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 72F' },
        ],
      }],
    });
    assert.equal(result.messages[0].role, 'tool');
    assert.equal(result.messages[0].tool_call_id, 'call_1');
    assert.equal(result.messages[0].content, 'Sunny, 72F');
  });

  it('translates tool_result with array content', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
          },
        ],
      }],
    });
    assert.equal(result.messages[0].content, 'Part 1Part 2');
  });

  it('translates mixed tool_result and text blocks in a user message', () => {
    const result = translateRequest({
      model: 'x',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Result' },
          { type: 'text', text: 'Follow-up question' },
        ],
      }],
    });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'tool');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, 'Follow-up question');
  });

  it('translates Anthropic tools to OpenAI function format', () => {
    const result = translateRequest({
      model: 'x',
      tools: [{
        name: 'get_weather',
        description: 'Get weather info',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    });
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].type, 'function');
    assert.equal(result.tools[0].function.name, 'get_weather');
    assert.equal(result.tools[0].function.description, 'Get weather info');
    assert.deepEqual(result.tools[0].function.parameters, {
      type: 'object',
      properties: { city: { type: 'string' } },
    });
  });

  it('uses _unused (not _placeholder) for empty properties', () => {
    const result = translateRequest({
      model: 'x',
      tools: [{
        name: 'no_params',
        input_schema: { type: 'object', properties: {} },
      }],
    });
    const params = result.tools[0].function.parameters;
    assert.ok(params.properties._unused, 'should use _unused placeholder');
    assert.equal(params.properties._placeholder, undefined, 'should not use _placeholder');
  });

  it('translates tool_choice string passthrough', () => {
    const result = translateRequest({ model: 'x', tool_choice: 'auto' });
    assert.equal(result.tool_choice, 'auto');
  });

  it('translates tool_choice with specific tool', () => {
    const result = translateRequest({
      model: 'x',
      tool_choice: { type: 'tool', name: 'get_weather' },
    });
    assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  });

  it('translates tool_choice with type only', () => {
    const result = translateRequest({
      model: 'x',
      tool_choice: { type: 'auto' },
    });
    assert.equal(result.tool_choice, 'auto');
  });

  it('passes through temperature', () => {
    const result = translateRequest({ model: 'x', temperature: 0.7 });
    assert.equal(result.temperature, 0.7);
  });

  it('omits temperature when not set', () => {
    const result = translateRequest({ model: 'x' });
    assert.equal(result.temperature, undefined);
  });

  it('handles empty messages array', () => {
    const result = translateRequest({ model: 'x', messages: [] });
    assert.deepEqual(result.messages, []);
  });

  it('handles missing messages', () => {
    const result = translateRequest({ model: 'x' });
    assert.deepEqual(result.messages, []);
  });
});

// ── translateResponse ───────────────────────────────────

describe('translateResponse', () => {
  it('translates text response', () => {
    const result = translateResponse({
      id: 'chatcmpl-123',
      model: 'gpt-4o',
      choices: [{
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    assert.equal(result.id, 'chatcmpl-123');
    assert.equal(result.type, 'message');
    assert.equal(result.role, 'assistant');
    assert.equal(result.model, 'gpt-4o');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hello!');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.stop_sequence, null);
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  it('translates tool_calls response', () => {
    const result = translateResponse({
      id: 'chatcmpl-456',
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 15 },
    });
    assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'tool_use');
    assert.equal(result.content[0].id, 'call_abc');
    assert.equal(result.content[0].name, 'get_weather');
    assert.deepEqual(result.content[0].input, { city: 'NYC' });
  });

  it('translates response with both text and tool_calls', () => {
    const result = translateResponse({
      id: 'chatcmpl-789',
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Let me check',
          tool_calls: [{
            id: 'call_xyz',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Let me check');
    assert.equal(result.content[1].type, 'tool_use');
  });

  it('returns error when no choices', () => {
    const result = translateResponse({ id: 'x', choices: [] });
    assert.equal(result.type, 'error');
    assert.equal(result.error.type, 'api_error');
  });

  it('returns error when choices is undefined', () => {
    const result = translateResponse({});
    assert.equal(result.type, 'error');
  });

  it('handles missing usage gracefully', () => {
    const result = translateResponse({
      id: 'x',
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    assert.equal(result.usage.input_tokens, 0);
    assert.equal(result.usage.output_tokens, 0);
  });

  it('generates fallback id when missing', () => {
    const result = translateResponse({
      model: 'gpt-4o',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    assert.ok(result.id.startsWith('msg_'));
  });

  it('parses empty tool arguments as empty object', () => {
    const result = translateResponse({
      id: 'x',
      model: 'gpt-4o',
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'no_args', arguments: '' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    assert.deepEqual(result.content[0].input, {});
  });

  it('strips _unused and _placeholder from tool_use inputs', () => {
    const result = translateResponse({
      id: 'x',
      model: 'gpt-4o',
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/a.ts","_unused":"","_placeholder":"x"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    assert.equal(result.content[0].input._unused, undefined);
    assert.equal(result.content[0].input._placeholder, undefined);
    assert.equal(result.content[0].input.file_path, '/a.ts');
  });
});

// ── createStreamTranslator ──────────────────────────────

describe('createStreamTranslator', () => {
  it('emits message_start on first chunk', () => {
    const translator = createStreamTranslator();
    const chunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n\n';
    const output = translator.transform(chunk);

    assert.ok(output.includes('event: message_start'));
    assert.ok(output.includes('"type":"message_start"'));
    assert.ok(output.includes('"role":"assistant"'));
  });

  it('emits content_block_start before first text delta', () => {
    const translator = createStreamTranslator();
    const chunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const output = translator.transform(chunk);

    assert.ok(output.includes('event: content_block_start'));
    assert.ok(output.includes('"type":"text"'));
  });

  it('emits content_block_delta for text content', () => {
    const translator = createStreamTranslator();
    const chunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const output = translator.transform(chunk);

    assert.ok(output.includes('event: content_block_delta'));
    assert.ok(output.includes('"text_delta"'));
    assert.ok(output.includes('"Hello"'));
  });

  it('emits tool_use content_block_start for tool calls', () => {
    const translator = createStreamTranslator();
    // First chunk to start the message
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"ok"}}]}\n\n');

    const toolChunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}\n\n';
    const output = translator.transform(toolChunk);

    assert.ok(output.includes('event: content_block_start'));
    assert.ok(output.includes('"tool_use"'));
    assert.ok(output.includes('"get_weather"'));
  });

  it('emits input_json_delta for tool arguments', () => {
    const translator = createStreamTranslator();
    // Start message
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"ok"}}]}\n\n');
    // Tool start
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"fn","arguments":""}}]}}]}\n\n');

    const argChunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n';
    const output = translator.transform(argChunk);

    assert.ok(output.includes('event: content_block_delta'));
    assert.ok(output.includes('"input_json_delta"'));
  });

  it('handles [DONE] signal', () => {
    const translator = createStreamTranslator();
    // Start message
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n');

    const output = translator.transform('data: [DONE]\n\n');
    assert.ok(output.includes('event: message_delta'));
    assert.ok(output.includes('"stop_reason":"end_turn"'));
    assert.ok(output.includes('event: message_stop'));
  });

  it('handles finish_reason in chunk', () => {
    const translator = createStreamTranslator();
    // Start message with content
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n');

    const finishChunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":10}}\n\n';
    const output = translator.transform(finishChunk);

    assert.ok(output.includes('event: content_block_stop'));
    assert.ok(output.includes('event: message_delta'));
    assert.ok(output.includes('"stop_reason":"end_turn"'));
    assert.ok(output.includes('event: message_stop'));
  });

  it('maps finish_reason tool_calls to stop_reason tool_use', () => {
    const translator = createStreamTranslator();
    // Start message
    translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{"content":"x"}}]}\n\n');

    const finishChunk = 'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const output = translator.transform(finishChunk);

    assert.ok(output.includes('"stop_reason":"tool_use"'));
  });

  it('buffers incomplete lines across chunks', () => {
    const translator = createStreamTranslator();
    // Send partial line
    const out1 = translator.transform('data: {"id":"chatcmpl-1","model":"gpt-4o","choi');
    assert.equal(out1, ''); // nothing complete yet

    // Complete the line
    const out2 = translator.transform('ces":[{"delta":{"content":"Hi"}}]}\n\n');
    assert.ok(out2.includes('event: message_start'));
    assert.ok(out2.includes('"Hi"'));
  });

  it('skips non-data lines', () => {
    const translator = createStreamTranslator();
    const output = translator.transform(': keep-alive\n\n');
    assert.equal(output, '');
  });

  it('handles malformed JSON gracefully', () => {
    const translator = createStreamTranslator();
    const output = translator.transform('data: {not-valid-json}\n\n');
    assert.equal(output, '');
  });
});

// ── Provider detection ──────────────────────────────────

describe('openai provider', () => {
  let savedKey;
  let savedBaseUrl;

  beforeEach(() => {
    savedKey = process.env.OPENAI_API_KEY;
    savedBaseUrl = process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedBaseUrl !== undefined) process.env.OPENAI_BASE_URL = savedBaseUrl;
    else delete process.env.OPENAI_BASE_URL;
  });

  it('exports required provider interface', async () => {
    const { default: openai } = await import('../providers/openai.mjs');
    assert.equal(openai.name, 'openai');
    assert.equal(typeof openai.buildRequest, 'function');
    assert.equal(typeof openai.displayInfo, 'function');
    assert.equal(typeof openai.detect, 'function');
    assert.equal(typeof openai.transformRequest, 'function');
    assert.equal(typeof openai.transformResponse, 'function');
    assert.equal(typeof openai.createStreamTranslator, 'function');
  });

  it('detect returns true when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const { default: openai } = await import('../providers/openai.mjs');
    assert.equal(openai.detect(), true);
  });

  it('detect returns false when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const { default: openai } = await import('../providers/openai.mjs');
    assert.equal(openai.detect(), false);
  });

  it('buildRequest uses default base URL', async () => {
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'sk-test';
    const { default: openai } = await import('../providers/openai.mjs');
    const opts = openai.buildRequest('/v1/messages', '{}', 'sk-my-key');
    assert.equal(opts.hostname, 'api.openai.com');
    assert.equal(opts.path, '/v1/chat/completions');
    assert.equal(opts.headers['authorization'], 'Bearer sk-my-key');
  });

  it('buildRequest uses custom OPENAI_BASE_URL', async () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:8080/v1';
    const { default: openai } = await import('../providers/openai.mjs');
    const opts = openai.buildRequest('/v1/messages', '{}');
    assert.equal(opts.hostname, 'localhost');
    assert.equal(opts.port, '8080');
    assert.equal(opts.path, '/v1/chat/completions');
    assert.equal(opts.protocol, 'http:');
  });

  it('buildRequest strips trailing slash from base URL pathname', async () => {
    process.env.OPENAI_BASE_URL = 'https://api.example.com/v1/';
    const { default: openai } = await import('../providers/openai.mjs');
    const opts = openai.buildRequest('/v1/messages', '{}');
    assert.equal(opts.path, '/v1/chat/completions');
  });

  it('displayInfo shows model name', async () => {
    const { default: openai } = await import('../providers/openai.mjs');
    assert.equal(openai.displayInfo('gpt-4o'), '(gpt-4o via OpenAI API)');
    assert.equal(openai.displayInfo(null), '(OpenAI-compatible)');
  });
});
