# AnyModel

**Universal AI coding tool — use GPT-5.4, Gemini 3.1, DeepSeek R1, Codex, Llama, and 300+ models through one interface.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/anton-abyzov/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

AnyModel is an AI coding assistant that works with any model. It includes a proxy that routes requests to OpenRouter (300+ cloud models), local backends (Ollama, LMStudio, llama.cpp), or any OpenAI-compatible API — with smart retries, format translation, and zero dependencies.

**[anymodel.dev](https://anymodel.dev)** — full docs, presets, and FAQ.

### Watch the Demo

[![Watch the demo](https://img.youtube.com/vi/k0RI_M6lIsg/maxresdefault.jpg)](https://youtu.be/k0RI_M6lIsg)

---

## Quick Start

```bash
# Terminal 1 — start AnyModel proxy with a model:
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy deepseek

# Terminal 2 — launch AnyModel:
npx anymodel
```

The model is set on the proxy via preset or `--model`. Connecting is always just `npx anymodel`.

Get your free OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys) — no credit card for free models.

---

## Presets

```bash
# Paid models:
npx anymodel proxy gpt        # → openai/gpt-5.4                       (paid)
npx anymodel proxy codex      # → openai/gpt-5.3-codex                 (paid, coding)
npx anymodel proxy gemini     # → google/gemini-3.1-flash-lite-preview  (paid)
npx anymodel proxy deepseek   # → deepseek/deepseek-r1-0528            (paid)
npx anymodel proxy mistral    # → mistralai/devstral-2512               (paid, coding)
npx anymodel proxy gemma      # → google/gemma-4-31b-it                (paid, coding)

# Free models:
npx anymodel proxy qwen       # → qwen/qwen3-coder:free                (free)
npx anymodel proxy nemotron   # → nvidia/nemotron-3-super-120b-a12b:free (free)
npx anymodel proxy llama      # → meta-llama/llama-3.3-70b-instruct:free (free)
```

Or any of 300+ models: `npx anymodel proxy --model mistralai/codestral-2508`

## How It Works

```
AnyModel client → anymodel proxy (:9090) → OpenRouter / Ollama / LMStudio / llama.cpp
```

The proxy intercepts requests, strips provider-specific fields, handles retries with exponential backoff, and streams responses back.

### Multiple Models at Once

Run separate instances on different ports:

```bash
npx anymodel proxy --port 9090 --model openai/gpt-5.4
npx anymodel proxy --port 9091 --model deepseek/deepseek-r1-0528
npx anymodel proxy --port 9092 --model google/gemini-3.1-flash-lite-preview
```

### Local Backends

No internet, no API key — run everything on your machine. AnyModel treats Ollama, LMStudio, and llama.cpp as first-class backends, each with its own preset:

```bash
npx anymodel proxy ollama --model gemma3n            # Ollama    (:11434)
npx anymodel proxy lmstudio --model qwen3-coder      # LMStudio  (:1234/v1)
npx anymodel proxy llamacpp --model my-model         # llama.cpp (:8080/v1)
```

| Backend | Port | API | Best for |
|---------|------|-----|----------|
| **Ollama** | `11434` | Native (`think:false` suppresses reasoning-token waste on qwen3/deepseek) | One-line model pulls, managed model library |
| **LMStudio** | `1234/v1` | OpenAI-compatible | GUI model browser, easy swapping between loaded models |
| **llama.cpp** | `8080/v1` | OpenAI-compatible | Rawest/smallest footprint, max control (context, GPU layers, batch, quantization) |

**GGUF portability**: The same GGUF model file runs across all three — only the wrapper UX differs. Download once, use anywhere. llama.cpp is the inference engine under Ollama and LMStudio.

Override endpoints via env:

```bash
LMSTUDIO_BASE_URL=http://192.168.1.50:1234/v1 npx anymodel proxy lmstudio
LLAMACPP_BASE_URL=http://localhost:9000/v1    npx anymodel proxy llamacpp
```

Auto-detection priority when no preset is given: OpenRouter key → OpenAI key → Ollama → LMStudio → llama.cpp.

### Local-provider smart defaults (1.11.0+)

When you connect to a local provider, AnyModel automatically suppresses your globally-configured MCP servers — which are usually the single biggest cause of slow first-response times (50–60 K tokens of tool schemas that local models can't handle).

- `npx anymodel` on a local provider → loads project `./.claude/.mcp.json` if present, else no MCP
- Keeps project skills, agents, CLAUDE.md
- Remote providers (openrouter, openai) unchanged
- Opt out: `--full-mcp` flag or `ANYMODEL_FULL_MCP=1`

See [LOCAL_SETUP.md](./LOCAL_SETUP.md) for the full guide, including 32 K context setup and full isolation.

### OpenAI-Compatible APIs

Works with OpenAI, Azure, Together, Groq, vLLM, and any OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=sk-your-key npx anymodel proxy openai --model gpt-4o

# Terminal 2:
npx anymodel
```

Bidirectional translation: Anthropic Messages API ↔ OpenAI Chat Completions.

## CLI Reference

```
anymodel                              # launch AnyModel (connect to proxy)
anymodel proxy <preset>               # start proxy with preset
anymodel proxy --model <id>           # start proxy with any model
anymodel proxy ollama --model <name>  # proxy with local Ollama    (:11434)
anymodel proxy lmstudio --model <id>  # proxy with LMStudio        (:1234/v1)
anymodel proxy llamacpp --model <id>  # proxy with llama.cpp       (:8080/v1)
anymodel claude                       # run with native Claude (no proxy)

Options:
  --model, -m     Model ID
  --port, -p      Port (default: 9090)
  --free-only     Block paid models
  --token, -t     Require auth token for requests
  --rpm           Rate limit requests/min (default: 60)
  --help, -h      Help
```

## Ollama Performance Optimizations

When proxying to Ollama, AnyModel automatically applies several optimizations to make local models work well with coding tools:

- **System prompt condensing** — AI tool prompts are 50-100KB; AnyModel condenses them to fit Ollama's context window (`OLLAMA_MAX_SYSTEM_CHARS`)
- **Tool description trimming** — truncates verbose tool descriptions to save context (`OLLAMA_MAX_TOOL_DESC`, default 100 chars)
- **Tool count limiting** — limits tools sent to the model, always keeping core tools (Bash/Read/Write/Edit/Grep/Glob) (`OLLAMA_MAX_TOOLS`)
- **Prefix-aware caching** — stabilizes system prompt + tool ordering for Ollama KV cache reuse across requests, with date normalization and description-independent hashing
- **HTTP keep-alive** — reuses TCP connections to Ollama
- **count_tokens mock** — responds to `/v1/messages/count_tokens` locally, preventing cascading 500 errors

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | Your OpenRouter key ([get one free](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | — | Default model override |
| `OPENAI_API_KEY` | — | Key for OpenAI-compatible APIs |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Custom endpoint for the `openai` provider |
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LMStudio endpoint override |
| `LLAMACPP_BASE_URL` | `http://localhost:8080/v1` | llama.cpp (`llama-server`) endpoint override |
| `PROXY_PORT` | `9090` | Proxy port |
| `ANYMODEL_CLIENT` | — | Path to custom client cli.js |
| `ANYMODEL_TOKEN` | — | Auth token for remote mode |
| `OLLAMA_NUM_CTX` | `8192` | Ollama context window size |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long Ollama keeps model in GPU memory |
| `OLLAMA_MAX_SYSTEM_CHARS` | `4000` | System prompt condensing threshold |
| `OLLAMA_MAX_MSG_CHARS` | `max(4000, num_ctx*3)` | Message history threshold |
| `OLLAMA_TOOLS` | `auto` | Tool capability: auto/on/off |
| `OLLAMA_MAX_TOOLS` | `0` (unlimited) | Max tools to send (core tools always kept) |
| `OLLAMA_MAX_TOOL_DESC` | `100` | Max tool description length in chars |

`OPENROUTER_API_KEY` is only needed when starting the proxy. `OLLAMA_*` variables only apply to the Ollama provider.

## Links

- [anymodel.dev](https://anymodel.dev) — Homepage, docs, FAQ
- [OpenRouter](https://openrouter.ai/keys) — Get your API key
- [npm](https://www.npmjs.com/package/anymodel) — Package
- [YouTube](https://www.youtube.com/@AntonAbyzovAIPower) — Demos and tutorials

## License

MIT — [Anton Abyzov](https://github.com/antonoly)
