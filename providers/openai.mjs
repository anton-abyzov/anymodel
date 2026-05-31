// OpenAI provider for anymodel
// Translates between Anthropic Messages API and OpenAI Chat Completions API
// Works with any OpenAI-compatible endpoint (OpenAI, Azure, Together, Groq, vLLM, LMStudio, etc.)

// ── Request translation (Anthropic → OpenAI) ────────────

// P1.2: resolve an Anthropic image block to an OpenAI `image_url` data/URL string.
// base64 → data: URI; url source → the URL verbatim. Returns null for an
// unknown/undefined source so the caller can substitute a visible marker instead
// of silently dropping the image.
export function imageBlockToUrl(b) {
  const src = b?.source;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'base64' && src.data && src.media_type) {
    return `data:${src.media_type};base64,${src.data}`;
  }
  if (src.type === 'url' && src.url) return src.url;
  return null;
}

// P1.2: translate an Anthropic content-block array into OpenAI message content.
// Returns a plain STRING when every block is text (keeps text-only turns
// byte-identical to the old behavior for servers that reject array content), or
// an ARRAY of {type:'text'|'image_url'} parts when any image is present. Images
// that can't be resolved and documents become a visible marker — never a silent
// drop.
export function blocksToOpenAIContent(blocks) {
  const parts = [];
  let hasImage = false;
  for (const b of blocks) {
    if (typeof b === 'string') { parts.push({ type: 'text', text: b }); continue; }
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') { parts.push({ type: 'text', text: b.text || '' }); continue; }
    if (b.type === 'image') {
      const url = imageBlockToUrl(b);
      if (url) { parts.push({ type: 'image_url', image_url: { url } }); hasImage = true; }
      else parts.push({ type: 'text', text: '[image omitted]' });
      continue;
    }
    if (b.type === 'document') { parts.push({ type: 'text', text: '[document omitted]' }); continue; }
    if (typeof b.text === 'string') parts.push({ type: 'text', text: b.text });
  }
  if (!hasImage) return parts.map(p => (p.type === 'text' ? p.text : '')).join('');
  return parts;
}

// P1.2 + P1.3: extract the OpenAI `tool` message content from an Anthropic
// tool_result block. Returns { text, imageUrls } — images are hoisted out by the
// caller because the OpenAI tool role is text-only. When `is_error` is set the
// text is prefixed with a `[tool_error]` marker so a failed tool looks failed to
// the model (OpenAI's tool role has no structured error field).
export function extractToolResultParts(block) {
  const imageUrls = [];
  let text;
  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    const pieces = [];
    for (const b of block.content) {
      if (b?.type === 'text') pieces.push(b.text || '');
      else if (b?.type === 'image') {
        const url = imageBlockToUrl(b);
        if (url) imageUrls.push(url);
        else pieces.push('[image omitted]');
      } else if (typeof b?.text === 'string') pieces.push(b.text);
    }
    text = pieces.join('');
  } else {
    text = JSON.stringify(block.content);
  }
  if (block.is_error) text = '[tool_error] ' + text;
  return { text, imageUrls };
}

export function translateRequest(anthropicBody) {
  const openaiBody = {
    model: anthropicBody.model,
    // P1.4: fall back to the newer `max_output_tokens` when `max_tokens` is absent.
    // sanitizeBody clamps each to >=16 independently but never bridges the two, so
    // a client sending only `max_output_tokens` would otherwise get `max_tokens:
    // undefined` and over-generate.
    max_tokens: anthropicBody.max_tokens ?? anthropicBody.max_output_tokens,
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
            // P1.3: preserve is_error marker; P1.2: hoist images (tool role is text-only)
            const { text, imageUrls } = extractToolResultParts(block);
            openaiBody.messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: text,
            });
            if (imageUrls.length) {
              openaiBody.messages.push({
                role: 'user',
                content: imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
              });
            }
          } else if (block.type === 'text') {
            openaiBody.messages.push({ role: 'user', content: block.text });
          } else if (block.type === 'image') {
            // P1.2: a bare image alongside tool_result blocks — emit as its own user turn
            const url = imageBlockToUrl(block);
            openaiBody.messages.push({
              role: 'user',
              content: url ? [{ type: 'image_url', image_url: { url } }] : '[image omitted]',
            });
          }
        }
      } else {
        // Regular user message with content blocks (P1.2: images → vision parts)
        openaiBody.messages.push({ role: 'user', content: blocksToOpenAIContent(msg.content) });
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
      // Fix empty properties: use the canonical "no-params object" JSON Schema.
      // Since 1.12.0 we use `additionalProperties: false` instead of injecting a
      // `_unused` placeholder — accepted by OpenAI, Groq, Together, vLLM, LMStudio,
      // Ollama, and preserves real tool params named `_unused` end-to-end (US-004).
      if (
        params.type === 'object' &&
        params.properties &&
        typeof params.properties === 'object' &&
        Object.keys(params.properties).length === 0
      ) {
        params.additionalProperties = false;
        if (!Array.isArray(params.required)) params.required = [];
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

  // P1.4: sampling parity. The real-world bite is `stop_sequences` — a local Qwen
  // loop relying on stop tokens over-generates without it. OpenRouter (native
  // passthrough) keeps all of these, so dropping them here was a parity regression.
  if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }

  return openaiBody;
}

// ── Text-channel tool-call recovery (P0.2) ─────────────────────
// Local Qwen3-Coder under LM Studio (and other servers with a misconfigured or
// missing tool-call parser) frequently emit a tool call into the TEXT channel
// instead of the structured `tool_calls` array — as Hermes `<tool_call>{...}`,
// Qwen XML `<function=name><parameter=k>v</parameter></function>`, or a fenced
// ```json {name, arguments} block. Untreated, the proxy forwards it as plain
// text + `end_turn`, Claude Code executes nothing, and the agentic loop silently
// dead-ends. This recovers those into real `tool_use` blocks.
//
// Gated by ANYMODEL_PARSE_TEXT_TOOLCALLS:
//   'auto' (default) → on for local providers only (caller passes localProvider)
//   'on'             → always
//   'off'            → never
// Cloud providers (OpenRouter/OpenAI) are left untouched under 'auto'.

let __toolIdSeq = 0;
function genToolId() {
  // Deterministic-ish, collision-resistant within a process; avoids Date.now()
  // collisions for parallel calls in the same ms.
  return `toolu_txt_${Date.now().toString(36)}_${(__toolIdSeq++).toString(36)}`;
}

export function textChannelParsingEnabled(localProvider = false) {
  const mode = (process.env.ANYMODEL_PARSE_TEXT_TOOLCALLS || 'auto').toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !!localProvider; // 'auto'
}

// Parse a text blob for tool-call syntax. Returns { calls: [{name,input}], cleanedText }.
// Conservative: requires a strict whole-pattern match + valid structure so prose
// that merely *mentions* `<tool_call>` is not converted.
export function extractTextToolCalls(text) {
  const calls = [];
  let cleaned = text;
  if (typeof text !== 'string' || !text) return { calls, cleanedText: cleaned };

  // 1) Hermes: <tool_call>{ "name": "...", "arguments": {...} }</tool_call>
  const hermes = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  cleaned = cleaned.replace(hermes, (match, inner) => {
    try {
      const obj = JSON.parse(inner);
      if (obj && typeof obj.name === 'string') {
        let args = obj.arguments ?? obj.parameters ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        calls.push({ name: obj.name, input: (args && typeof args === 'object') ? args : {} });
        return ''; // strip matched span
      }
    } catch { /* not valid JSON — leave the text in place */ }
    return match;
  });

  // 2) Qwen XML: <function=name><parameter=key>value</parameter>...</function>
  const qwenFn = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g;
  cleaned = cleaned.replace(qwenFn, (match, name, inner) => {
    const input = {};
    const paramRe = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
    let m, found = false;
    while ((m = paramRe.exec(inner)) !== null) {
      found = true;
      let val = m[2].trim();
      // best-effort: JSON-parse scalars/objects, else keep as string
      try { val = JSON.parse(val); } catch { /* keep string */ }
      input[m[1]] = val;
    }
    if (name) { calls.push({ name, input }); return ''; }
    return match;
    void found;
  });

  // 3) Fenced ```json { "name": "...", "arguments": {...} } ``` — only when the
  // fenced object is itself a tool-call shape (has a string `name`).
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  cleaned = cleaned.replace(fenced, (match, inner) => {
    try {
      const obj = JSON.parse(inner);
      if (obj && typeof obj.name === 'string' && ('arguments' in obj || 'parameters' in obj)) {
        let args = obj.arguments ?? obj.parameters ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        calls.push({ name: obj.name, input: (args && typeof args === 'object') ? args : {} });
        return '';
      }
    } catch { /* not a tool-call fenced block */ }
    return match;
  });

  return { calls, cleanedText: cleaned.trim() };
}

// P1.5: single source of truth for OpenAI finish_reason → Anthropic stop_reason,
// applied at all non-streaming and streaming sites so they can never drift.
// `content_filter` → 'refusal' (Anthropic's moderation stop) rather than masking a
// blocked/aborted generation as a clean 'end_turn'. Legacy `function_call` is
// intentionally NOT mapped to 'tool_use': modern OpenAI-compatible servers all use
// the `tool_calls` shape, and the legacy function_call payload is never extracted
// here — emitting stop_reason:'tool_use' with no tool_use block would mislead the
// client. It therefore falls through to 'end_turn'.
export function mapFinishReason(fr) {
  return {
    tool_calls: 'tool_use',
    length: 'max_tokens',
    stop: 'end_turn',
    content_filter: 'refusal',
  }[fr] || 'end_turn';
}

// ── Response translation (OpenAI → Anthropic) for non-streaming ──

export function translateResponse(openaiResponse, { localProvider = false } = {}) {
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

  let textBlock = null;
  if (choice.message?.content) {
    textBlock = { type: 'text', text: choice.message.content };
    content.push(textBlock);
  }

  let hasStructuredToolCall = false;
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const input = (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })();
      // US-004: no longer strip _unused/_placeholder — since we stopped injecting
      // them, any such fields in the response are real user params that must be
      // preserved.
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
      hasStructuredToolCall = true;
    }
  }

  // P0.2: if the model emitted NO structured tool_calls but parked a tool call in
  // the text channel, recover it. Gated/local-only via ANYMODEL_PARSE_TEXT_TOOLCALLS.
  let recoveredToolCall = false;
  if (!hasStructuredToolCall && textBlock && textChannelParsingEnabled(localProvider)) {
    const { calls, cleanedText } = extractTextToolCalls(textBlock.text);
    if (calls.length) {
      recoveredToolCall = true;
      if (cleanedText) textBlock.text = cleanedText;
      else content.splice(content.indexOf(textBlock), 1); // drop now-empty text block
      for (const c of calls) {
        content.push({ type: 'tool_use', id: genToolId(), name: c.name, input: c.input });
      }
    }
  }

  const mappedStop = mapFinishReason(choice.finish_reason);
  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResponse.model,
    stop_reason: recoveredToolCall ? 'tool_use' : mappedStop,
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
  // `stopEmitted` — have we already emitted message_delta + message_stop? Used to
  // prevent double-emission when both finish_reason and [DONE] arrive.
  let stopEmitted = false;
  let thinkingBlockIndex = -1;
  let textBlockIndex = -1;
  const stoppedBlocks = new Set();
  // P1.1: route streamed tool-call argument fragments by `tc.index`, not by the
  // most-recently-opened block (`blockIndex-1`). Claude Code batches independent
  // tool calls; OpenAI-compatible servers identify each by `tc.index` and may
  // interleave argument fragments across indices within a single chunk. Without
  // this map, fragments cross-assign → one tool_use accumulates two calls' JSON
  // (parses to {}), the other gets none. Maps tc.index → Anthropic block index.
  const toolBlockByIndex = new Map();

  // US-006: accumulate usage across all chunks. OpenAI-compat streams commonly
  // emit `completion_tokens` in a dedicated usage-only chunk AFTER the
  // finish_reason chunk, so we can't read usage on finish_reason alone.
  let accumulatedStopReason = null;
  let accumulatedOutputTokens = 0;

  function closeOpenBlocks(output) {
    for (let i = 0; i < blockIndex; i++) {
      if (!stoppedBlocks.has(i)) {
        output.push(formatSSE('content_block_stop', { type: 'content_block_stop', index: i }));
        stoppedBlocks.add(i);
      }
    }
  }

  function emitStop(output) {
    if (stopEmitted) return;
    stopEmitted = true;
    closeOpenBlocks(output);
    output.push(formatSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: accumulatedStopReason || 'end_turn' },
      usage: { output_tokens: accumulatedOutputTokens },
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
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          emitStop(output);
          continue;
        }

        try {
          const parsed = JSON.parse(data);

          // US-006: accumulate usage from any chunk that carries it — OpenAI-compat
          // streams may emit a dedicated usage-only chunk after finish_reason.
          if (parsed.usage && typeof parsed.usage.completion_tokens === 'number') {
            accumulatedOutputTokens = parsed.usage.completion_tokens;
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) {
            // A chunk with only `usage` and no delta is valid — we've already
            // captured its usage above. Nothing else to do.
            // Also check if this chunk has finish_reason (unlikely without delta, but handle it).
            if (parsed.choices?.[0]?.finish_reason && !accumulatedStopReason) {
              const fr = parsed.choices[0].finish_reason;
              accumulatedStopReason = mapFinishReason(fr);
            }
            continue;
          }

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
              // P1.1: a compliant server sends the id+name in the first fragment
              // for each index, then arguments-only fragments. Allocate the block
              // on first sighting of ANY index (capturing id/name when present) so
              // a leading arguments fragment never misroutes.
              const tcIdx = tc.index ?? 0;
              if (!toolBlockByIndex.has(tcIdx)) {
                const bi = blockIndex++;
                toolBlockByIndex.set(tcIdx, bi);
                output.push(formatSSE('content_block_start', {
                  type: 'content_block_start',
                  index: bi,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id || genToolId(),
                    name: tc.function?.name || '',
                    input: {},
                  },
                }));
              }
              if (tc.function?.arguments) {
                // US-004: no longer strip _unused/_placeholder — since we stopped
                // injecting them, any such fields here are real user params.
                const bi = toolBlockByIndex.get(tcIdx);
                output.push(formatSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: bi,
                  delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                }));
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason && !accumulatedStopReason) {
            // Record stop reason — we may receive more chunks (dedicated usage chunk)
            // before the stream terminates, so don't emit message_delta yet. The
            // [DONE] sentinel (or a final flush) is what commits the stop event.
            const fr = parsed.choices[0].finish_reason;
            accumulatedStopReason = mapFinishReason(fr);
          }
        } catch (e) {
          console.warn(`[SSE PARSE] Dropped chunk: ${e.message}`);
        }
      }

      return output.join('');
    },

    // Flush any pending stop event if the stream ends without an explicit
    // [DONE] sentinel. Callers that know the stream closed cleanly should
    // invoke this to ensure the proxy emits message_delta + message_stop.
    flush() {
      const output = [];
      emitStop(output);
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
