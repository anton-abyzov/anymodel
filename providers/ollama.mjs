// Ollama provider for anymodel
// Uses Ollama's native /api/chat endpoint with think:false to disable reasoning.
// The OpenAI-compatible endpoint (/v1/chat/completions) does NOT support think:false,
// causing qwen3/deepseek models to waste all output tokens on hidden chain-of-thought.

import http from 'http';
import { randomUUID } from 'crypto';
import {
  translateRequest,
  extractTextToolCalls,
  textChannelParsingEnabled,
  fencedRecoveryEnabled,
} from './openai.mjs';

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

  const hasStructuredToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);

  // 0018: text-channel tool-call recovery for the NATIVE Ollama wire — parity with
  // openai.mjs. Qwen3-coder via /api/chat parks calls in the text channel as
  // <function=X><parameter=k>v</parameter></function> when it skips the structured
  // tool_calls field; without recovery the client receives prose + end_turn and
  // executes nothing. Only when no structured calls came (never mix channels).
  let textContent = msg.content || '';
  let recoveredCalls = [];
  if (!hasStructuredToolCalls && textContent && textChannelParsingEnabled(true)) {
    const r = extractTextToolCalls(textContent, { allowFenced: fencedRecoveryEnabled() });
    if (r.calls.length) {
      recoveredCalls = r.calls;
      textContent = r.cleanedText;
      console.log(`[OLLAMA] Recovered ${r.calls.length} text-channel tool call(s): ${r.calls.map(c => c.name).join(', ')}`);
    }
  }

  if (textContent) {
    content.push({ type: 'text', text: textContent });
  }

  // Handle tool_calls → Anthropic tool_use blocks
  if (hasStructuredToolCalls) {
    for (const tc of msg.tool_calls) {
      let input;
      if (typeof tc.function.arguments === 'string') {
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      } else {
        input = tc.function.arguments || {};
      }
      // US-004: no longer strip _unused/_placeholder — preserved as real user params
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${randomUUID()}`,
        name: tc.function.name,
        input,
      });
    }
  }

  for (const c of recoveredCalls) {
    content.push({
      type: 'tool_use',
      id: `toolu_txt_${randomUUID()}`,
      name: c.name,
      input: c.input || {},
    });
  }

  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }

  const hasToolCalls = hasStructuredToolCalls || recoveredCalls.length > 0;

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

// Strip a `data:<mime>;base64,` prefix → raw base64. Ollama's native /api/chat
// `images` field wants RAW base64 with NO data-URI prefix. Returns null when the
// string is not a base64 data URI (e.g. an http(s) URL), which the native field
// cannot carry.
export function dataUriToBase64(url) {
  if (typeof url !== 'string') return null;
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(url);
  return m ? m[1] : null;
}

// Ollama's NATIVE /api/chat does NOT understand OpenAI content-part arrays
// ({type:'image_url'|'text'}). It wants `content` as a plain STRING plus a
// top-level `images` array of RAW base64 on the message (see the official
// docs/api.md "Chat request (with images)"). translateRequest() (shared with the
// OpenAI provider) emits image_url parts, so we post-process here: collapse text
// parts into the string content and hoist each base64 image into message.images.
// A URL-sourced image can't be sent to the native field, so it becomes a visible
// text marker — never a silent drop.
export function toOllamaNativeMessages(messages) {
  return messages.map(msg => {
    let out = msg;
    if (Array.isArray(msg.content)) {
      const textParts = [];
      const images = [];
      for (const part of msg.content) {
        if (typeof part === 'string') { textParts.push(part); continue; }
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') { textParts.push(part.text || ''); continue; }
        if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          const b64 = dataUriToBase64(url);
          if (b64) images.push(b64);
          else if (url) textParts.push(`[image: ${url} — Ollama native API accepts base64 only]`);
          continue;
        }
        if (typeof part.text === 'string') textParts.push(part.text);
      }
      out = { ...msg, content: textParts.join('') };
      if (images.length) out.images = images;
    }
    // 0018: Ollama's NATIVE /api/chat types assistant tool_calls arguments as an
    // OBJECT (map[string]any). translateRequest() emits the OpenAI shape where
    // arguments is a JSON STRING — passing that through makes Ollama's decoder
    // fail the whole request ("can't find closing '}'" / unmarshal errors) on the
    // turn AFTER any tool use. Parse string args to objects; unparseable → {}.
    if (Array.isArray(out.tool_calls)) {
      if (out === msg) out = { ...msg };
      out.tool_calls = out.tool_calls.map(tc => {
        const fn = tc?.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (!args || typeof args !== 'object') args = {};
        return { ...tc, function: { ...fn, arguments: args } };
      });
    }
    return out;
  });
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
  let hasToolCalls = false;
  let finalized = false;
  let lastModel = null;
  const toolCallStarted = new Map(); // track which tool call indices have emitted start

  // 0018: text-channel tool-call recovery, parity with openai.mjs streaming.
  // We cannot reclassify text that was already streamed to the client, so when
  // recovery is enabled (always-local here) the text channel is BUFFERED and
  // emitted at end-of-message — recovered calls become real tool_use blocks.
  const recoverText = textChannelParsingEnabled(true);
  let bufferedText = '';
  let textBlockStarted = false; // live-streaming mode only (recovery off)

  function emitMessageStart(output, model) {
    if (started) return;
    started = true;
    output.push(formatSSE('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  // Emit buffered text once; when no structured tool call arrived, scan it for a
  // parked text-channel call and convert (text block with cleaned prose + one
  // tool_use block per recovered call).
  function emitBufferedText(output) {
    if (!bufferedText) return;
    let text = bufferedText;
    let calls = [];
    bufferedText = '';
    if (!hasToolCalls) {
      const r = extractTextToolCalls(text, { allowFenced: fencedRecoveryEnabled() });
      if (r.calls.length) {
        calls = r.calls;
        text = r.cleanedText;
        console.log(`[OLLAMA] Recovered ${calls.length} streamed text-channel tool call(s): ${calls.map(c => c.name).join(', ')}`);
      }
    }
    if (text) {
      const bi = blockIndex++;
      output.push(formatSSE('content_block_start', {
        type: 'content_block_start', index: bi, content_block: { type: 'text', text: '' },
      }));
      output.push(formatSSE('content_block_delta', {
        type: 'content_block_delta', index: bi, delta: { type: 'text_delta', text },
      }));
      output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: bi }));
    }
    for (const c of calls) {
      const bi = blockIndex++;
      output.push(formatSSE('content_block_start', {
        type: 'content_block_start', index: bi,
        content_block: { type: 'tool_use', id: `toolu_txt_${randomUUID()}`, name: c.name, input: {} },
      }));
      output.push(formatSSE('content_block_delta', {
        type: 'content_block_delta', index: bi,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) },
      }));
      output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: bi }));
    }
    if (calls.length) hasToolCalls = true;
  }

  function finalize(output, doneLine) {
    if (finalized) return;
    finalized = true;
    emitMessageStart(output, lastModel); // stream may end before any line parsed
    if (textBlockStarted) {
      output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      blockIndex++;
      textBlockStarted = false;
    }
    emitBufferedText(output);
    for (const [, bi] of toolCallStarted) {
      output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: bi }));
    }
    const reason = hasToolCalls ? 'tool_use'
      : doneLine?.done_reason === 'length' ? 'max_tokens' : 'end_turn';
    output.push(formatSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reason },
      usage: {
        // 0009 P2.1 parity: surface prompt tokens (openai got this in 0008).
        input_tokens: doneLine?.prompt_eval_count || 0,
        output_tokens: doneLine?.eval_count || 0,
        ...(cacheMetrics ? {
          cache_read_input_tokens: cacheMetrics.hit ? cacheMetrics.tokenEstimate : 0,
          cache_creation_input_tokens: cacheMetrics.hit ? 0 : cacheMetrics.tokenEstimate,
        } : {}),
      },
    }));
    output.push(formatSSE('message_stop', { type: 'message_stop' }));
  }

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
          lastModel = parsed.model || lastModel;
          emitMessageStart(output, parsed.model);

          const content = parsed.message?.content;
          if (content) {
            if (recoverText) {
              bufferedText += content;
            } else {
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
          }

          // Handle streamed tool calls
          if (parsed.message?.tool_calls) {
            hasToolCalls = true;
            // Close a live-streamed text block if open
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
                    id: tc.id || `toolu_${randomUUID()}`,
                    name: tc.function.name,
                    input: {},
                  },
                }));
                toolCallStarted.set(tcIdx, blockIndex);
                blockIndex++;
              }

              if (tc.function?.arguments) {
                // US-004: no longer strip _unused/_placeholder or fix trailing
                // commas left behind by stripping — since 1.12.0 we stopped
                // injecting placeholder fields. Native wire may deliver args as
                // an object — serialize for the Anthropic input_json_delta.
                const rawArgs = tc.function.arguments;
                const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
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
            finalize(output, parsed);
          }
        } catch (e) {
          // Skip malformed lines
        }
      }

      return output.join('');
    },

    // P0.1 parity with openai.mjs: the NDJSON stream can end WITHOUT a done:true
    // line (upstream crash/timeout). Without this, no message_stop is emitted and
    // the client's agentic loop hangs forever. proxy.mjs calls flush() on upstream
    // end when defined.
    flush() {
      const output = [];
      finalize(output, null);
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

    // Build Ollama native request. toOllamaNativeMessages converts any OpenAI
    // image_url content parts into the native message.images base64 array so
    // attached images survive to a multimodal model (llava, llama3.2-vision, …).
    const ollamaBody = {
      model: openaiBody.model,
      messages: toOllamaNativeMessages(openaiBody.messages),
      stream: openaiBody.stream || false,
      think: false, // Disable thinking — this is why we use native API
      keep_alive: keepAlive, // Keep model in GPU between requests (avoids cold-start)
      options: { num_ctx: numCtx },
    };

    // Pass tools through — Ollama uses the same format as OpenAI
    // tool_choice is intentionally NOT passed (Ollama doesn't support it)
    // Note: description trimming + schema compression now handled upstream
    // by tool-compressor.mjs in proxy.mjs (before OpenAI format conversion).
    if (openaiBody.tools) {
      ollamaBody.tools = openaiBody.tools;
    }

    // Map max_tokens → num_predict (Ollama's equivalent)
    if (openaiBody.max_tokens) {
      ollamaBody.options.num_predict = openaiBody.max_tokens;
    }

    if (openaiBody.temperature !== undefined) {
      ollamaBody.options.temperature = openaiBody.temperature;
    }

    // P1.4: mirror sampling parity into Ollama's options. `stop` is the important
    // one — Qwen/llama loops rely on stop tokens to avoid over-generation.
    if (openaiBody.top_p !== undefined) {
      ollamaBody.options.top_p = openaiBody.top_p;
    }
    if (openaiBody.stop) {
      ollamaBody.options.stop = openaiBody.stop;
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
