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
        function: { name: b.name, arguments: JSON.stringify(b.input) },
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
    openaiBody.tools = anthropicBody.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));
  }

  // Tool choice
  if (anthropicBody.tool_choice) {
    if (typeof anthropicBody.tool_choice === 'string') {
      openaiBody.tool_choice = anthropicBody.tool_choice; // "auto", "none", "required"
    } else if (anthropicBody.tool_choice.type === 'tool') {
      openaiBody.tool_choice = { type: 'function', function: { name: anthropicBody.tool_choice.name } };
    } else {
      openaiBody.tool_choice = anthropicBody.tool_choice.type || 'auto';
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

  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResponse.model,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
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
          output.push(formatSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0 },
          }));
          output.push(formatSSE('message_stop', { type: 'message_stop' }));
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

          if (delta.content) {
            if (blockIndex === 0) {
              output.push(formatSSE('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              }));
              blockIndex = 1;
            }
            output.push(formatSSE('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
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
                output.push(formatSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex - 1,
                  delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                }));
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason) {
            const reason = parsed.choices[0].finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
            if (blockIndex > 0) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex - 1,
              }));
            }
            output.push(formatSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: reason },
              usage: { output_tokens: parsed.usage?.completion_tokens || 0 },
            }));
            output.push(formatSSE('message_stop', { type: 'message_stop' }));
          }
        } catch {}
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
