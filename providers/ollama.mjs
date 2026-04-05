// Ollama provider for anymodel
// Uses Ollama's native /api/chat endpoint with think:false to disable reasoning.
// The OpenAI-compatible endpoint (/v1/chat/completions) does NOT support think:false,
// causing qwen3/deepseek models to waste all output tokens on hidden chain-of-thought.

import http from 'http';
import { translateRequest } from './openai.mjs';

// Default context size — keeps KV cache small for fast responses.
// Ollama defaults to 131K+ which causes 30-60s delays even for simple prompts.
const DEFAULT_NUM_CTX = 8192;

// Convert Ollama native response → Anthropic Messages API format
function ollamaToAnthropic(ollamaResp, model) {
  const content = [];
  const msg = ollamaResp.message || {};

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: ollamaResp.model || model,
    stop_reason: ollamaResp.done_reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ollamaResp.prompt_eval_count || 0,
      output_tokens: ollamaResp.eval_count || 0,
    },
  };
}

// SSE formatting helper
function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Create stream translator for Ollama native → Anthropic SSE format
function createOllamaStreamTranslator() {
  let buffer = '';
  let started = false;
  let blockIndex = 0;
  let textBlockStarted = false;

  return {
    transform(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      const output = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          if (!started) {
            output.push(formatSSE('message_start', {
              type: 'message_start',
              message: {
                id: `msg_${Date.now()}`,
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

          const content = parsed.message?.content;
          if (content) {
            if (!textBlockStarted) {
              output.push(formatSSE('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' },
              }));
              textBlockStarted = true;
            }
            output.push(formatSSE('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: content },
            }));
          }

          if (parsed.done) {
            if (textBlockStarted) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex,
              }));
            }
            const reason = parsed.done_reason === 'length' ? 'max_tokens' : 'end_turn';
            output.push(formatSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: reason },
              usage: { output_tokens: parsed.eval_count || 0 },
            }));
            output.push(formatSSE('message_stop', { type: 'message_stop' }));
          }
        } catch (e) {
          // Skip malformed lines
        }
      }

      return output.join('');
    },
  };
}

export default {
  name: 'ollama',

  buildRequest(url, payload) {
    return {
      hostname: 'localhost',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  // Translate Anthropic → Ollama native format
  transformRequest(anthropicBody) {
    // Reuse OpenAI translator for message format conversion (system, user, assistant, tool)
    const openaiBody = translateRequest(anthropicBody);

    const numCtx = parseInt(process.env.OLLAMA_NUM_CTX, 10) || DEFAULT_NUM_CTX;

    // Build Ollama native request
    const ollamaBody = {
      model: openaiBody.model,
      messages: openaiBody.messages,
      stream: openaiBody.stream || false,
      think: false, // Disable thinking — this is why we use native API
      options: { num_ctx: numCtx },
    };

    // Map max_tokens → num_predict (Ollama's equivalent)
    if (openaiBody.max_tokens) {
      ollamaBody.options.num_predict = openaiBody.max_tokens;
    }

    if (openaiBody.temperature !== undefined) {
      ollamaBody.options.temperature = openaiBody.temperature;
    }

    return ollamaBody;
  },

  // Translate Ollama native → Anthropic format (non-streaming)
  transformResponse(ollamaResp) {
    return ollamaToAnthropic(ollamaResp);
  },

  // Streaming translator (Ollama NDJSON → Anthropic SSE)
  createStreamTranslator() {
    return createOllamaStreamTranslator();
  },

  displayInfo(model) {
    const numCtx = parseInt(process.env.OLLAMA_NUM_CTX, 10) || DEFAULT_NUM_CTX;
    return model ? `(${model} @ localhost:11434, ctx=${numCtx})` : '(localhost:11434)';
  },

  // Check if Ollama is running locally
  detect() {
    return new Promise(resolve => {
      const req = http.get('http://localhost:11434', res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  },
};
