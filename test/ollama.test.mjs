import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ollamaProvider from '../providers/ollama.mjs';

describe('ollamaToAnthropic (via transformResponse)', () => {
  it('converts text-only response', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: { role: 'assistant', content: 'Hello world' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 5,
    });
    assert.equal(result.role, 'assistant');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hello world');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  it('converts tool_calls response', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
        }],
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 20,
      eval_count: 15,
    });
    assert.equal(result.stop_reason, 'tool_use');
    // Should have tool_use block (text may or may not be present)
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse, 'should have tool_use block');
    assert.equal(toolUse.name, 'get_weather');
    assert.deepEqual(toolUse.input, { city: 'NYC' });
    assert.ok(toolUse.id, 'should have an id');
  });

  it('converts mixed text + tool_calls', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: 'Let me check the weather',
        tool_calls: [{
          function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        }],
      },
      done: true,
      done_reason: 'stop',
    });
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Let me check the weather');
    assert.equal(result.content[1].type, 'tool_use');
    assert.equal(result.content[1].name, 'get_weather');
    assert.equal(result.stop_reason, 'tool_use');
  });

  it('generates fallback tool call id when missing', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
        }],
      },
      done: true,
    });
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.ok(toolUse.id.startsWith('toolu_'), 'should generate toolu_ prefixed id');
  });

  it('preserves tool call id when present', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_existing_123',
          function: { name: 'read_file', arguments: '{}' },
        }],
      },
      done: true,
    });
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.equal(toolUse.id, 'call_existing_123');
  });

  it('strips _unused from tool arguments', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'test', arguments: '{"_unused":"","city":"NYC"}' },
        }],
      },
      done: true,
    });
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.equal(toolUse.input._unused, undefined);
    assert.equal(toolUse.input.city, 'NYC');
  });

  it('handles malformed JSON arguments gracefully', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'test', arguments: 'not json' },
        }],
      },
      done: true,
    });
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.deepEqual(toolUse.input, {});
  });

  it('handles object arguments (not string)', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: { name: 'test', arguments: { key: 'value' } },
        }],
      },
      done: true,
    });
    const toolUse = result.content.find(b => b.type === 'tool_use');
    assert.deepEqual(toolUse.input, { key: 'value' });
  });

  it('empty tool_calls array does NOT trigger tool_use stop_reason', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: { role: 'assistant', content: 'Hello', tool_calls: [] },
      done: true,
      done_reason: 'stop',
    });
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
  });

  it('handles multiple tool_calls in a single response', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'Read', arguments: '{"file":"/a.ts"}' } },
          { function: { name: 'Bash', arguments: '{"command":"ls"}' } },
        ],
      },
      done: true,
    });
    const toolBlocks = result.content.filter(b => b.type === 'tool_use');
    assert.equal(toolBlocks.length, 2);
    assert.equal(toolBlocks[0].name, 'Read');
    assert.equal(toolBlocks[1].name, 'Bash');
    assert.equal(result.stop_reason, 'tool_use');
  });

  it('sets stop_reason to max_tokens when done_reason is length', () => {
    const result = ollamaProvider.transformResponse({
      model: 'qwen3',
      message: { role: 'assistant', content: 'truncated' },
      done: true,
      done_reason: 'length',
    });
    assert.equal(result.stop_reason, 'max_tokens');
  });
});

describe('transformRequest — tool passthrough', () => {
  it('passes tools through to ollama body', () => {
    const result = ollamaProvider.transformRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    });
    assert.ok(result.tools, 'should have tools in ollama body');
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].function.name, 'get_weather');
  });

  it('does not include tool_choice (Ollama does not support it)', () => {
    const result = ollamaProvider.transformRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'test', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
    });
    assert.equal(result.tool_choice, undefined);
  });

  it('works without tools (no tools field)', () => {
    const result = ollamaProvider.transformRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(result.tools, undefined);
  });

  it('always includes think: false', () => {
    const result = ollamaProvider.transformRequest({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(result.think, false);
  });
});

describe('createOllamaStreamTranslator — tool calls', () => {
  it('emits tool_use content_block_start for streamed tool calls', () => {
    const translator = ollamaProvider.createStreamTranslator();
    // First chunk — text to start message
    translator.transform('{"model":"qwen3","message":{"content":"ok"},"done":false}\n');

    // Tool call chunk
    const toolChunk = '{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"get_weather","arguments":""}}]},"done":false}\n';
    const output = translator.transform(toolChunk);

    assert.ok(output.includes('content_block_start'), 'should emit content_block_start');
    assert.ok(output.includes('tool_use'), 'should be tool_use type');
    assert.ok(output.includes('get_weather'), 'should include tool name');
  });

  it('emits input_json_delta for tool arguments', () => {
    const translator = ollamaProvider.createStreamTranslator();
    // Start message
    translator.transform('{"model":"qwen3","message":{"content":""},"done":false}\n');
    // Tool start
    translator.transform('{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"fn","arguments":""}}]},"done":false}\n');

    // Argument chunk
    const argChunk = '{"model":"qwen3","message":{"tool_calls":[{"function":{"arguments":"{\\"city\\":"}}]},"done":false}\n';
    const output = translator.transform(argChunk);

    assert.ok(output.includes('content_block_delta'), 'should emit content_block_delta');
    assert.ok(output.includes('input_json_delta'), 'should be input_json_delta type');
  });

  it('sets stop_reason to tool_use when tool calls present on done', () => {
    const translator = ollamaProvider.createStreamTranslator();
    // Start with text
    translator.transform('{"model":"qwen3","message":{"content":""},"done":false}\n');
    // Tool call
    translator.transform('{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"fn","arguments":"{\\"x\\":1}"}}]},"done":false}\n');

    // Done signal
    const output = translator.transform('{"model":"qwen3","message":{},"done":true,"done_reason":"stop","eval_count":10}\n');

    assert.ok(output.includes('"stop_reason":"tool_use"'), 'stop_reason should be tool_use');
    assert.ok(output.includes('message_stop'), 'should emit message_stop');
  });

  it('emits text content normally (regression)', () => {
    const translator = ollamaProvider.createStreamTranslator();
    const output = translator.transform('{"model":"qwen3","message":{"content":"Hello"},"done":false}\n');

    assert.ok(output.includes('message_start'), 'should emit message_start');
    assert.ok(output.includes('content_block_start'), 'should emit content_block_start');
    assert.ok(output.includes('text_delta'), 'should emit text_delta');
    assert.ok(output.includes('Hello'), 'should include text content');
  });

  it('strips _unused from streamed tool arguments', () => {
    const translator = ollamaProvider.createStreamTranslator();
    translator.transform('{"model":"qwen3","message":{"content":""},"done":false}\n');
    translator.transform('{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"fn","arguments":""}}]},"done":false}\n');

    const argChunk = '{"model":"qwen3","message":{"tool_calls":[{"function":{"arguments":"{\\"_unused\\":\\"\\",\\"city\\":\\"NYC\\"}"}}]},"done":false}\n';
    const output = translator.transform(argChunk);

    assert.ok(!output.includes('_unused'), 'should strip _unused from arguments');
    assert.ok(output.includes('city'), 'should keep real arguments');
  });

  it('closes text block before starting tool blocks', () => {
    const translator = ollamaProvider.createStreamTranslator();
    // Text chunk
    translator.transform('{"model":"qwen3","message":{"content":"thinking..."},"done":false}\n');
    // Tool chunk — should close text block first
    const output = translator.transform('{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"done":false}\n');

    // Find positions: text block stop should come before tool block start
    const textStopIdx = output.indexOf('"content_block_stop"');
    const toolStartIdx = output.indexOf('"tool_use"');
    assert.ok(textStopIdx !== -1, 'should emit content_block_stop for text');
    assert.ok(toolStartIdx !== -1, 'should emit tool_use content_block_start');
    assert.ok(textStopIdx < toolStartIdx, 'text block should close before tool block starts');
  });

  it('handles multiple tool calls in a single streaming chunk', () => {
    const translator = ollamaProvider.createStreamTranslator();
    translator.transform('{"model":"qwen3","message":{"content":""},"done":false}\n');

    // Single chunk with two tool calls
    const output = translator.transform('{"model":"qwen3","message":{"tool_calls":[{"index":0,"function":{"name":"Read","arguments":"{\\"file\\":\\"/a.ts\\"}"}},{"index":1,"function":{"name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"done":false}\n');

    // Should have two content_block_start events
    const starts = output.match(/content_block_start/g);
    assert.ok(starts && starts.length >= 2, 'should emit 2 content_block_start events');
    assert.ok(output.includes('Read'), 'should include first tool name');
    assert.ok(output.includes('Bash'), 'should include second tool name');
  });

  it('fixes trailing comma after _unused stripping', () => {
    const translator = ollamaProvider.createStreamTranslator();
    translator.transform('{"model":"qwen3","message":{"content":""},"done":false}\n');
    translator.transform('{"model":"qwen3","message":{"tool_calls":[{"function":{"name":"fn","arguments":""}}]},"done":false}\n');

    // _unused is last key — stripping should not leave trailing comma
    const argChunk = '{"model":"qwen3","message":{"tool_calls":[{"function":{"arguments":"{\\"city\\":\\"NYC\\",\\"_unused\\":\\"\\"}"}}]},"done":false}\n';
    const output = translator.transform(argChunk);

    assert.ok(!output.includes(',}'), 'should not leave trailing comma');
    assert.ok(output.includes('city'), 'should keep real arguments');
  });
});

describe('cache metrics in ollamaToAnthropic', () => {
  const ollamaResp = {
    model: 'test',
    message: { role: 'assistant', content: 'hello' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 100,
    eval_count: 50,
  };

  it('includes cache_read_input_tokens on hit', () => {
    const result = ollamaProvider.transformResponse(ollamaResp, { hit: true, tokenEstimate: 500 });
    assert.equal(result.usage.cache_read_input_tokens, 500);
    assert.equal(result.usage.cache_creation_input_tokens, 0);
  });

  it('includes cache_creation_input_tokens on miss', () => {
    const result = ollamaProvider.transformResponse(ollamaResp, { hit: false, tokenEstimate: 500 });
    assert.equal(result.usage.cache_creation_input_tokens, 500);
    assert.equal(result.usage.cache_read_input_tokens, 0);
  });

  it('omits cache fields when no cacheMetrics', () => {
    const result = ollamaProvider.transformResponse(ollamaResp);
    assert.equal(result.usage.cache_read_input_tokens, undefined);
    assert.equal(result.usage.cache_creation_input_tokens, undefined);
  });
});
