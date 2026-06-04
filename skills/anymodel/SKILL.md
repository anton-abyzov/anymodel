---
name: anymodel
version: 1.0.1
description: >
  AnyModel development skill — the universal AI coding proxy. Use this skill whenever working on AnyModel source code
  (proxy.mjs, cli.mjs, providers/*, site/*, test/*), adding providers or presets, debugging proxy issues, deploying
  to npm, or modifying the anymodel.dev website. Also activate when the user mentions AnyModel architecture, proxy
  sanitization, tool schema fixing, Ollama integration, OpenRouter routing, client branding, or the deployment pipeline.
  Covers the full AnyModel lifecycle: code, test, publish, deploy.
---

# AnyModel Development Skill

You are working on **AnyModel** — a universal AI coding proxy that lets you use any AI model through one interface.
This skill contains everything you need: architecture, conventions, deployment rules, and debugging guidance.

## Product Identity

- **Name**: AnyModel (capital A, capital M — never "anymodel" or "Any Model" in user-facing text)
- **Package**: `anymodel` on npm
- **Website**: https://anymodel.dev
- **GitHub (proxy)**: https://github.com/anton-abyzov/anymodel
- **Client bundle**: `cli.js` in this repo/package is the shipped Claude Code-compatible TUI
- **Author**: Anton Abyzov (@aabyzov on X, @AntonAbyzov on YouTube)
- **License**: MIT

## Architecture

```
AnyModel client (cli.js) --> anymodel proxy (:9090) --> OpenRouter / Ollama / OpenAI-compatible
```

Three components:
1. **Proxy** (`proxy.mjs`) — HTTP server intercepting `/v1/messages`, sanitizes requests, translates formats, routes to providers
2. **CLI** (`cli.mjs`) — entry point for starting proxy, connecting, managing presets
3. **Bundled client** (`cli.js`) — modified Claude Code client with violet diamond character and AnyModel branding

### Providers

| Provider | File | API Format | Key Behavior |
|----------|------|-----------|--------------|
| **OpenRouter** | `providers/openrouter.mjs` | Anthropic passthrough | Preserves `cache_control`, 300+ cloud models |
| **Ollama** | `providers/ollama.mjs` | OpenAI `/v1/chat/completions` | Injects `num_ctx=8192`, capability-aware tool passthrough (v1.12.0+) |
| **OpenAI** | `providers/openai.mjs` | OpenAI format | Full bidirectional Anthropic <-> OpenAI translation |
| **LMStudio** | `providers/lmstudio.mjs` | OpenAI (via local factory) | Delegates to OpenAI translator, `:1234/v1` default |
| **llama.cpp** | `providers/llamacpp.mjs` | OpenAI (via local factory) | Delegates to OpenAI translator, `:8080/v1` default |

### Presets (update version in KNOWLEDGE-BASE.md when changing)

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

When adding a new preset: add to `MODEL_PRESETS` in `cli.mjs`, update help text, update `KNOWLEDGE-BASE.md`, update `site/index.html`, update `README.md`.

## Proxy Sanitization (proxy.mjs)

The `sanitizeBody()` function is the heart of AnyModel. It makes any model work with Claude Code's request format.

### What it does (in order):

1. **Strips Anthropic-only fields**: `betas`, `metadata`, `speed`, raw `output_config`, `context_management`; preserves `output_config.effort` internally for compatible OpenAI forwarding
2. **Preserves `thinking`** — reasoning models (DeepSeek R1) need this for chain-of-thought
3. **Preserves `cache_control`** for OpenRouter (Anthropic models support it), strips for Ollama/OpenAI
4. **Clamps `max_tokens`** to minimum 16 — Claude Code sends `max_tokens: 1` for probes, OpenAI/GPT rejects anything below 16
5. **Fixes tool schemas**:
   - Missing `input_schema` entirely -> adds a minimal object schema
   - Empty `properties: {}` -> keeps it empty and adds `additionalProperties:false`
   - Missing `type` field -> adds `"type": "object"`
   - Recursively fixes nested schemas (`anyOf`, `oneOf`, `allOf`, `items`)
   - Never injects or strips `_unused`; real `_unused` params must round-trip
6. **Strips Anthropic-only tool fields**: `cache_control`, `defer_loading`, `eager_input_streaming`, `strict`
7. **Normalizes `tool_choice`**: converts string format to object format
8. **Local providers (Ollama, LMStudio, llama.cpp): capability-aware tool passthrough** — since v1.12.0 the proxy no longer blanket-strips tools. Behavior is controlled by `OLLAMA_TOOLS` env var (`auto` default, `on`, `off`). In `auto` mode, the proxy tries tools and caches per-model capability; on "does not support tools" errors it retries without tools and remembers that model as no-tool-support. Tools are then compressed and budget-trimmed via `providers/tool-compressor.mjs` to fit local context windows (core tools Bash/Read/Write/Edit always kept). Translation: Anthropic tool definitions -> OpenAI function format -> Ollama `message.tool_calls[]` -> translated back to Anthropic `tool_use` content blocks with `stop_reason: "tool_use"`. Streaming supported.
9. **`tool_choice` always stripped for Ollama** — Ollama doesn't support `tool_choice`; proxy removes it unconditionally.
10. **Auto-retry without tools** — if a provider returns "No endpoints found that support tool use" / "does not support tools", proxy retries with tools removed AND caches model as no-tool-support.

### Why this matters

Without sanitization, MCP tools break on non-Anthropic models. Claude Code sends 80+ tool definitions including MCP servers (Slack, Figma, Gmail, etc.) with every request. The proxy ensures these schemas are valid for the target model, so MCP works seamlessly through any provider — including local Ollama/LMStudio/llama.cpp models that support function calling (Qwen 3/Coder, Llama 3.1+, Mistral, DeepSeek R1, Gemma 4).

**Regression guard:** `test/ollama-tool-passthrough.test.mjs` asserts that in `auto` mode with an uncached model, tools are forwarded (not stripped). See also `test/ollama-tools.test.mjs` for the capability-cache logic.

## Client Identity

- **Character**: Violet diamond-themed (`diamond-head` and `diamond-feet` ASCII art)
- **Color**: Light violet `rgb(147,130,255)`, ANSI fallback `magentaBright`
- **Branding**: "AnyModel" everywhere (not "Claude Code"). Tips say "Ask AnyModel" not "Ask Claude"
- **Version**: Synced with npm package via `prepublishOnly` script
- **`ANYMODEL_MODEL`**: Env var displayed in client UI showing active model name

When modifying the client: never break the violet identity. The diamond character and "AnyModel" branding are what distinguish this from standard Claude Code.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (primary provider) |
| `OPENAI_API_KEY` | API key for OpenAI-compatible endpoints |
| `OPENAI_BASE_URL` | Base URL for custom OpenAI-compatible providers |
| `ANYMODEL_CLIENT` | Explicit path to client binary |
| `ANYMODEL_MODEL` | Model name displayed in client UI |
| `ANYMODEL_TOKEN` | Auth token for remote proxy mode |
| `ANYMODEL_FORWARD_EFFORT` | Force `--effort` forwarding as OpenAI `reasoning_effort` (`1`/`0`; auto by default) |
| `PROXY_PORT` | Default port override (default: 9090) |
| `OLLAMA_NUM_CTX` | Ollama context size (default: 8192) |

## Client Discovery (`findClient()`)

When `npx anymodel` connects, it finds the client in this order:
1. `ANYMODEL_CLIENT` env var (explicit path)
2. `cli.js` next to `cli.mjs` (bundled in npm package)
3. `cli.js` in current directory
4. Global `claude` binary (last resort fallback)

## Deployment Pipeline (MANDATORY)

Every change MUST follow this pipeline. Never skip steps, never publish without tests passing.

```bash
# 1. Run all tests
npm test

# 2. Commit and push
git add <changed-files>
git commit -m "description of change"
git push

# 3. Version bump and publish to npm
npm version patch
npm run sync-version    # syncs version to cli.js
npm publish

# 4. Deploy website (only if site/ changed)
vercel --prod

```

The `prepublishOnly` script in package.json handles version syncing. After `npm version patch`, run `npm run sync-version` to update the version in the bundled client, then `npm publish`.

## Adding a New Provider

1. Create `providers/newprovider.mjs` following the pattern in existing providers
2. Export: `{ name, transformRequest, transformResponse, buildUrl, getHeaders }`
3. Add detection logic in `cli.mjs` (`PROVIDERS` array)
4. Add env var documentation
5. Handle tool schema translation if the provider's format differs
6. Add tests in `test/`
7. Update `KNOWLEDGE-BASE.md`
8. Run the full deployment pipeline

## Adding a New Preset

1. Add to `MODEL_PRESETS` in `cli.mjs`
2. Update the help text in `showUsage()`
3. Update `KNOWLEDGE-BASE.md` preset table
4. Update `site/index.html` preset section
5. Update `README.md`
6. Run the full deployment pipeline

## Debugging Guide

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `max_tokens` error | Claude Code sends `max_tokens: 1` for probes | Proxy clamps to 16 — check `sanitizeBody()` |
| Tool use fails on GPT | Invalid or missing tool schema fields | Proxy normalizes schemas without placeholder hacks — check `sanitizeBody()` |
| Ollama extremely slow | Default 8K context overflowed by big system prompts/tools | Bump `OLLAMA_NUM_CTX=32768`; tool compressor trims schemas to ~30% of ctx |
| "No endpoints found" | Model doesn't support tool use | Proxy auto-retries without tools |
| Streaming breaks | Response format mismatch | Check provider's `transformResponse` — Anthropic SSE vs OpenAI SSE |
| `cache_control` errors | Non-Anthropic model rejecting cache hints | Check `keepCache` flag in `sanitizeBody()` |
| Client shows "Claude" | Branding not applied | Check `ANYMODEL_MODEL` env var and client identity patches |

### Debugging Proxy Traffic

The proxy logs every request with color-coded output:
- `[OPENROUTER]` / `[OLLAMA]` / `[OPENAI]` — provider prefix
- `tools=N` — number of tools in request
- `stream=true` — streaming mode
- Yellow `[OLLAMA] Stripping N tools` — tool removal for local models
- Green `200` — successful response
- Red status codes — errors with body excerpt

## Competitive Context

| Tool | Key Difference from AnyModel |
|------|-----|
| **Claude Code Router (CCR)** | 31K+ stars, Claude Code-specific, requires manual JSON config, no bundled client |
| **OpenRouter native** | Only Anthropic models work reliably, no format translation |
| **OpenCode** | Full rewrite (107K stars), own ecosystem, not a proxy |
| **Cline** | VS Code extension, IDE-specific, not standalone CLI |
| **LiteLLM** | Enterprise Python gateway, heavy config |

### Anthropic Third-Party Cutoff (April 4, 2026)

Claude subscriptions no longer cover third-party tools. AnyModel proxy mode is NOT affected (routes through OpenRouter, never touches Anthropic OAuth). This is a key selling point — AnyModel users don't need a Claude subscription.

## URLs and Links

| Resource | URL |
|----------|-----|
| AnyModel website | https://anymodel.dev |
| AnyModel npm | https://npmjs.com/package/anymodel |
| AnyModel GitHub | https://github.com/anton-abyzov/anymodel |
| Client bundle | `cli.js` in this repo/package |
| SpecWeave | https://spec-weave.com |
| Verified Skills | https://verified-skill.com |
| OpenRouter keys | https://openrouter.ai/keys |
| YouTube demo | https://youtu.be/k0RI_M6lIsg |
| YouTube channel | https://youtube.com/@AntonAbyzov |
| Twitter/X | https://x.com/aabyzov |
| Discord | https://discord.gg/UYg4BGJ65V |
| Telegram | https://t.me/antonaipower |

## File Structure

```
anymodel/
  cli.mjs              # CLI entry point
  cli.js               # Bundled client (12MB modified Claude Code)
  proxy.mjs            # HTTP proxy server + sanitization
  package.json         # npm config
  providers/
    openrouter.mjs     # OpenRouter provider (passthrough)
    ollama.mjs         # Ollama provider (OpenAI translation + num_ctx)
    openai.mjs         # OpenAI provider (bidirectional translation)
  site/
    index.html         # anymodel.dev homepage
    styles.css / script.js / sitemap.xml / robots.txt
  test/                # 93+ tests
  KNOWLEDGE-BASE.md    # Single source of truth (keep in sync with this skill)
```

## Testing

Run all tests before any commit:

```bash
npm test
```

Tests cover: sanitization, tool schema fixing, provider translation, preset resolution, max_tokens clamping, streaming, error handling. When adding features, add corresponding tests. The test count should only go up.

## Changelog

- 1.0.1: Added version tracking support
