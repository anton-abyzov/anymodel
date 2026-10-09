// Shared Messages validation and bounded I/O. No network side effects.
import { randomUUID } from 'node:crypto';

// Internal, non-enumerable bridge from Claude Code's `output_config.effort` to
// provider-specific request knobs. JSON.stringify will not leak it.
export const INTERNAL_EFFORT_FIELD = '__anymodel_effort';

export function copyInternalEffort(source, target) {
  if (source?.[INTERNAL_EFFORT_FIELD] === undefined || !target) return target;
  Object.defineProperty(target, INTERNAL_EFFORT_FIELD, {
    value: source[INTERNAL_EFFORT_FIELD],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

// P1.6: canonical Anthropic error envelope. Claude Code keys its error handling
// — especially retry/backoff on 429/5xx — off the Anthropic shape
// `{type:"error", error:{type,message}}` and a recognized `error.type`. Flat
// `{error:{...}}` shapes or non-canonical type strings (`rate_limit` vs
// `rate_limit_error`, `proxy_error` vs `api_error`) degrade client recovery.
// Canonical inner types: invalid_request_error, authentication_error,
// permission_error, not_found_error, rate_limit_error, api_error, overloaded_error.
export function sendError(res, status, type, message, extraHeaders = {}) {
  if (res.writableEnded) return;
  // If the response already streamed headers (e.g. a streaming turn threw after
  // writeHead 200), we cannot change the status — just close cleanly rather than
  // crash with ERR_HTTP_HEADERS_SENT.
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

// P1.6: pull a short human-readable message out of an upstream error body so the
// canonical envelope keeps the upstream detail without leaking the foreign shape.
// Handles OpenAI flat `{error:{message}}`, string `{error:"..."}` (LM Studio),
// and bare-string bodies. Returns '' when nothing useful is found.
export function extractUpstreamErrorMessage(errBody) {
  if (!errBody) return '';
  try {
    const o = JSON.parse(errBody);
    const m = (o && o.error && (o.error.message || (typeof o.error === 'string' ? o.error : null))) || o?.message;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300);
  } catch {
    const s = String(errBody).trim();
    if (s && !s.startsWith('<')) return s.slice(0, 300);
  }
  return '';
}

// P1.7: default to loopback. `server.listen(port, cb)` with no host binds all
// interfaces (0.0.0.0), so with the default no-token config the proxy was
// reachable from the LAN with no auth — anyone could POST /v1/messages to spend
// the user's cloud credits or drive the local GPU. Exposing now requires an
// explicit ANYMODEL_HOST / --host opt-in.
export function resolveBindHost(host) {
  return host || process.env.ANYMODEL_HOST || '127.0.0.1';
}
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// P1.8: when fronting a LOCAL provider, never forward the client's real Anthropic
// credentials to api.anthropic.com on passthrough housekeeping routes. cli.mjs
// injects a dummy key by default, but a user with a real ANTHROPIC_API_KEY
// exported (or launching Claude Code independently) would otherwise egress it.
export function stripAuthHeaders(headers) {
  const out = { ...headers };
  delete out['x-api-key'];
  delete out['authorization'];
  return out;
}

// P1.9: cap buffered bodies. Every buffered read was unbounded `chunks.push` +
// `Buffer.concat`; a large body OOMs the proxy (a trivial LAN DoS once exposed).
// Default 64MB, override via ANYMODEL_MAX_BODY_BYTES.
export function maxBodyBytes() {
  return Number(process.env.ANYMODEL_MAX_BODY_BYTES) || 64 * 1024 * 1024;
}

// Read a request/response stream into a Buffer, enforcing a byte cap. Fails fast
// on a Content-Length already over the cap, and aborts mid-stream if the running
// size exceeds it. Rejects with an error whose `.code` is 'BODY_TOO_LARGE'.
export function readCappedBody(stream, limit = maxBodyBytes()) {
  return new Promise((resolve, reject) => {
    const declared = Number(stream.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const e = new Error(`body exceeds ${limit} bytes (content-length ${declared})`);
      e.code = 'BODY_TOO_LARGE';
      stream.resume(); // drain so the socket can close cleanly
      return reject(e);
    }
    const chunks = [];
    let size = 0;
    let exceeded = false;
    stream.on('data', c => {
      if (exceeded) return;
      size += c.length;
      if (size > limit) {
        const e = new Error(`body exceeds ${limit} bytes`);
        e.code = 'BODY_TOO_LARGE';
        exceeded = true;
        chunks.length = 0;
        stream.resume();
        return reject(e);
      }
      chunks.push(c);
    });
    stream.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    stream.on('aborted', () => reject(new Error('Stream aborted before body completed')));
    stream.on('error', reject);
  });
}

// P1.9: guard a JSON.parse over an upstream body. On failure returns null (callers
// surface an Anthropic api_error) instead of throwing into the retry loop, which
// masked the real content as a generic 502 + spurious retry.
export function safeJsonParse(str) {
  try { return { ok: true, value: JSON.parse(str) }; }
  catch (e) { return { ok: false, error: e }; }
}

// Sanitize tool_use blocks in responses from non-Anthropic models.
// Fixes structural issues that cause "Invalid tool parameters" in Claude Code.
//
// NOTE: Since 1.12.0 we no longer inject `_unused`/`_placeholder` placeholder
// properties in requests (see `sanitizeBody` — empty schemas use the canonical
// `{type:"object", properties:{}, additionalProperties:false}` form instead).
// Consequently this function no longer strips those fields — real tools with
// params named `_unused` now round-trip cleanly.
export function sanitizeToolUseResponse(respObj) {
  if (!respObj?.content || !Array.isArray(respObj.content)) return respObj;

  respObj.content = respObj.content.filter(block => {
    if (block.type !== 'tool_use') return true;

    // Ensure required fields exist. P2.7: randomUUID avoids the Date.now()+Math.random
    // collisions that two parallel tool calls in the same ms could hit, which would
    // break tool_use/tool_result id correlation.
    if (!block.id) block.id = `toolu_${randomUUID()}`;
    if (!block.name) return false; // drop tool_use with no name — invalid
    if (!block.input || typeof block.input !== 'object') block.input = {};

    return true;
  });

  return respObj;
}

// Strip Anthropic-specific fields that break non-Anthropic providers
// keepCache=true preserves cache_control for providers that support it (OpenRouter → Anthropic models)
export function sanitizeBody(body, { keepCache = false, preserveNative = false } = {}) {
  const effort = body.output_config?.effort;
  if (effort !== undefined) {
    copyInternalEffort({ [INTERNAL_EFFORT_FIELD]: effort }, body);
  }
  delete body.betas;
  delete body.metadata;
  delete body.speed;
  if (!preserveNative) delete body.output_config;
  delete body.context_management;
  // Keep body.thinking — OpenRouter passes it to reasoning models (DeepSeek R1, etc.)
  // to enable visible chain-of-thought. Only strip for providers that reject it.

  // Clamp max_tokens / max_output_tokens: OpenAI/GPT require >= 16
  // OpenRouter translates max_tokens → max_output_tokens for GPT models
  if (body.max_tokens != null && body.max_tokens < 16) {
    body.max_tokens = 16;
  }
  if (body.max_output_tokens != null && body.max_output_tokens < 16) {
    body.max_output_tokens = 16;
  }

  // Strip cache_control from system/message/tool blocks (only for providers that don't support it)
  if (!keepCache) {
    if (Array.isArray(body.system)) {
      body.system = body.system.map(block => {
        if (block && typeof block === 'object' && block.cache_control) {
          const { cache_control, ...rest } = block;
          return rest;
        }
        return block;
      });
    }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.map(block => {
            if (block && typeof block === 'object' && block.cache_control) {
              const { cache_control, ...rest } = block;
              return rest;
            }
            return block;
          });
        }
      }
    }
  }

  // Strip unsupported tool fields; preserve explicit and implicit dictionary semantics.
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
      // Native server tools have provider-defined shapes, not client function
      // schemas. Free-only policy rejects them before reaching this sanitizer.
      if (preserveNative && typeof tool?.type === 'string' && !['custom', 'function'].includes(tool.type)) return tool;
      const stripFields = keepCache
        ? { defer_loading: true, eager_input_streaming: true, strict: true }
        : { cache_control: true, defer_loading: true, eager_input_streaming: true, strict: true };
      const rest = { ...tool };
      for (const key of Object.keys(stripFields)) delete rest[key];

      // Fix schemas that OpenAI/strict-mode parsers reject:
      // 1. Missing input_schema entirely
      // 2. Missing or empty properties
      // Use the standard JSON-Schema "empty object" form — {type:"object", properties:{}, additionalProperties:false}
      // This is accepted by OpenAI, Groq, Together, vLLM, LMStudio, Ollama, and real
      // tool params named `_unused` are preserved end-to-end (US-004 fix, 1.12.0).
      const emptyObjectSchema = () => ({ type: 'object', properties: {}, additionalProperties: false });
      if (!rest.input_schema || typeof rest.input_schema !== 'object') {
        rest.input_schema = emptyObjectSchema();
      } else {
        if (!rest.input_schema.type) {
          rest.input_schema.type = 'object';
        }
        if (rest.input_schema.type === 'object') {
          const props = rest.input_schema.properties;
          if (!props || (typeof props === 'object' && Object.keys(props).length === 0)) {
            rest.input_schema.properties = {};
            if (!Array.isArray(rest.input_schema.required)) rest.input_schema.required = [];
          }
        }
      }

      // Recursively fix nested schemas (anyOf, oneOf, allOf, items)
      const fixNested = (schema) => {
        if (!schema || typeof schema !== 'object') return;
        for (const key of ['anyOf', 'oneOf', 'allOf']) {
          if (Array.isArray(schema[key])) {
            schema[key].forEach(fixNested);
          }
        }
        if (schema.items) fixNested(schema.items);
        if (schema.type === 'object' && schema.properties) {
          if (Object.keys(schema.properties).length === 0) {
            if (!Array.isArray(schema.required)) schema.required = [];
          }
          for (const v of Object.values(schema.properties)) fixNested(v);
        }
      };
      fixNested(rest.input_schema);

      return rest;
    });
  }

  // Normalize tool_choice: providers expect object, clients may send string
  if (typeof body.tool_choice === 'string') {
    body.tool_choice = { type: body.tool_choice };
  }

  return body;
}
