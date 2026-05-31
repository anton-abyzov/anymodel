# AnyModel Knowledge Base

> This document is the single source of truth for AnyModel. Load it at the start of any LLM session working on this project.

---

## Product Identity

- **Name**: AnyModel (capital A, capital M)
- **Package**: `anymodel` on npm
- **Website**: https://anymodel.dev
- **GitHub (proxy)**: https://github.com/anton-abyzov/anymodel
- **GitHub (client)**: https://github.com/antonoly/claude-code-anymodel (expendable account — DMCA risk)
- **Author**: Anton Abyzov (@aabyzov on X, @AntonAbyzov on YouTube)
- **YouTube channel**: Anton Abyzov: AI Power — https://youtube.com/@AntonAbyzov
- **License**: MIT

## What AnyModel Is

AnyModel is a **universal AI coding proxy** that lets you use any AI model through one interface. It includes:

1. **Proxy** (`proxy.mjs`) — HTTP server that intercepts `/v1/messages`, sanitizes requests, translates formats, and routes to providers
2. **CLI** (`cli.mjs`) — entry point for starting proxy, connecting, managing presets
3. **Bundled client** (`cli.js`) — custom Claude Code client with violet diamond character, AnyModel branding, ANYMODEL_MODEL display

## Architecture

```
AnyModel client (cli.js) → anymodel proxy (:9090) → OpenRouter / Ollama / OpenAI-compatible
```

### Three providers:
- **OpenRouter** (`providers/openrouter.mjs`) — 300+ cloud models, passes through Anthropic format, preserves cache_control
- **Ollama** (`providers/ollama.mjs`) — local models, translates to OpenAI format via /v1/chat/completions, injects num_ctx=8192, **capability-aware tool passthrough since v1.12.0** (see below)
- **OpenAI** (`providers/openai.mjs`) — any OpenAI-compatible API (OpenAI, Azure, Together, Groq, vLLM), full bidirectional Anthropic ↔ OpenAI translation
- **LMStudio / llama.cpp** (`providers/lmstudio.mjs`, `providers/llamacpp.mjs`) — thin aliases over OpenAI translator via `providers/openai-local.mjs` factory; `:1234/v1` and `:8080/v1` defaults respectively

## CLI Commands

```
npx anymodel                        # connect to running proxy (auto-detect :9090)
npx anymodel --port 9091            # connect to specific port
npx anymodel proxy deepseek         # start proxy with preset
npx anymodel proxy --model <id>     # start proxy with any model
npx anymodel proxy ollama --model X # proxy with local Ollama
OPENAI_BASE_URL=http://localhost:8080/v1 npx anymodel proxy openai --model X  # proxy with llama-server
npx anymodel claude                 # run with native Claude (no proxy)
```

## Presets (current as of v1.6.40)

| Preset | Model ID | Cost |
|--------|----------|------|
| gpt | openai/gpt-5.4 | paid |
| codex | openai/gpt-5.3-codex | paid, coding |
| gemini | google/gemini-3.1-flash-lite-preview | paid |
| deepseek | deepseek/deepseek-r1-0528 | paid |
| mistral | mistralai/devstral-2512 | paid, coding |
| gemma | google/gemma-4-31b-it | paid, coding |
| qwen | qwen/qwen3-coder:free | free |
| nemotron | nvidia/nemotron-3-super-120b-a12b:free | free |
| llama | meta-llama/llama-3.3-70b-instruct:free | free |

## Proxy Sanitization (proxy.mjs sanitizeBody)

What the proxy does to every request:

1. **Strips**: `betas`, `metadata`, `speed`, `output_config`, `context_management`
2. **Preserves**: `thinking` (for reasoning models like DeepSeek R1)
3. **cache_control**: Preserved for OpenRouter, stripped for Ollama/OpenAI
4. **max_tokens**: Clamped to minimum 16 (GPT requires ≥16, Claude Code sends 1 for probes)
5. **max_output_tokens**: Also clamped to minimum 16
6. **Tool schemas**: Fixes empty `properties: {}`, missing `properties`, missing `input_schema`, recursive nested schemas. Adds `_unused` placeholder, strips it from responses.
7. **tool_choice**: Normalizes string to object format
8. **Local-provider tool handling** (Ollama, LMStudio, llama.cpp): since v1.12.0, **capability-aware passthrough instead of blanket strip**. Controlled by `OLLAMA_TOOLS` env var — `auto` (default, try + cache per-model), `on` (always pass), `off` (legacy, always strip). Tools are then compressed and budget-trimmed via `providers/tool-compressor.mjs` so schemas fit local context windows. Core tools (Bash, Read, Write, Edit) are always retained. `tool_choice` is always removed for Ollama.
9. **Auto-retry without tools**: When provider returns "No endpoints found that support tool use" / "does not support tools", proxy retries with tools removed AND caches the model as no-tool-support (skips retry on subsequent calls)

## Client (cli.js) Identity

- **Character**: Violet diamond-themed (`◆▟▀█▀▙◆` head, `◆ ◆` diamond feet)
- **Color**: Light violet `rgb(147,130,255)`, ANSI fallback `magentaBright`
- **Branding**: "AnyModel" (not "Claude Code") in UI, settings, tips
- **Version**: Synced with npm package via `prepublishOnly` script
- **ANYMODEL_MODEL**: Env var read by client to display active model name
- **Tips**: Say "Ask AnyModel" not "Ask Claude"

## findClient() Search Order

When `npx anymodel` connects, it finds the client in this order:
1. `ANYMODEL_CLIENT` env var (explicit path)
2. `cli.js` next to `cli.mjs` (bundled in npm package)
3. `cli.js` in current directory
4. Sibling repos (`../claude-code/cli.js`, `../claude-code-anymodel/cli.js`)
5. Home directory (`~/claude-code-anymodel/cli.js`)
6. Global `claude` binary (last resort fallback)

## connectToProxy() Flow

1. Parse `--port` (default 9090)
2. Check proxy health at `http://localhost:{port}/health`
3. Query model name from health response
4. Find client via `findClient()`
5. Launch client with `ANTHROPIC_BASE_URL=http://localhost:{port}` and `ANYMODEL_MODEL={model}`

## Ollama-Specific Behavior

- Uses `/v1/chat/completions` (NOT `/v1/messages`) — enables `options.num_ctx`
- Injects `num_ctx: 8192` (default) — prevents 30-60s KV cache allocation on large context models
- Configurable via `OLLAMA_NUM_CTX` env var
- Auto-detects installed models via `/api/tags` when no `--model` specified
- **Tool passthrough (v1.12.0+)**: tools forwarded to tool-capable models (Qwen 3 / Qwen-Coder, Llama 3.1+, Mistral, DeepSeek R1, Gemma 4). Response `message.tool_calls[]` is translated back to Anthropic `tool_use` content blocks with `stop_reason: "tool_use"`. Streaming tool deltas supported.
- Per-model no-tool-support cache — if a model rejects tool schemas once, the proxy remembers and strips tools on subsequent calls for that model until the process restarts.

## Local-Model Reliability & Security (increment 0008)

Hardening that turns the happy-path bridge into one that survives realistic local-model
failure modes. All gated/additive — cloud (OpenRouter) paths are untouched.

**Streaming / tool-call fidelity** (`providers/openai.mjs`):
- **Flush on upstream `end`** (P0.1) — LM Studio/MLX, llama.cpp, vLLM often close the
  socket without `data: [DONE]`. The translator is flushed on `end` so the client always
  gets a terminal `message_stop` (idempotent — exactly one stop even when `[DONE]` arrives).
- **Text-channel tool-call recovery** (P0.2 non-streaming + 0009 streaming) — Hermes
  `<tool_call>`, Qwen `<function=>` XML, and fenced ```json tool calls parked in the text
  channel are recovered into real `tool_use` blocks. Gated by `ANYMODEL_PARSE_TEXT_TOOLCALLS`
  (`auto` = local-only, `on`, `off`). For STREAMING (Claude Code's default), local providers
  buffer the text channel until end-of-message, then recover — so a parked tool call no longer
  dead-ends the agentic loop. Trade-off: local streamed *text* appears at message end (structured
  tool calls and thinking still stream incrementally; cloud paths stream text incrementally as before).
- **Local tool-capability cache** (0009 P1.10) — the per-model no-tool-support cache + the
  `tool_choice` strip now apply to LM Studio / llama.cpp too (were Ollama-only), so weak local
  models learn once instead of re-probing every request.
- **Per-`tc.index` streamed tool-call routing** (P1.1) — parallel/batched streamed tool
  calls no longer cross-assign argument fragments (was hard-coded `blockIndex-1`).
- **Image / document translation** (P1.2) — `{type:'image'}` → OpenAI `image_url` parts
  (base64 data URI / url); images in `tool_result` are hoisted to a following user message;
  documents / unresolvable images become a visible marker, never a silent drop. Text-only
  turns stay plain strings (byte-stable).
- **`tool_result.is_error`** (P1.3) → `[tool_error]` marker so failed tools look failed.
- **Sampling parity** (P1.4) — `top_p`, `stop_sequences`→`stop`, `max_tokens` fallback to
  `max_output_tokens`; mirrored into Ollama `options`.
- **Unified `finish_reason` map** (P1.5) — one `mapFinishReason()`; `content_filter`→`refusal`.
- **Streaming `input_tokens`** (P2.1) and **TTFT `ping` heartbeat** (P2.2, every 15s until
  first token) for big-prompt 80B cold starts.

**Robustness / security** (`proxy.mjs`, `cli.mjs`):
- **Upstream idle timeout** (P0.3) — `ANYMODEL_UPSTREAM_TIMEOUT_MS` (default 300000) so a
  stalled model becomes a bounded retry→502 instead of an infinite hang.
- **Canonical error envelope** (P1.6) — one `sendError()` emits `{type:"error",error:{type,message}}`
  with canonical Anthropic `error.type` strings so Claude Code's retry logic recognizes them.
- **Loopback bind by default** (P1.7) — binds `127.0.0.1`; expose with `--host 0.0.0.0` /
  `ANYMODEL_HOST` (warns loudly when LAN-exposed without `--token`).
- **No key leak on local passthrough** (P1.8) — local providers strip `x-api-key` /
  `authorization` before forwarding housekeeping routes to api.anthropic.com.
- **Body cap + parse guards** (P1.9) — `ANYMODEL_MAX_BODY_BYTES` (default 64MB) → 413;
  unguarded upstream `JSON.parse` now returns an `api_error` 502 instead of a generic crash.
- **`crypto.randomUUID()` tool ids** (P2.7) — no same-millisecond id collisions for parallel calls.

**New env vars / flags:** `ANYMODEL_PARSE_TEXT_TOOLCALLS`, `ANYMODEL_UPSTREAM_TIMEOUT_MS`,
`ANYMODEL_HOST` / `--host`, `ANYMODEL_MAX_BODY_BYTES`.

## Key Technical Decisions

### Why not just use OpenRouter's native Claude Code integration?
OpenRouter supports `ANTHROPIC_BASE_URL=https://openrouter.ai/api` — but it only works reliably with Anthropic models. AnyModel adds:
- Format translation for non-Anthropic models (GPT, DeepSeek, Gemini)
- Tool schema sanitization (empty properties fix)
- Ollama / LMStudio / llama.cpp support (fully offline)
- Capability-aware tool passthrough for local models (v1.12.0+) — slash commands like `/openspec`, file tools (Read/Write/Edit), and WebFetch work end-to-end with tool-capable local models
- max_tokens clamping

### Why bundle cli.js (12MB) in the npm package?
So `npx anymodel` works from anywhere without cloning repos. The client is a modified Claude Code v2.1.88 with AnyModel branding.

### Why capability-aware tool handling for local providers (was: strip all)?
Pre-v1.12.0 the proxy blanket-stripped all tools for Ollama because Claude Code sends 80+ MCP tool definitions (~50K tokens) and most local models at the time couldn't use them. Modern local models (Qwen 3 / Qwen-Coder, Llama 3.1+, Mistral, DeepSeek R1, Gemma 4) **do** support function calling natively, so v1.12.0 replaced the blanket strip with:

1. `OLLAMA_TOOLS=auto` (default) — try with tools, cache success/failure per model
2. Schema compression + budget trimming (`providers/tool-compressor.mjs`) — cuts tool payload 50–70% so it fits local context windows
3. Core-tool preservation — Bash, Read, Write, Edit are always kept; lower-priority tools are trimmed first

Net effect: slash commands like `/openspec propose`, file tools, and WebFetch now work end-to-end on local models that support function calling. Weaker / older models still fall back silently to the no-tools retry path.

### Why preserve thinking field?
DeepSeek R1 and other reasoning models need the `thinking` configuration to enable visible chain-of-thought. Stripping it (as we originally did) disables the reasoning UI.

### Why clamp max_tokens to 16?
Claude Code sends `max_tokens: 1` for initial probe requests. OpenAI/GPT rejects anything below 16. The proxy clamps silently.

## Competitive Landscape

| Tool | Architecture | Key Difference from AnyModel |
|------|-------------|------|
| **OpenRouter native** | Direct cloud endpoint | Only Anthropic models, no format translation |
| **OpenClaw** | Full platform | Different product category (life OS, not coding proxy) |
| **OpenCode** | Forked client (107K stars) | Full rewrite, own ecosystem, not a proxy |
| **Cline** | VS Code extension | IDE-specific, not standalone CLI |
| **LiteLLM** | Enterprise Python gateway | Team/enterprise focus, Python, heavy config |

## Anthropic Third-Party Cutoff (April 4, 2026)

- Claude subscriptions no longer cover third-party tools
- Affected: OpenClaw, OpenCode, Cline, NanoClaw, Roo Code
- NOT affected: Tools using API keys (Aider, Cursor, Continue.dev)
- AnyModel proxy mode: NOT affected (routes through OpenRouter, never touches Anthropic OAuth)
- AnyModel claude mode: Potentially affected (bundled cli.js is a third-party harness)
- One-time credit offered: equal to plan cost, claim via email link

## URLs and Links

- **AnyModel website**: https://anymodel.dev
- **AnyModel npm**: https://npmjs.com/package/anymodel
- **AnyModel GitHub**: https://github.com/anton-abyzov/anymodel
- **Client GitHub**: https://github.com/antonoly/claude-code-anymodel
- **SpecWeave**: https://spec-weave.com
- **Verified Skills**: https://verified-skill.com
- **OpenRouter**: https://openrouter.ai/keys
- **YouTube demo**: https://youtu.be/k0RI_M6lIsg
- **YouTube channel**: https://youtube.com/@AntonAbyzov
- **Twitter**: https://x.com/aabyzov
- **LinkedIn**: https://linkedin.com/in/antonabyzov
- **Discord**: https://discord.gg/UYg4BGJ65V
- **Telegram**: https://t.me/antonaipower
- **Wispr Flow promo**: https://wisprflow.ai/r?ANTON691

## Deployment Checklist

Every change MUST:
1. `node --test test/*.test.mjs` — all 93 tests pass
2. `git add && git commit && git push` — to GitHub
3. `npm version patch && npm run sync-version && npm publish` — to npm (syncs cli.js version)
4. `vercel --prod` — deploys anymodel.dev (if site/ changed)
5. Sync cli.js to claude-code-anymodel repo if changed

## File Structure

```
anymodel/
├── cli.mjs              # CLI entry point (proxy, connect, presets)
├── cli.js               # Bundled client (12MB, modified Claude Code)
├── proxy.mjs            # HTTP proxy server + sanitization
├── package.json          # npm config, prepublishOnly syncs version
├── providers/
│   ├── openrouter.mjs   # OpenRouter provider (passthrough)
│   ├── ollama.mjs       # Ollama provider (OpenAI translation + num_ctx)
│   └── openai.mjs       # OpenAI provider (full bidirectional translation)
├── site/
│   ├── index.html       # anymodel.dev homepage
│   ├── styles.css       # Site styles
│   ├── script.js        # Site JS
│   ├── sitemap.xml      # SEO sitemap
│   ├── robots.txt       # SEO robots
│   └── assets/          # OG image, provider icons, favicon
├── test/                # 93 tests
├── vercel.json          # Vercel deployment config
├── README.md            # npm README (shown on npmjs.com)
├── LAUNCH-PLAN.md       # Social media posting plan
├── VIDEO2-SCRIPT.md     # Second YouTube video script
├── YOUTUBE-SCRIPT.md    # First YouTube video script
└── KNOWLEDGE-BASE.md    # This file
```
