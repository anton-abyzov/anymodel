// Ollama provider for anymodel
// Uses Ollama's native /api/chat endpoint with think:false to disable reasoning.
// The OpenAI-compatible endpoint (/v1/chat/completions) does NOT support think:false,
// causing qwen3/deepseek models to waste all output tokens on hidden chain-of-thought.

import http from 'http';
import { translateRequest } from './openai.mjs';

// Default context size — keeps KV cache small for fast responses.
// Ollama defaults to 131K+ which causes 30-60s delays even for simple prompts.
const DEFAULT_NUM_CTX = 8192;

// Keep model loaded in GPU for 30 minutes between requests.
// Without this, Ollama unloads the model after 5min, causing 4-5s cold-start penalties.
const DEFAULT_KEEP_ALIVE = '30m';

// Convert Ollama native response → Anthropic Messages API format
function ollamaToAnthropic(ollamaResp, model, cacheMetrics) {
  const content = [];
  const msg = ollamaResp.message || {};

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  // Handle tool_calls → Anthropic tool_use blocks
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input;
      if (typeof tc.function.arguments === 'string') {
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      } else {
        input = tc.function.arguments || {};
      }
      delete input._unused;
      delete input._placeholder;
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function.name,
        input,
      });
    }
  }

  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }

  const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: ollamaResp.model || model,
    stop_reason: hasToolCalls ? 'tool_use'
      : ollamaResp.done_reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ollamaResp.prompt_eval_count || 0,
      output_tokens: ollamaResp.eval_count || 0,
      ...(cacheMetrics ? {
        cache_read_input_tokens: cacheMetrics.hit ? cacheMetrics.tokenEstimate : 0,
        cache_creation_input_tokens: cacheMetrics.hit ? 0 : cacheMetrics.tokenEstimate,
      } : {}),
    },
  };
}

// SSE formatting helper
function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Create stream translator for Ollama native → Anthropic SSE format
function createOllamaStreamTranslator(cacheMetrics) {
  let buffer = '';
  let started = false;
  let blockIndex = 0;
  let textBlockStarted = false;
  let hasToolCalls = false;
  const toolCallStarted = new Map(); // track which tool call indices have emitted start

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

          // Handle streamed tool calls
          if (parsed.message?.tool_calls) {
            hasToolCalls = true;
            // Close text block if open
            if (textBlockStarted) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex,
              }));
              blockIndex++;
              textBlockStarted = false;
            }

            for (const tc of parsed.message.tool_calls) {
              const tcIdx = tc.index ?? 0;
              if (tc.function?.name && !toolCallStarted.has(tcIdx)) {
                // New tool call — emit content_block_start
                output.push(formatSSE('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: tc.function.name,
                    input: {},
                  },
                }));
                toolCallStarted.set(tcIdx, blockIndex);
                blockIndex++;
              }

              if (tc.function?.arguments) {
                let args = tc.function.arguments;
                // Strip placeholder fields and fix trailing commas
                args = args.replace(/"_unused"\s*:\s*"[^"]*"\s*,?\s*/g, '');
                args = args.replace(/"_placeholder"\s*:\s*"[^"]*"\s*,?\s*/g, '');
                // Fix trailing commas left after stripping (e.g. {"city":"NYC",} → {"city":"NYC"})
                args = args.replace(/,\s*([}\]])/g, '$1');
                if (args && args.trim()) {
                  const bi = toolCallStarted.get(tcIdx) ?? (blockIndex - 1);
                  output.push(formatSSE('content_block_delta', {
                    type: 'content_block_delta',
                    index: bi,
                    delta: { type: 'input_json_delta', partial_json: args },
                  }));
                }
              }
            }
          }

          if (parsed.done) {
            if (textBlockStarted) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex,
              }));
            }
            // Close any open tool call blocks
            for (const [, bi] of toolCallStarted) {
              output.push(formatSSE('content_block_stop', {
                type: 'content_block_stop',
                index: bi,
              }));
            }
            const reason = hasToolCalls ? 'tool_use'
              : parsed.done_reason === 'length' ? 'max_tokens' : 'end_turn';
            output.push(formatSSE('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: reason },
              usage: {
                output_tokens: parsed.eval_count || 0,
                ...(cacheMetrics ? {
                  cache_read_input_tokens: cacheMetrics.hit ? cacheMetrics.tokenEstimate : 0,
                  cache_creation_input_tokens: cacheMetrics.hit ? 0 : cacheMetrics.tokenEstimate,
                } : {}),
              },
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

    const keepAlive = process.env.OLLAMA_KEEP_ALIVE || DEFAULT_KEEP_ALIVE;

    // Build Ollama native request
    const ollamaBody = {
      model: openaiBody.model,
      messages: openaiBody.messages,
      stream: openaiBody.stream || false,
      think: false, // Disable thinking — this is why we use native API
      keep_alive: keepAlive, // Keep model in GPU between requests (avoids cold-start)
      options: { num_ctx: numCtx },
    };

    // Pass tools through — Ollama uses the same format as OpenAI
    // tool_choice is intentionally NOT passed (Ollama doesn't support it)
    if (openaiBody.tools) {
      ollamaBody.tools = openaiBody.tools;

      // Trim tool descriptions to save context on local models.
      // Claude Code sends 86+ tools with 500-2000 char descriptions each.
      // At ~4 chars/token, that's 10-40K tokens of descriptions alone —
      // often exceeding the entire context window. Trim to first N chars.
      const maxDescLen = parseInt(process.env.OLLAMA_MAX_TOOL_DESC, 10) || 100;
      for (const t of ollamaBody.tools) {
        const desc = t.function?.description;
        if (desc && desc.length > maxDescLen) {
          // Keep first sentence if it fits, otherwise hard truncate
          const firstSentence = desc.match(/^[^.!?\n]+[.!?]/);
          if (firstSentence && firstSentence[0].length <= maxDescLen) {
            t.function.description = firstSentence[0];
          } else {
            t.function.description = desc.slice(0, maxDescLen) + '…';
          }
        }
      }
    }

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
  transformResponse(ollamaResp, cacheMetrics) {
    return ollamaToAnthropic(ollamaResp, undefined, cacheMetrics);
  },

  // Streaming translator (Ollama NDJSON → Anthropic SSE)
  createStreamTranslator(cacheMetrics) {
    return createOllamaStreamTranslator(cacheMetrics);
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

  // Pre-load model into GPU on proxy start to eliminate cold-start latency
  // Uses the SAME num_ctx as real requests so Ollama doesn't re-allocate KV cache
  warmup(model) {
    if (!model) return Promise.resolve();
    const keepAlive = process.env.OLLAMA_KEEP_ALIVE || DEFAULT_KEEP_ALIVE;
    const numCtx = parseInt(process.env.OLLAMA_NUM_CTX, 10) || DEFAULT_NUM_CTX;
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      think: false,
      keep_alive: keepAlive,
      stream: false,
      options: { num_ctx: numCtx, num_predict: 1 },
    });
    return new Promise(resolve => {
      const req = http.request({
        hostname: 'localhost',
        port: 11434,
        path: '/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, res => {
        res.resume();
        res.on('end', () => resolve(true));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(30000, () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  },
};
