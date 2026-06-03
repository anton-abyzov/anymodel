---
name: anymodel
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
- **GitHub (client)**: https://github.com/antonoly/claude-code-anymodel
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
| **OpenAI** | `providers/openai.mjs` | OpenAI format | Full bidirectional Anthropic ↔ OpenAI translation |
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

1. **Strips Anthropic-only fields**: `betas`, `metadata`, `speed`, `output_config`, `context_management`
2. **Preserves `thinking`** — reasoning models (DeepSeek R1) need this for chain-of-thought
3. **Preserves `cache_control`** for OpenRouter (Anthropic models support it), strips for Ollama/OpenAI
4. **Clamps `max_tokens`** to minimum 16 — Claude Code sends `max_tokens: 1` for probes, OpenAI/GPT rejects anything below 16
5. **Fixes tool schemas**:
   - Missing `input_schema` entirely -> adds minimal valid schema with `_unused` placeholder
   - Empty `properties: {}` -> adds `_unused` placeholder (OpenAI rejects empty properties)
   - Missing `type` field -> adds `"type": "object"`
   - Recursively fixes nested schemas (`anyOf`, `oneOf`, `allOf`, `items`)
   - Strips `_unused` from tool_use responses so the client never sees it
6. **Strips Anthropic-only tool fields**: `cache_control`, `defer_loading`, `eager_input_streaming`, `strict`
7. **Normalizes `tool_choice`**: converts string format to object format
8. **Local providers (Ollama, LMStudio, llama.cpp): capability-aware tool passthrough** — since v1.12.0 the proxy no longer blanket-strips tools. Behavior is controlled by `OLLAMA_TOOLS` env var (`auto` default, `on`, `off`). In `auto` mode, the proxy tries tools and caches per-model capability; on "does not support tools" errors it retries without tools and remembers that model as no-tool-support. Tools are then compressed and budget-trimmed via `providers/tool-compressor.mjs` to fit local context windows (core tools Bash/Read/Write/Edit always kept). Translation: Anthropic tool definitions → OpenAI function format → Ollama `message.tool_calls[]` → translated back to Anthropic `tool_use` content blocks with `stop_reason: "tool_use"`. Streaming supported.
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

### Branding (reproducible)

`cli.js` is a 13MB minified bundle, so branding is NOT hand-edited anymore. It is applied declaratively and verifiably:

- **`scripts/brand-patch.mjs`** — idempotent applier. Asserts each patch's `from` appears exactly `expect` times before touching anything (a mismatch means upstream changed → fail loudly), applies replacements, then re-parses with `node --check` so a broken bundle can never ship. Some patches are `adaptive`: they swap a static literal for a JS expression that reads `process.env.ANYMODEL_MODEL` at render time, so the UI reflects the loaded backend model.
- **`scripts/brand-patches.json`** — the declarative manifest (data/code separation).
- **`scripts/gen-brand-manifest.py`** — regenerates the manifest. Run it against a PRISTINE bundle (it computes each `expect` from live anchor counts and fails if any anchor is missing).
- **`--check` gate** — `node scripts/brand-patch.mjs --check` is verify-only (CI anti-regression gate): non-zero exit on drift. Includes a version-tolerant vendor denylist sweep that catches residual user-visible vendor strings the exact `from` anchors miss (e.g. version-bumped model promos).

User-facing UI text reads "AnyModel" (capital), while the package/command name stays lowercase. **Re-apply on every upstream `cli.js` bump** — a bundle refresh wipes all branding.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (primary provider) |
| `OPENAI_API_KEY` | API key for OpenAI-compatible endpoints |
| `OPENAI_BASE_URL` | Base URL for custom OpenAI-compatible providers |
| `ANYMODEL_CLIENT` | Explicit path to client binary |
| `ANYMODEL_MODEL` | Model name displayed in client UI |
| `ANYMODEL_TOKEN` | Auth token for remote proxy mode |
| `ANYMODEL_SKILL_ROOTS` | Colon-separated extra/override skill discovery roots (absolute paths; relative resolved against cwd) for the universal skill loader |
| `PROXY_PORT` | Default port override (default: 9090) |
| `OLLAMA_NUM_CTX` | Ollama context size (default: 8192) |
| `LOCAL_NUM_CTX` | LMStudio / llama.cpp context size (default: 32768) |
| `OLLAMA_TOOLS` | Tool-passthrough mode: `auto` (default, try + cache), `on` (always pass), `off` (always strip — legacy behavior) |
| `OLLAMA_MAX_TOOLS` / `LOCAL_MAX_TOOLS` | Hard cap on tool count for local providers (0 = no cap, rely on budget) |
| `OLLAMA_MAX_TOOL_DESC` / `LOCAL_MAX_TOOL_DESC` | Max chars per tool description (default: 100) |
| `OLLAMA_TOOL_BUDGET_PCT` / `LOCAL_TOOL_BUDGET_PCT` | Fraction of `num_ctx` reserved for tool schemas (default: 0.30) |

## Client Discovery (`findClient()`)

When `npx anymodel` connects, it finds the client in this order:
1. `ANYMODEL_CLIENT` env var (explicit path)
2. `cli.js` next to `cli.mjs` (bundled in npm package)
3. `cli.js` in current directory
4. Sibling repos (`../claude-code/cli.js`, `../claude-code-anymodel/cli.js`)
5. Home directory (`~/claude-code-anymodel/cli.js`)
6. Global `claude` binary (last resort fallback)

## Universal Skill Loader (`providers/skill-bridge.mjs`)

`SKILL.md` is ONE shared open standard — Claude Code, OpenAI/Codex, Gemini/Antigravity, Cursor and Copilot all read the same `<name>/SKILL.md` format (YAML frontmatter + Markdown body). Only the discovery path differs. The bundled client only scans `.claude/skills`, so instead of patching its minified loader, AnyModel bridges at launch time: it discovers foreign-ecosystem skills, symlinks each into a per-session temp `.claude/skills` shadow, and passes that shadow via `--add-dir`. Zero format translation — the client's native SKILL.md reader handles everything.

- **Roots scanned** (under both project cwd AND `$HOME`, in precedence order): `.agents/skills`, `.codex/skills`, `.gemini/skills`, `.agent/skills` (Antigravity, singular). The project's own `.claude/skills` is read for collision precedence.
- **`ANYMODEL_SKILL_ROOTS`** (colon-separated) appends/overrides extra discovery roots; relative entries resolve against cwd (a bare relative root would otherwise produce a broken symlink).
- **Collision rules**: a project-local `.claude/skills/<name>` wins (foreign same-name is shadowed); among foreign roots the first occurrence of a name wins. Names are compared case-insensitively (macOS/Windows FS). Shadowed duplicates and unlinkable skills are logged, not silently dropped.
- **Safety**: symlinked skill entries that resolve outside their scanned root are skipped (no exposing `~/.ssh` via an untrusted repo's `.codex/skills/x` link).
- A project-scoped local skill index for context economy lives in `providers/skill-catalog.mjs` (increment 0016).

## Deployment Pipeline (MANDATORY)

Every change MUST follow this pipeline. Never skip steps, never publish without tests passing.

```bash
# 1. Run all tests
node --test test/*.test.mjs

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

# 5. Sync client repo (only if cli.js changed)
# Copy cli.js to claude-code-anymodel repo
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
| Tool use fails on GPT | Empty `properties: {}` in tool schema | Proxy adds `_unused` placeholder — check tool sanitization |
| Ollama extremely slow | Default 8K context overflowed by big system prompts | Bump `OLLAMA_NUM_CTX=32768`; tool compressor trims schemas to ~30% of ctx |
| Local model prints JSON instead of calling tools | Model doesn't support function calling, OR `OLLAMA_TOOLS=off`, OR model cached as no-tool-support | Use a tool-capable model (Qwen 3 / Qwen-Coder, Llama 3.1+, Mistral, DeepSeek R1, Gemma 4); ensure `OLLAMA_TOOLS=auto`; restart proxy to clear per-model cache |
| Slash commands (`/openspec`, etc.) return JSON text | Same as above — the command emits prompts expecting `tool_use` blocks; only tool-capable models will emit them | See row above |
| "No endpoints found" / "does not support tools" | Model doesn't support tool use | Proxy auto-retries without tools and caches model as no-tool-support |
| Streaming breaks | Response format mismatch | Check provider's `transformResponse` — Anthropic SSE vs OpenAI SSE |
| `cache_control` errors | Non-Anthropic model rejecting cache hints | Check `keepCache` flag in `sanitizeBody()` |
| Client shows "Claude" | Branding not applied | Check `ANYMODEL_MODEL` env var and client identity patches |

### Debugging Proxy Traffic

The proxy logs every request with color-coded output:
- `[OPENROUTER]` / `[OLLAMA]` / `[OPENAI]` — provider prefix
- `tools=N` — number of tools in request
- `stream=true` — streaming mode
- Yellow `[OLLAMA] Passing N tools to <model> (mode=auto)` — tools forwarded (capability-aware passthrough, v1.12.0+)
- Yellow `[OLLAMA] Stripping N tools (mode=<x>, model=<m> cached as no-tool-support)` — tool removal (either `OLLAMA_TOOLS=off` or model is in no-tool-support cache)
- Yellow `[OLLAMA] Tool optimization: N tools (X tok) → compressed to Y tok` — schema compression + budget trimming
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
| Client GitHub | https://github.com/antonoly/claude-code-anymodel |
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
    ollama.mjs         # Ollama provider (OpenAI translation + num_ctx + tool_use roundtrip)
    ollama-tools.mjs   # Tool capability mode + per-model no-tool-support cache
    tool-compressor.mjs # Schema compression + budget trimming for local models
    openai.mjs         # OpenAI provider (bidirectional translation)
    openai-local.mjs   # Factory for LMStudio/llama.cpp (thin wrappers over OpenAI)
    lmstudio.mjs       # LMStudio alias (:1234/v1)
    llamacpp.mjs       # llama.cpp alias (:8080/v1)
    prefix-cache.mjs   # Prefix-aware caching (increment 0004)
    skill-bridge.mjs   # Universal skill loader — foreign skills → temp .claude/skills shadow + --add-dir
    skill-catalog.mjs  # Project-scoped local skill index for context economy (increment 0016)
  scripts/
    brand-patch.mjs    # Idempotent, verifiable cli.js brand applier (--check CI gate)
    brand-patches.json # Declarative brand-patch manifest
    gen-brand-manifest.py # Regenerates the manifest from a pristine bundle
  site/
    index.html         # anymodel.dev homepage
    styles.css / script.js / sitemap.xml / robots.txt
  test/                # 93+ tests
  KNOWLEDGE-BASE.md    # Single source of truth (keep in sync with this skill)
```

## Testing

Run all tests before any commit:

```bash
node --test test/*.test.mjs
```

Tests cover: sanitization, tool schema fixing, provider translation, preset resolution, max_tokens clamping, streaming, error handling. When adding features, add corresponding tests. The test count should only go up.
