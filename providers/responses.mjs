// OpenAI Responses API ↔ Chat Completions bridge for LOCAL providers.
//
// Why this exists: Codex CLI >= ~0.12x DROPPED support for `wire_api = "chat"` on
// custom providers — it now ONLY speaks the Responses wire (`POST /v1/responses`,
// streaming SSE). LM Studio / llama.cpp / ollama do NOT serve Responses; they serve
// Chat Completions. So to drive a local model through AnyModel from Codex we must:
//   1. translate the inbound Responses request → a Chat Completions request,
//   2. forward it to the local server (which AnyModel already knows how to reach),
//   3. translate the local Chat Completions reply → a Responses SSE stream Codex reads.
//
// Design choice: we call the local server NON-streaming and then EMIT a synthetic
// Responses SSE stream. This is dramatically more robust than re-assembling OpenAI
// chat deltas into Responses deltas (tool_call index/id/argument fragmentation is a
// well-known footgun — see openai.mjs:659-699), and it lets us run the same
// text-channel tool-call recovery the rest of AnyModel uses (Qwen XML → structured
// calls) BEFORE Codex ever sees the turn. Codex's SSE reader only needs the terminal
// events (output_item.added/done + response.completed) to finalize a turn, which a
// synthetic stream provides exactly.

import { extractTextToolCalls, textChannelParsingEnabled, fencedRecoveryEnabled } from './openai.mjs';

let __idSeq = 0;
function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${(__idSeq++).toString(36)}`;
}

// Flatten a Responses content array (or string) to plain text. Responses content
// blocks: {type:'input_text'|'output_text'|'text', text}. tool_result-ish blocks
// are handled by the caller (function_call_output items).
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(c => {
      if (typeof c === 'string') return c;
      if (c && typeof c.text === 'string') return c.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

// Translate a Responses request body → a Chat Completions request body.
// Returns the chat body (always non-streaming; the proxy synthesizes the SSE).
export function responsesToChat(body) {
  const messages = [];

  // `instructions` is the Responses system prompt.
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // `input` is the conversation. Items are either message items
  // ({type:'message', role, content:[...]}) or tool plumbing items
  // ({type:'function_call', call_id, name, arguments} /
  //  {type:'function_call_output', call_id, output}).
  const input = Array.isArray(body.input) ? body.input
    : typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }]
    : [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type || 'message';

    if (type === 'message') {
      // Responses uses role 'developer' for system-ish guidance; map it to system.
      const role = item.role === 'developer' ? 'system' : (item.role || 'user');
      messages.push({ role, content: contentToText(item.content) });
    } else if (type === 'function_call') {
      // Assistant turn that issued a tool call.
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || genId('call'),
          type: 'function',
          function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        }],
      });
    } else if (type === 'function_call_output') {
      // Tool result feeding back in.
      const out = typeof item.output === 'string' ? item.output : contentToText(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id, content: out });
    }
    // Unknown item types (reasoning, etc.) are skipped — local models can't use them.
  }

  const chat = {
    model: body.model,
    messages,
    stream: false,
  };

  // Tools: Responses function tools are FLAT ({type:'function', name, description,
  // parameters}); Chat Completions nests them ({type:'function', function:{...}}).
  // Non-function tools (web_search/image_generation/namespace) are dropped — LM
  // Studio rejects them (this is the proxy-side equivalent of Codex's --disable flags).
  if (Array.isArray(body.tools) && body.tools.length) {
    const fns = body.tools.filter(t => t && t.type === 'function');
    if (fns.length) {
      chat.tools = fns.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
        },
      }));
      if (body.tool_choice && body.tool_choice !== 'auto') chat.tool_choice = body.tool_choice;
    }
  }

  if (typeof body.max_output_tokens === 'number') chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') chat.temperature = body.temperature;

  return { chat, droppedTools: Array.isArray(body.tools) ? body.tools.filter(t => !t || t.type !== 'function').length : 0 };
}

// Build the list of Responses OUTPUT ITEMS from a Chat Completions response,
// running text-channel tool-call recovery (Qwen/Hermes XML → structured calls) so
// Codex never sees raw `<function=...>` syntax (which crashes its tool parser).
// Returns { items, usage }.
export function chatResponseToOutputItems(chatResp, { localProvider = false } = {}) {
  const choice = chatResp?.choices?.[0] || {};
  const msg = choice.message || {};
  const items = [];

  let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice() : [];
  let text = typeof msg.content === 'string' ? msg.content : '';

  // Recover XML tool calls parked in the text channel when no structured calls exist.
  if (toolCalls.length === 0 && text && textChannelParsingEnabled(localProvider)) {
    const { calls, cleanedText } = extractTextToolCalls(text, { allowFenced: fencedRecoveryEnabled() });
    if (calls.length) {
      toolCalls = calls.map(c => ({ id: genId('call'), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
      text = cleanedText;
    }
  }

  // Emit a message item for any residual assistant text.
  if (text && text.trim()) {
    items.push({
      type: 'message',
      id: genId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    });
  }

  // Emit a function_call item per tool call (Responses shape).
  for (const tc of toolCalls) {
    items.push({
      type: 'function_call',
      id: genId('fc'),
      call_id: tc.id || genId('call'),
      name: tc.function?.name,
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
      status: 'completed',
    });
  }

  const usage = {
    input_tokens: chatResp?.usage?.prompt_tokens || 0,
    output_tokens: chatResp?.usage?.completion_tokens || 0,
    total_tokens: chatResp?.usage?.total_tokens || 0,
  };
  return { items, usage };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Serialize output items + usage into a complete Responses SSE byte stream.
// Emits the minimal event sequence Codex's reader requires to finalize a turn:
//   response.created
//   (per item) response.output_item.added → response.output_item.done
//   response.completed
// Returns an array of SSE chunk strings (caller writes them then ends + [DONE]-free;
// Responses SSE terminates on response.completed, not a [DONE] sentinel).
export function buildResponsesSSE({ responseId, model, items, usage }) {
  const id = responseId || genId('resp');
  const base = {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model, output: items, usage,
  };
  const chunks = [];
  chunks.push(sse('response.created', { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } }));
  items.forEach((item, index) => {
    chunks.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: index, item }));
    chunks.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: index, item }));
  });
  chunks.push(sse('response.completed', { type: 'response.completed', response: base }));
  return chunks;
}

// OpenAI Responses error event so Codex surfaces a real failure instead of hanging.
export function buildResponsesError(message) {
  return sse('response.failed', {
    type: 'response.failed',
    response: { id: genId('resp'), object: 'response', status: 'failed', error: { code: 'server_error', message } },
  });
}
