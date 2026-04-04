# AnyModel

**Universal AI coding tool — use GPT-5.4, Gemini 3.1, DeepSeek R1, Codex, Llama, and 300+ models through one interface.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/anton-abyzov/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

AnyModel is an AI coding assistant that works with any model. It includes a proxy that routes requests to OpenRouter (300+ cloud models), Ollama (local/offline), or any OpenAI-compatible API — with smart retries, format translation, and zero dependencies.

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
AnyModel client → anymodel proxy (:9090) → OpenRouter / Ollama
```

The proxy intercepts requests, strips provider-specific fields, handles retries with exponential backoff, and streams responses back.

### Multiple Models at Once

Run separate instances on different ports:

```bash
npx anymodel proxy --port 9090 --model openai/gpt-5.4
npx anymodel proxy --port 9091 --model deepseek/deepseek-r1-0528
npx anymodel proxy --port 9092 --model google/gemini-3.1-flash-lite-preview
```

### Fully Local with Ollama

No internet, no API key — everything on your machine:

```bash
ollama pull gemma3n
npx anymodel proxy ollama --model gemma3n

# Terminal 2:
npx anymodel
```

### OpenAI-Compatible APIs

Works with OpenAI, Azure, Together, Groq, vLLM, LMStudio:

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
anymodel proxy ollama --model <name>  # proxy with local Ollama
anymodel claude                       # run with native Claude (no proxy)

Options:
  --model, -m     Model ID
  --port, -p      Port (default: 9090)
  --free-only     Block paid models
  --token, -t     Require auth token for requests
  --rpm           Rate limit requests/min (default: 60)
  --help, -h      Help
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter key ([get one free](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | Default model override |
| `OPENAI_API_KEY` | Key for OpenAI-compatible APIs |
| `OPENAI_BASE_URL` | Custom endpoint (default: `https://api.openai.com/v1`) |
| `PROXY_PORT` | Proxy port (default: `9090`) |
| `ANYMODEL_CLIENT` | Path to custom client cli.js |
| `ANYMODEL_TOKEN` | Auth token for remote mode |

`OPENROUTER_API_KEY` is only needed when starting the proxy.

## Links

- [anymodel.dev](https://anymodel.dev) — Homepage, docs, FAQ
- [OpenRouter](https://openrouter.ai/keys) — Get your API key
- [npm](https://www.npmjs.com/package/anymodel) — Package
- [YouTube](https://www.youtube.com/@AntonAbyzovAIPower) — Demos and tutorials

## License

MIT — [Anton Abyzov](https://github.com/antonoly)
