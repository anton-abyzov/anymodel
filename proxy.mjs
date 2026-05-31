// Core proxy server for anymodel
// Routes /v1/messages → provider, everything else → api.anthropic.com

import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));

// HTTP keep-alive agents — reuse TCP connections to reduce per-request latency.
// Without these, every request opens a new TCP connection (3-way handshake + TLS for HTTPS).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

export const MAX_RETRIES = 3;

// ANSI colors
const C = {
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

// P1.6: canonical Anthropic error envelope. Claude Code keys its error handling
// — especially retry/backoff on 429/5xx — off the Anthropic shape
// `{type:"error", error:{type,message}}` and a recognized `error.type`. Flat
// `{error:{...}}` shapes or non-canonical type strings (`rate_limit` vs
// `rate_limit_error`, `proxy_error` vs `api_error`) degrade client recovery.
// Canonical inner types: invalid_request_error, authentication_error,
// permission_error, not_found_error, rate_limit_error, api_error, overloaded_error.
export function sendError(res, status, type, message, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
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
    stream.on('data', c => {
      size += c.length;
      if (size > limit) {
        const e = new Error(`body exceeds ${limit} bytes`);
        e.code = 'BODY_TOO_LARGE';
        stream.destroy();
        return reject(e);
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
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

    // Ensure required fields exist
    if (!block.id) block.id = `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!block.name) return false; // drop tool_use with no name — invalid
    if (!block.input || typeof block.input !== 'object') block.input = {};

    return true;
  });

  return respObj;
}

// Strip Anthropic-specific fields that break non-Anthropic providers
// keepCache=true preserves cache_control for providers that support it (OpenRouter → Anthropic models)
export function sanitizeBody(body, { keepCache = false } = {}) {
  delete body.betas;
  delete body.metadata;
  delete body.speed;
  delete body.output_config;
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

  // Strip Anthropic-only tool fields and fix empty input_schema.properties
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
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
            rest.input_schema.additionalProperties = false;
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
            schema.additionalProperties = false;
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

// Calculate exponential backoff delay, capped at 8s
export function calcDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

// Check if a URL path should be routed to the provider
export function isProviderRoute(url) {
  return url.startsWith('/v1/messages');
}

export function injectPlatformHints(parsed, platform) {
  if (platform !== 'win32' || !parsed.system) return;
  const hint = 'The user is on Windows. Use Windows-style file paths (e.g., C:\\Users\\name\\project). Use backslashes for paths in shell commands.';
  if (Array.isArray(parsed.system)) {
    parsed.system.push({ type: 'text', text: hint });
  } else if (typeof parsed.system === 'string') {
    parsed.system += '\n' + hint;
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Load .env file if present (from given dir, or cwd)
export function loadEnv(dir) {
  try {
    const envPath = dir ? `${dir}/.env` : `${process.cwd()}/.env`;
    const envFile = readFileSync(envPath, 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[ENV] Failed to load .env: ${e.message}`);
  }
}

// P0.3: a stalled local model (or a silent TCP connection) would otherwise hang
// the proxy forever — the existing retry loop never fires because a hang is
// neither a status code nor a thrown error. An idle timeout turns that into a
// recoverable, visible failure that the retry/catch loop can handle.
// Read at call time (not frozen at import) so ANYMODEL_UPSTREAM_TIMEOUT_MS can be
// set by the launcher/env after this module loads.
export function upstreamTimeoutMs() {
  return Number(process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS) || 300000;
}

function sendRequest(provider, url, payload) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
  const opts = provider.buildRequest(url, payload, apiKey);
  const timeoutMs = upstreamTimeoutMs();

  return new Promise((resolve, reject) => {
    const isSecure = opts.port === 443 || opts.protocol === 'https:';
    const transport = isSecure ? https : http;
    const agent = isSecure ? httpsAgent : httpAgent;
    const req = transport.request(
      { ...opts, agent, timeout: timeoutMs },
      upstream => {
        // The request-level timeout only covers the header phase. Re-arm it on
        // the response socket so a stream that goes idle mid-body is aborted;
        // Node resets this timer on every received chunk, so a long-but-active
        // stream survives.
        upstream.setTimeout(timeoutMs, () => {
          upstream.destroy(new Error(`upstream idle timeout after ${timeoutMs}ms`));
        });
        resolve(upstream);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`upstream connect/header timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleMessages(req, res, provider, model, isFreeTierModel) {
  let raw;
  try {
    raw = await readCappedBody(req);
  } catch (e) {
    if (e.code === 'BODY_TOO_LARGE') {
      console.log(`${C.red('[BODY]')} Inbound body exceeds cap: ${e.message}`);
      sendError(res, 413, 'invalid_request_error', `Request body exceeds ${maxBodyBytes()} bytes (ANYMODEL_MAX_BODY_BYTES)`);
    } else {
      sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
    }
    return;
  }

  const jp = safeJsonParse(raw.toString());
  if (!jp.ok) {
    sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    return;
  }
  const parsed = jp.value;

  const originalModel = parsed.model;
  if (model) parsed.model = model;

  // Free-only enforcement: block paid models
  if (isFreeTierModel && !isFreeTierModel(parsed.model)) {
    console.log(`${C.red('[FREE-ONLY]')} Blocked paid model: ${parsed.model}`);
    sendError(res, 403, 'permission_error', `Model "${parsed.model}" is not free. Use --model with a :free model or disable --free-only.`);
    return;
  }

  // Preserve cache_control for OpenRouter (supports Anthropic prompt caching)
  // Strip it for Ollama/OpenAI providers that reject it
  const keepCache = provider.name === 'openrouter';
  sanitizeBody(parsed, { keepCache });

  // Inject Windows path hint — LLMs default to Unix-style paths
  injectPlatformHints(parsed, process.platform);

  // Treat ollama, lmstudio, and llamacpp identically as "local" — all three suffer
  // from Claude Code's 200KB+ system prompts + 90-tool schemas that blow past
  // practical context windows on 30B-class local models.
  const isLocal = provider.name === 'ollama' || provider.name === 'lmstudio' || provider.name === 'llamacpp';
  const localTag = `[${provider.name.toUpperCase()}]`;

  // Tool handling for local providers — capability-aware instead of blanket strip.
  // Many modern local models (Qwen 3, Llama 3.1+, Mistral, Gemma 4) support tool calling.
  // OLLAMA_TOOLS env: 'auto' (default) tries with tools and caches result per model,
  // 'on' always passes tools, 'off' always strips (legacy behavior).
  if (isLocal && parsed.tools && parsed.tools.length > 0) {
    const { shouldSendTools, ollamaToolMode } = await import('./providers/ollama-tools.mjs');
    const mode = ollamaToolMode();
    if (!shouldSendTools(parsed.model)) {
      console.log(`${C.yellow(localTag)} Stripping ${parsed.tools.length} tools (mode=${mode}, model=${parsed.model} cached as no-tool-support)`);
      delete parsed.tools;
    } else {
      console.log(`${C.yellow(localTag)} Passing ${parsed.tools.length} tools to ${parsed.model} (mode=${mode})`);
    }
    // Always strip tool_choice — local providers don't need it (some reject it)
    if (provider.name === 'ollama') delete parsed.tool_choice;

    // Smart tool optimization: compress schemas + trim descriptions + budget-limit.
    // Instead of blindly stripping by count, this compresses JSON Schema param
    // definitions (removes $schema, additionalProperties, param descriptions,
    // defaults, examples → 50-70% smaller), then budget-allocates by priority
    // tier (core > important > rest) to fit within context window.
    if (parsed.tools && parsed.tools.length > 0) {
      const { optimizeTools } = await import('./providers/tool-compressor.mjs');
      // Default context budget. lmstudio + llamacpp typically have larger loaded
      // context (128k common), so we allow 30% for tools by default. Ollama's
      // default is 8k ctx so it stays conservative.
      const numCtx = provider.name === 'ollama'
        ? (parseInt(process.env.OLLAMA_NUM_CTX, 10) || 8192)
        : parseInt(process.env.LOCAL_NUM_CTX, 10) || 32768;
      const { tools: optimized, stats } = optimizeTools(parsed.tools, {
        numCtx,
        maxTools: parseInt(process.env.LOCAL_MAX_TOOLS || process.env.OLLAMA_MAX_TOOLS, 10) || 0,
        maxDescLen: parseInt(process.env.LOCAL_MAX_TOOL_DESC || process.env.OLLAMA_MAX_TOOL_DESC, 10) || 100,
        budgetPct: parseFloat(process.env.LOCAL_TOOL_BUDGET_PCT || process.env.OLLAMA_TOOL_BUDGET_PCT) || 0.30,
      });
      parsed.tools = optimized;
      if (stats) {
        if (stats.trimmed) {
          console.log(`${C.yellow(localTag)} Tool optimization: ${stats.original.count} tools (${stats.original.tokens} tok) → compressed (${stats.compressed.tokens} tok) → budgeted to ${stats.final.count} tools (${stats.final.tokens} tok). Budget: ${Math.round(stats.budget.pct * 100)}% of ctx=${stats.budget.numCtx}`);
        } else {
          console.log(`${C.yellow(localTag)} Tool optimization: ${stats.original.count} tools (${stats.original.tokens} tok) → compressed to ${stats.compressed.tokens} tok (${Math.round((1 - stats.compressed.tokens / stats.original.tokens) * 100)}% reduction)`);
        }
      }
    }
  }

  // Strip thinking/extended-thinking for all local providers.
  // Claude Code sends thinking: {type: "enabled", budget_tokens: N} which causes
  // reasoning models (qwen3, deepseek, gemma4) to waste output tokens on hidden
  // chain-of-thought instead of producing actual text.
  if (isLocal) {
    delete parsed.thinking;
  }

  // Condense system prompt for all local providers.
  // Claude Code sends 50-100KB system prompts with every request. On local models,
  // processing 15K+ tokens of system instructions takes 2-3 minutes BEFORE any output.
  // Condense to essential context only — keeps CLAUDE.md project instructions,
  // strips Claude Code behavioral rules that local models can't follow anyway.
  if (isLocal && parsed.system) {
    const MAX_SYSTEM_CHARS = parseInt(process.env.LOCAL_MAX_SYSTEM_CHARS || process.env.OLLAMA_MAX_SYSTEM_CHARS, 10) || 4000;
    // Flatten system prompt to text
    let fullSystem = '';
    if (Array.isArray(parsed.system)) {
      fullSystem = parsed.system.map(b => typeof b === 'string' ? b : b.text || '').join('\n');
    } else if (typeof parsed.system === 'string') {
      fullSystem = parsed.system;
    }

    if (fullSystem.length > MAX_SYSTEM_CHARS) {
      const originalLen = fullSystem.length;
      // Extract CLAUDE.md / project-specific content (user's custom instructions)
      const claudeMdSections = [];
      const claudeMdPattern = /Contents of [^\n]*CLAUDE\.md[^\n]*:\n([\s\S]*?)(?=\nContents of |$)/gi;
      let match;
      while ((match = claudeMdPattern.exec(fullSystem)) !== null) {
        claudeMdSections.push(match[1].trim());
      }
      // Also extract any "# currentDate" or environment context
      const dateMatch = fullSystem.match(/# currentDate\n.*?(\d{4}-\d{2}-\d{2})/);
      const dateInfo = dateMatch ? `Today: ${dateMatch[1]}` : '';

      // Build condensed system prompt
      const condensed = [
        'You are a helpful AI coding assistant. Answer concisely and accurately.',
        'Use the tools available to you when needed. Write clean, working code.',
        dateInfo,
        claudeMdSections.length > 0
          ? `\n# Project Instructions\n${claudeMdSections.join('\n\n').slice(0, MAX_SYSTEM_CHARS - 500)}`
          : '',
      ].filter(Boolean).join('\n').slice(0, MAX_SYSTEM_CHARS);

      parsed.system = condensed;
      console.log(`${C.yellow(localTag)} Condensed system prompt: ${originalLen} → ${condensed.length} chars (${Math.round((1 - condensed.length / originalLen) * 100)}% reduction)`);
    }
  }

  // Strip Claude Code boilerplate from messages for local models.
  // Claude Code injects <system-reminder> blocks, skill lists, MCP instructions,
  // and other XML-tagged content into user messages. These can add 20-30KB per message
  // that local models can't use — causing 50s+ processing on first request.
  if (isLocal && parsed.messages) {
    const xmlTagPattern = /<(?:system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout|functions|function)>[\s\S]*?<\/(?:system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout|functions|function)>/gi;

    let strippedChars = 0;
    for (const msg of parsed.messages) {
      if (typeof msg.content === 'string') {
        const before = msg.content.length;
        msg.content = msg.content.replace(xmlTagPattern, '').trim();
        strippedChars += before - msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const before = block.text.length;
            block.text = block.text.replace(xmlTagPattern, '').trim();
            strippedChars += before - block.text.length;
          }
        }
      }
    }
    if (strippedChars > 0) {
      console.log(`${C.yellow(localTag)} Stripped ${(strippedChars / 1024).toFixed(1)}KB of XML boilerplate from messages`);
    }

    // Condense message history — drop middle turns to stay under token budget.
    // Scale limit to context window: num_ctx tokens × ~4 chars/token × 75% (leave room for output)
    const numCtx = provider.name === 'ollama'
      ? (parseInt(process.env.OLLAMA_NUM_CTX, 10) || 8192)
      : (parseInt(process.env.LOCAL_NUM_CTX, 10) || 32768);
    const MAX_MSG_CHARS = parseInt(process.env.LOCAL_MAX_MSG_CHARS || process.env.OLLAMA_MAX_MSG_CHARS, 10) || Math.max(4000, numCtx * 3);
    const totalChars = parsed.messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.reduce((s, b) => s + (b.text || JSON.stringify(b.input || '')).length, 0)
        : 0;
      return sum + content;
    }, 0);

    if (totalChars > MAX_MSG_CHARS) {
      const originalCount = parsed.messages.length;
      if (parsed.messages.length > 4) {
        // Keep first 2 + last N messages
        const keep = Math.max(4, Math.min(parsed.messages.length, Math.floor(MAX_MSG_CHARS / (totalChars / parsed.messages.length))));
        if (keep < parsed.messages.length) {
          const head = parsed.messages.slice(0, 2);
          const tail = parsed.messages.slice(-(keep - 2));
          parsed.messages = [...head, { role: 'user', content: '[Earlier conversation condensed]' }, ...tail];
        }
      } else {
        // Few messages but still too large — truncate each message's content
        for (const msg of parsed.messages) {
          const maxPerMsg = Math.floor(MAX_MSG_CHARS / parsed.messages.length);
          if (typeof msg.content === 'string' && msg.content.length > maxPerMsg) {
            msg.content = msg.content.slice(-maxPerMsg);
          } else if (Array.isArray(msg.content)) {
            let msgLen = 0;
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                msgLen += block.text.length;
                if (msgLen > maxPerMsg) {
                  block.text = block.text.slice(-(maxPerMsg));
                }
              }
            }
          }
        }
      }
      const newChars = parsed.messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content
          : Array.isArray(m.content) ? m.content.reduce((s, b) => s + (b.text || '').length, 0)
          : 0;
        return sum + content;
      }, 0);
      console.log(`${C.yellow(localTag)} Condensed messages: ${originalCount} → ${parsed.messages.length} msgs, ${(totalChars / 1024).toFixed(1)}KB → ${(newChars / 1024).toFixed(1)}KB`);
    }
  }

  // Prefix caching for Ollama — ensure byte-stable system+tools prefix
  // so llama.cpp's implicit KV cache reuse kicks in (17.7x speedup).
  let prefixCacheResult = null;
  if (provider.name === 'ollama') {
    const { getOrStore } = await import('./providers/prefix-cache.mjs');
    const systemStr = typeof parsed.system === 'string' ? parsed.system
      : Array.isArray(parsed.system) ? parsed.system.map(b => typeof b === 'string' ? b : b.text || '').join('\n')
      : '';
    prefixCacheResult = getOrStore(parsed.model, systemStr, parsed.tools || null);
    parsed.system = prefixCacheResult.system;
    if (prefixCacheResult.tools) parsed.tools = prefixCacheResult.tools;
    if (!prefixCacheResult.hit) {
      console.log(`${C.yellow('[PREFIX]')} Cache miss for ${parsed.model} — new prefix stored (${prefixCacheResult.tokenEstimate} est. tokens)`);
    }
  }

  // If provider has format translation (e.g., openai), apply it
  const isStreaming = parsed.stream;
  const requestBody = provider.transformRequest ? provider.transformRequest(parsed) : parsed;
  const payload = JSON.stringify(requestBody);
  const modelDisplay = model ? `${originalModel} \u2192 ${model}` : originalModel;
  const toolCount = parsed.tools ? parsed.tools.length : 0;

  const reqStartTime = Date.now();
  const payloadKB = (Buffer.byteLength(payload) / 1024).toFixed(1);
  const msgCount = (parsed.messages || []).length;
  console.log(`${C.cyan(`[${provider.name.toUpperCase()}]`)} ${req.method} ${req.url} model=${modelDisplay}${toolCount ? ` tools=${toolCount}` : ''}${isStreaming ? ' stream=true' : ''} (${payloadKB} KB, ${msgCount} msgs)`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await sendRequest(provider, req.url, payload);

      if (upstream.statusCode === 429 || upstream.statusCode >= 500) {
        const errChunks = [];
        upstream.on('data', c => errChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        const errBody = Buffer.concat(errChunks).toString();

        // Extract rate limit headers from upstream response
        const retryAfter = upstream.headers['retry-after'];
        const rlReset = upstream.headers['x-ratelimit-reset'];
        const rlRemaining = upstream.headers['x-ratelimit-remaining'];
        const rlLimit = upstream.headers['x-ratelimit-limit'];

        let retryDelay = calcDelay(attempt);

        const tag = C.red(`[${provider.name.toUpperCase()}]`);
        console.log(`${tag} ${upstream.statusCode} on attempt ${attempt}/${MAX_RETRIES}`);

        if (upstream.statusCode === 429) {
          // Log all available rate limit headers
          if (rlLimit || rlRemaining) {
            console.log(`${tag} Rate limit: ${rlRemaining ?? '?'}/${rlLimit ?? '?'} remaining`);
          }
          if (retryAfter) {
            const retrySec = Number(retryAfter);
            if (!Number.isNaN(retrySec)) {
              retryDelay = retrySec * 1000;
              console.log(`${tag} Retry-After: ${retrySec}s`);
            } else {
              // retry-after can be an HTTP-date
              const retryDate = new Date(retryAfter);
              if (!isNaN(retryDate.getTime())) {
                const waitMs = retryDate.getTime() - Date.now();
                if (waitMs > 0) {
                  retryDelay = waitMs;
                  console.log(`${tag} Retry-After: ${retryAfter} (${Math.ceil(waitMs / 1000)}s from now)`);
                }
              }
            }
          } else if (rlReset) {
            // x-ratelimit-reset is typically a unix epoch timestamp
            const resetEpoch = Number(rlReset);
            if (!Number.isNaN(resetEpoch)) {
              const nowSec = Math.floor(Date.now() / 1000);
              const waitSec = resetEpoch > nowSec ? resetEpoch - nowSec : resetEpoch;
              retryDelay = waitSec * 1000;
              console.log(`${tag} Rate limit resets in ${waitSec}s`);
            }
          } else {
            console.log(`${tag} No retry-after or x-ratelimit-reset header (free models: ~10 req/min, resets each minute)`);
          }
        }

        console.log(`${tag} ${errBody.slice(0, 200)}`);

        if (attempt === MAX_RETRIES) {
          // Forward rate limit headers to the client
          const headers = { ...upstream.headers };
          if (retryAfter) headers['retry-after'] = retryAfter;
          res.writeHead(upstream.statusCode, headers);
          res.end(errBody);
          return;
        }

        console.log(`${tag} Retrying in ${Math.ceil(retryDelay / 1000)}s...`);
        await sleep(retryDelay);
        continue;
      }

      if (upstream.statusCode !== 200) {
        const errChunks = [];
        upstream.on('data', c => errChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        const errBody = Buffer.concat(errChunks).toString();

        // Auto-retry without tools if model doesn't support tool use
        const { isToolError: checkToolErr, cacheToolResult: cacheResult } = await import('./providers/ollama-tools.mjs');
        if (checkToolErr(errBody) && parsed.tools && parsed.tools.length > 0) {
          console.log(`${C.yellow(`[${provider.name.toUpperCase()}]`)} Model doesn't support tool use (${parsed.tools.length} tools). Retrying without tools...`);
          // Cache this model as not supporting tools (for Ollama auto mode)
          if (provider.name === 'ollama') {
            cacheResult(parsed.model, false);
            console.log(`${C.yellow('[OLLAMA]')} Cached: ${parsed.model} does not support tools`);
          }
          const noToolsBody = { ...parsed };
          delete noToolsBody.tools;
          delete noToolsBody.tool_choice;
          const noToolsRequest = provider.transformRequest ? provider.transformRequest(noToolsBody) : noToolsBody;
          const noToolsPayload = JSON.stringify(noToolsRequest);
          const retryUpstream = await sendRequest(provider, req.url, noToolsPayload);
          if (retryUpstream.statusCode === 200) {
            console.log(`${C.green(`[${provider.name.toUpperCase()}]`)} 200 ← response (no tools mode)`);
            if (!isStreaming) {
              const respChunks = [];
              retryUpstream.on('data', c => respChunks.push(c));
              await new Promise(r => retryUpstream.on('end', r));
              let respStr = Buffer.concat(respChunks).toString();
              res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(respStr) });
              res.end(respStr);
            } else {
              res.writeHead(200, retryUpstream.headers);
              retryUpstream.pipe(res);
            }
            return;
          }
          // If retry also fails, fall through to error
          const retryErr = [];
          retryUpstream.on('data', c => retryErr.push(c));
          await new Promise(r => retryUpstream.on('end', r));
          console.log(`${C.red(`[${provider.name.toUpperCase()}]`)} Retry without tools also failed: ${retryUpstream.statusCode}`);
        }

        const tag = C.red(`[${provider.name.toUpperCase()}]`);
        console.log(`${tag} ${upstream.statusCode}: ${errBody.slice(0, 300)}`);

        // Intercept upstream auth/ToS errors — return clear Anthropic-shaped error
        if (upstream.statusCode === 401 || upstream.statusCode === 403) {
          const providerLabel = provider.name.charAt(0).toUpperCase() + provider.name.slice(1);
          const isToS = errBody.includes('Terms') || errBody.includes('prohibited') || errBody.includes('ToS');
          const isFreeModel = parsed.model && parsed.model.endsWith(':free');

          let userMessage;
          if (isToS && isFreeModel) {
            userMessage = `[anymodel] Free model "${parsed.model}" rejected this request (too large or restricted by provider ToS). Free models have strict limits on prompt size and tool use. Fix: use a paid model instead — e.g. npx anymodel proxy --model qwen/qwen3-coder (without :free)`;
          } else if (isToS) {
            userMessage = `[anymodel] ${providerLabel} rejected this request due to provider Terms of Service. This can happen with large prompts or tool-heavy requests. Try a different model or check your provider account status.`;
          } else {
            userMessage = `[anymodel] ${providerLabel} API key is invalid or expired. Check your ${provider.name === 'openrouter' ? 'OPENROUTER_API_KEY' : provider.name === 'openai' ? 'OPENAI_API_KEY' : 'provider API key'}.`;
          }

          console.log(`${tag} ${isToS ? 'ToS rejection' : 'Auth error'}: ${isFreeModel ? '(free model) ' : ''}${errBody.slice(0, 200)}`);
          sendError(res, 400, 'invalid_request_error', userMessage);
          return;
        }

        // Auto-fallback to :free model on 402 (insufficient credits)
        if (upstream.statusCode === 402 && parsed.model && !parsed.model.endsWith(':free')) {
          const freeModel = parsed.model + ':free';
          console.log(`${C.yellow(`[${provider.name.toUpperCase()}]`)} No credits — trying free variant: ${C.bold(freeModel)}`);
          const freeBody = { ...requestBody, model: freeModel };
          const freePayload = JSON.stringify(freeBody);
          try {
            const freeUpstream = await sendRequest(provider, req.url, freePayload);
            if (freeUpstream.statusCode === 200) {
              console.log(`${C.green(`[${provider.name.toUpperCase()}]`)} ${C.bold(':free')} fallback succeeded — using ${freeModel}`);
              if (!isStreaming) {
                const respChunks = [];
                freeUpstream.on('data', c => respChunks.push(c));
                await new Promise(r => freeUpstream.on('end', r));
                let respStr = Buffer.concat(respChunks).toString();
                if (provider.transformResponse) {
                  // P1.9: guard the upstream parse — a malformed free response was
                  // previously mis-reported as "no free variant".
                  const parsedFree = safeJsonParse(respStr);
                  if (!parsedFree.ok) {
                    console.error(`${C.red(`[${provider.name.toUpperCase()}]`)} :free upstream returned non-JSON body: ${respStr.slice(0, 120)}`);
                    sendError(res, 502, 'api_error', 'Upstream returned a non-JSON response body');
                    return;
                  }
                  const translated = provider.transformResponse(parsedFree.value);
                  sanitizeToolUseResponse(translated);
                  respStr = JSON.stringify(translated);
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(respStr);
              } else {
                res.writeHead(200, freeUpstream.headers);
                freeUpstream.pipe(res);
              }
              return;
            }
            // Drain failed free response
            const freeErr = [];
            freeUpstream.on('data', c => freeErr.push(c));
            await new Promise(r => freeUpstream.on('end', r));
            console.log(`${C.yellow(`[${provider.name.toUpperCase()}]`)} :free fallback also failed (${freeUpstream.statusCode})`);
          } catch (e) {
            console.log(`${C.red(`[${provider.name.toUpperCase()}]`)} :free fallback error: ${e.message}`);
          }
          // Free fallback failed — return helpful error
          sendError(res, 400, 'invalid_request_error', `[anymodel] No credits on OpenRouter and no free variant available for ${parsed.model}. Add credits at https://openrouter.ai/settings/credits or use a free model: npx anymodel proxy --model qwen/qwen3-coder:free`);
          return;
        }

        res.writeHead(upstream.statusCode, upstream.headers);
        res.end(errBody);
        return;
      }

      const ttfb = ((Date.now() - reqStartTime) / 1000).toFixed(1);
      console.log(`${C.green(`[${provider.name.toUpperCase()}]`)} 200 \u2190 response (attempt ${attempt}, ${ttfb}s)`);

      // Cache successful tool use for Ollama auto mode
      // Check parsed.tools (post-strip) not toolCount (pre-strip) to avoid
      // caching true for models whose tools were stripped
      if (provider.name === 'ollama' && parsed.tools && parsed.tools.length > 0) {
        const { cacheToolResult: cacheOk } = await import('./providers/ollama-tools.mjs');
        cacheOk(parsed.model, true);
      }

      // If provider needs response translation (e.g., openai)
      if (provider.transformResponse && !isStreaming) {
        // Non-streaming: read full body, translate, send as Anthropic format
        const respChunks = [];
        upstream.on('data', c => respChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        const respStr = Buffer.concat(respChunks).toString();
        // P1.9: a local server can return a truncated/non-JSON 200 (HTML error
        // page, partial body on reset). Surface a clear api_error instead of
        // letting an unhandled throw bubble to the retry catch → generic 502.
        const parsedResp = safeJsonParse(respStr);
        if (!parsedResp.ok) {
          console.error(`${C.red(`[${provider.name.toUpperCase()}]`)} Upstream returned non-JSON 200 body: ${respStr.slice(0, 120)}`);
          sendError(res, 502, 'api_error', 'Upstream returned a non-JSON response body');
          return;
        }
        const respBody = parsedResp.value;
        const translated = provider.transformResponse(respBody, prefixCacheResult);
        sanitizeToolUseResponse(translated);
        const translatedPayload = JSON.stringify(translated);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(translatedPayload);
        return;
      }

      if (provider.createStreamTranslator && isStreaming) {
        // Streaming: pipe through translator to convert SSE format
        const translator = provider.createStreamTranslator(prefixCacheResult);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
        upstream.on('data', chunk => {
          const translated = translator.transform(chunk.toString());
          if (translated) {
            const ok = res.write(translated);
            if (!ok) upstream.pause();
          }
        });
        res.on('drain', () => upstream.resume());
        upstream.on('end', () => {
          // P0.1: many OpenAI-compatible servers (LM Studio/MLX, llama.cpp, vLLM)
          // close the stream WITHOUT a `data: [DONE]` sentinel. Without flushing
          // the translator the client never receives message_delta + message_stop,
          // so the turn never finalizes and the agentic loop hangs. flush() is
          // idempotent (emitStop is guarded by stopEmitted) so this is safe even
          // when [DONE] already arrived.
          if (typeof translator.flush === 'function') {
            try {
              const tail = translator.flush();
              if (tail && !res.writableEnded) res.write(tail);
            } catch (e) {
              console.error(`${C.red('[STREAM]')} flush error: ${e.message}`);
            }
          }
          if (!res.writableEnded) res.end();
        });
        upstream.on('error', (e) => {
          console.error(`${C.red('[STREAM]')} Upstream error: ${e.message}`);
          if (!res.writableEnded) res.end();
        });
        res.on('close', () => upstream.destroy());
        return;
      }

      // Default: pipe through with _unused stripping (openrouter, ollama)
      // For non-streaming: parse, strip, send
      if (!isStreaming) {
        const respChunks = [];
        upstream.on('data', c => respChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        let respStr = Buffer.concat(respChunks).toString();
        // Sanitize tool_use blocks: strip placeholders, fix structure
        try {
          const respObj = JSON.parse(respStr);
          sanitizeToolUseResponse(respObj);
          respStr = JSON.stringify(respObj);
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(respStr) });
        res.end(respStr);
        return;
      }

      // For streaming: pipe through verbatim. Since 1.12.0 we no longer inject
      // _unused/_placeholder into schemas, so there is nothing to strip here —
      // preserving any real tool arguments named `_unused` (US-004 fix).
      res.writeHead(200, upstream.headers);
      upstream.on('data', chunk => {
        const ok = res.write(chunk);
        if (!ok) upstream.pause();
      });
      res.on('drain', () => upstream.resume());
      upstream.on('end', () => res.end());
      upstream.on('error', (e) => {
        console.error(`${C.red('[STREAM]')} Upstream error: ${e.message}`);
        if (!res.writableEnded) res.end();
      });
      res.on('close', () => upstream.destroy());
      return;

    } catch (e) {
      console.error(`${C.red(`[${provider.name.toUpperCase()}]`)} Connection error on attempt ${attempt}: ${e.message}`);
      if (attempt === MAX_RETRIES) {
        sendError(res, 502, 'api_error', e.message);
        return;
      }
      await sleep(calcDelay(attempt));
    }
  }
}

function proxyToAnthropic(req, res, { stripAuth = false } = {}) {
  // Mock known Claude Code internal endpoints that don't need Anthropic auth.
  // Without this, Claude Code's auth/capability checks hit api.anthropic.com
  // and fail with 401/403, causing misleading "Please run /login" errors.
  if (req.url === '/api/auth/session' || req.url === '/api/auth') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authenticated: true }));
    return;
  }

  const body = [];
  req.on('data', c => body.push(c));
  req.on('error', e => {
    console.error(`${C.red('[PASSTHROUGH]')} Client error: ${e.message}`);
    if (!res.writableEnded) { res.writeHead(502); res.end(); }
  });
  req.on('end', () => {
    // P1.8: for local providers, strip the client's Anthropic credentials before
    // forwarding housekeeping routes — don't egress a real key to api.anthropic.com.
    const fwdHeaders = stripAuth
      ? { ...stripAuthHeaders(req.headers), host: 'api.anthropic.com' }
      : { ...req.headers, host: 'api.anthropic.com' };
    const opts = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: req.url,
      method: req.method,
      headers: fwdHeaders,
    };
    const pr = https.request(opts, upstream => {
      // If Anthropic returns auth error on passthrough, don't forward it raw —
      // it confuses Claude Code into showing "Please run /login"
      if (upstream.statusCode === 401 || upstream.statusCode === 403) {
        console.log(`${C.yellow('[PASSTHROUGH]')} ${req.url} → ${upstream.statusCode} (suppressed — proxy mode)`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', content: [] }));
        return;
      }
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502); res.end(e.message); });
    if (body.length) pr.write(Buffer.concat(body));
    pr.end();
  });
}

export function createProxy(provider, { port = 9090, host = null, model, maxPortRetries = 10, freeOnly = false, token = null, rpm = 60 } = {}) {
  // Rate limiting state
  const rateWindow = {};
  const bindHost = resolveBindHost(host);
  // P1.8: local providers must not egress real Anthropic credentials on passthrough.
  const isLocalProvider = provider.name === 'ollama' || provider.name === 'lmstudio' || provider.name === 'llamacpp';

  function checkRateLimit(ip) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `${ip}:${minute}`;
    rateWindow[key] = (rateWindow[key] || 0) + 1;
    // Clean old entries
    for (const k of Object.keys(rateWindow)) {
      if (!k.endsWith(`:${minute}`)) delete rateWindow[k];
    }
    return rateWindow[key] <= rpm;
  }

  function checkAuth(req) {
    if (!token) return true;
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
    return authHeader === `Bearer ${token}` || authHeader === token;
  }

  // Trusts the `:free` suffix convention (OpenRouter canonical marker) plus
  // the `openrouter/free` auto-router. Authoritative function lives in cli.mjs;
  // duplicated locally to avoid a cross-module import in this hot path.
  function isFreeTierModel(modelId) {
    if (!freeOnly) return true;
    if (!modelId) return !!model; // using default model which was already validated
    if (modelId === 'openrouter/free') return true;
    return modelId.endsWith(':free');
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0].replace(/\/+$/, '') === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: pkg.version,
        provider: provider.name,
        model: model || null,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (isProviderRoute(req.url)) {
      // Auth check
      if (!checkAuth(req)) {
        sendError(res, 401, 'authentication_error', 'Invalid or missing token. Set Authorization: Bearer <token>');
        return;
      }
      // Rate limit check
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        console.log(`${C.red('[RATE]')} Limit exceeded for ${clientIp}`);
        sendError(res, 429, 'rate_limit_error', `Rate limit: ${rpm} requests/minute exceeded`);
        return;
      }

      // Mock /v1/messages/count_tokens for providers that don't support it.
      // Claude Code calls this endpoint frequently. Ollama and OpenAI-compatible
      // providers don't implement it, causing cascading 500 errors and server
      // instability (Ollama GitHub #13949). Return approximate token count.
      if (req.url.includes('/count_tokens') && provider.name !== 'openrouter') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          // Rough estimate: ~4 chars per token for English/code text
          const inputTokens = Math.ceil(raw.length / 4);
          console.log(`${C.cyan(`[${provider.name.toUpperCase()}]`)} count_tokens mock → ${inputTokens} tokens (${(raw.length / 1024).toFixed(1)}KB payload)`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: inputTokens }));
        });
        return;
      }

      handleMessages(req, res, provider, model, isFreeTierModel).catch(e => {
        console.error(`${C.red('[PROXY]')} Unhandled error: ${e.message}`);
        sendError(res, 502, 'api_error', 'Internal proxy error');
      });
    } else {
      console.log(`${C.yellow('[PASSTHROUGH]')} ${req.method} ${req.url}`);
      proxyToAnthropic(req, res, { stripAuth: isLocalProvider });
    }
  });

  function printBanner(actualPort) {
    console.log('');
    console.log(C.magenta(`  anymodel v${pkg.version}`));
    console.log('');
    console.log(`  ${C.cyan('\u2194')}  Proxy on :${actualPort}`);
    console.log(`     /v1/messages \u2192 ${C.bold(provider.name)} ${provider.displayInfo(model)}`);
    console.log(`     everything else \u2192 passthrough`);
    console.log(`     Retries: ${MAX_RETRIES} with exponential backoff`);
    if (model) {
      console.log(`     Model override: ${C.cyan(model)}`);
    }
    if (freeOnly) {
      console.log(`     ${C.green('\u2713')} Free models only (no charges)`);
    }
    if (token) {
      console.log(`     ${C.green('\u2713')} Token auth enabled`);
    }
    if (rpm < 9999) {
      console.log(`     ${C.green('\u2713')} Rate limit: ${rpm} req/min`);
    }
    console.log('');
    console.log(`  ${C.green('Next step — run in another terminal:')}`);
    const portFlag = actualPort !== 9090 ? ` --port ${actualPort}` : '';
    console.log(`  ${C.bold(`npx anymodel${portFlag}`)}`);
    console.log('');
  }

  // Smart port finding: try port, port+1, port+2, ... up to maxPortRetries
  let attempt = 0;
  function tryListen() {
    const tryPort = port + attempt;
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxPortRetries) {
        console.log(`${C.yellow('[PORT]')} :${tryPort} is occupied. Trying :${tryPort + 1}...`);
        console.log(`${C.yellow('[PORT]')} Or choose a port: ${C.bold(`npx anymodel proxy --port ${tryPort + 10}`)}`);
        attempt++;
        tryListen();
      } else {
        throw err;
      }
    });
    server.listen(tryPort, bindHost, () => {
      if (attempt > 0) {
        console.log(`${C.green('[PORT]')} Found free port :${tryPort}`);
      }
      // P1.7: a non-loopback bind with no token is open to the LAN — warn loudly.
      if (!isLoopbackHost(bindHost) && !token) {
        console.log(`${C.red('[SECURITY]')} Bound to ${C.bold(bindHost)} (LAN-exposed) with NO auth token.`);
        console.log(`${C.red('[SECURITY]')} Anyone on the network can POST /v1/messages. Set ${C.bold('--token <secret>')} or bind loopback (unset ANYMODEL_HOST/--host).`);
      }
      // Notify parent process of actual port (IPC)
      if (process.send) process.send({ type: 'port', port: tryPort });
      printBanner(tryPort);

      // Warm up model for Ollama — pre-load into GPU to eliminate cold-start
      if (provider.warmup && model) {
        console.log(`${C.yellow('[WARMUP]')} Pre-loading ${C.cyan(model)} into GPU...`);
        provider.warmup(model).then(ok => {
          if (ok) console.log(`${C.green('[WARMUP]')} ${C.cyan(model)} ready — first request will be fast`);
          else console.log(`${C.yellow('[WARMUP]')} Could not pre-load model (will load on first request)`);
        });
      }
    });
  }
  tryListen();

  return server;
}
