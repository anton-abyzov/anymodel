// OpenAI provider for anymodel
// Translates between Anthropic Messages API and OpenAI Chat Completions API
// Works with any OpenAI-compatible endpoint (OpenAI, Azure, Together, Groq, vLLM, LMStudio, etc.)

// ── Request translation (Anthropic → OpenAI) ────────────

export function translateRequest(anthropicBody) {
  const openaiBody = {
    model: anthropicBody.model,
    max_tokens: anthropicBody.max_tokens,
    stream: anthropicBody.stream || false,
    messages: [],
  };

  // System messages: Anthropic array → OpenAI system message
  if (anthropicBody.system) {
    const systemText = Array.isArray(anthropicBody.system)
      ? anthropicBody.system.map(b => typeof b === 'string' ? b : b.text || '').join('\n')
      : anthropicBody.system;
    openaiBody.messages.push({ role: 'system', content: systemText });
  }

  // Messages: Anthropic blocks → OpenAI format
  for (const msg of anthropicBody.messages || []) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Handle tool_use blocks
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = msg.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const omsg = { role: 'assistant' };
      if (textParts) omsg.content = textParts;
      if (toolCalls.length) omsg.tool_calls = toolCalls;
      openaiBody.messages.push(omsg);
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Handle tool_result blocks
      const hasToolResults = msg.content.some(b => b.type === 'tool_result');
      if (hasToolResults) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('')
              : JSON.stringify(block.content);
            openaiBody.messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content,
            });
          } else if (block.type === 'text') {
            openaiBody.messages.push({ role: 'user', content: block.text });
          }
        }
      } else {
        // Regular user message with content blocks
        const text = msg.content.map(b => typeof b === 'string' ? b : b.text || '').join('');
        openaiBody.messages.push({ role: 'user', content: text });
      }
    } else {
      // Simple string content
      openaiBody.messages.push({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  // Tools: Anthropic → OpenAI function format
  if (anthropicBody.tools?.length) {
    openaiBody.tools = anthropicBody.tools.map(t => {
      const params = t.input_schema ? { ...t.input_schema } : { type: 'object', properties: {} };
      // Ensure type is set
      if (!params.type) params.type = 'object';
      // Fix empty properties: OpenAI rejects { properties: {} }
      if (
        params.type === 'object' &&
        params.properties &&
        typeof params.properties === 'object' &&
        Object.keys(params.properties).length === 0
      ) {
        params.properties = {
          _unused: { type: 'string', description: 'No parameters needed' },
        };
        if (!params.required) params.required = [];
      }
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: params,
        },
      };
    });
  }

  // Tool choice
  if (anthropicBody.tool_choice) {
    if (typeof anthropicBody.tool_choice === 'string') {
      openaiBody.tool_choice = anthropicBody.tool_choice === 'any' ? 'required' : anthropicBody.tool_choice;
    } else if (anthropicBody.tool_choice.type === 'tool') {
      openaiBody.tool_choice = { type: 'function', function: { name: anthropicBody.tool_choice.name } };
    } else {
      const t = anthropicBody.tool_choice.type || 'auto';
      openaiBody.tool_choice = t === 'any' ? 'required' : t;
    }
  }

  // Temperature
  if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;

  return openaiBody;
}

// ── Response translation (OpenAI → Anthropic) for non-streaming ──

export function translateResponse(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) {
    return { type: 'error', error: { type: 'api_error', message: 'No choices in response' } };
  }

  const content = [];

  // Reasoning/thinking content (DeepSeek R1, Qwen3, etc.)
  const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning;
  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning });
  }

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const input = (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })();
      delete input._unused;
      delete input._placeholder;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResponse.model,
    stop_reason: { tool_calls: 'tool_use', length: 'max_tokens', stop: 'end_turn' }[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// ── Streaming translation (OpenAI SSE → Anthropic SSE) ──

function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createStreamTranslator() {
  let buffer = '';
  let blockIndex = 0;
  let started = false;
  let finished = false;
  let thinkingBlockIndex = -1;
  let textBlockIndex = -1;
  const stoppedBlocks = new Set();

  return {
    transform(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      const output = [];

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          if (!finished) {
            finished = true;
            output.push(formatSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 0 },
            }));
            output.push(formatSSE('message_stop', { type: 'message_stop' }));
          }
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (!started) {
            output.push(formatSSE('message_start', {
              type: 'message_start',
              message: {
                id: parsed.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: parsed.model,
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }));
            started = true;
          }

          // Reasoning/thinking content (DeepSeek R1, Qwen3, etc.)
          const reasoningText = delta.reasoning_content ?? delta.reasoning;
          if (reasoningText != null && reasoningText !== '') {
            if (thinkingBlockIndex === -1) {
              thinkingBlockIndex = blockIndex++;
              output.push(formatSSE('content_block_start', {
                type: 'content_block_start',
                index: thinkingBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }));
            }
            output.push(formatSSE('content_block_delta', {
              type: 'content_block_delta',
              index: thinkingBlockIndex,
              delta: { type: 'thinking_delta', thinking: reasoningText },
            }));
          }

          if (delta.content) {
            // Close thinking block when text content starts
            if (thinkingBlockIndex !== -1 && !stoppedBlocks.has(thinkingBlockIndex)) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: thinkingBlockIndex,
              }));
              stoppedBlocks.add(thinkingBlockIndex);
            }
            if (textBlockIndex === -1) {
              textBlockIndex = blockIndex++;
              output.push(formatSSE('content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              }));
            }
            output.push(formatSSE('content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: delta.content },
            }));
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) {
                // New tool call start
                output.push(formatSSE('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
                }));
                blockIndex++;
              }
              if (tc.function?.arguments) {
                let args = tc.function.arguments;
                // Strip placeholder fields injected during request sanitization
                args = args.replace(/"_unused"\s*:\s*"[^"]*"\s*,?\s*/g, '');
                args = args.replace(/"_placeholder"\s*:\s*"[^"]*"\s*,?\s*/g, '');
                if (args) {
                  output.push(formatSSE('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex - 1,
                    delta: { type: 'input_json_delta', partial_json: args },
                  }));
                }
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason && !finished) {
            finished = true;
            const fr = parsed.choices[0].finish_reason;
            const reason = { tool_calls: 'tool_use', length: 'max_tokens', stop: 'end_turn' }[fr] || 'end_turn';
            // Emit content_block_stop for all blocks not already stopped
            for (let i = 0; i < blockIndex; i++) {
              if (!stoppedBlocks.has(i)) {
                output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: i }));
              }
            }
            output.push(formatSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: reason },
              usage: { output_tokens: parsed.usage?.completion_tokens || 0 },
            }));
            output.push(formatSSE('message_stop', { type: 'message_stop' }));
          }
        } catch (e) {
          console.warn(`[SSE PARSE] Dropped chunk: ${e.message}`);
        }
      }

      return output.join('');
    },
  };
}

// ── Provider export ──

export default {
  name: 'openai',

  buildRequest(url, payload, apiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const parsedUrl = new URL(baseUrl);
    return {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      protocol: parsedUrl.protocol,
      path: `${parsedUrl.pathname.replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey || process.env.OPENAI_API_KEY}`,
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  // Transform the body before sending (Anthropic → OpenAI)
  transformRequest(body) {
    return translateRequest(body);
  },

  // Transform response back (OpenAI → Anthropic)
  transformResponse(body) {
    return translateResponse(body);
  },

  // Create stream translator (OpenAI SSE → Anthropic SSE)
  createStreamTranslator,

  displayInfo(model) {
    return model ? `(${model} via OpenAI API)` : '(OpenAI-compatible)';
  },

  detect() {
    return !!(process.env.OPENAI_API_KEY);
  },
};
