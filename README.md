# AnyModel

**Run Claude Code with any AI model — GPT-5.4, Gemini 3.1, DeepSeek R1, Codex, and 200+ more.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/anton-abyzov/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

AnyModel is a proxy that routes requests to OpenRouter (200+ models), Ollama (local), or any OpenAI-compatible API. It strips Anthropic-specific fields, handles retries, and translates formats. Zero dependencies — just Node.js.

**[anymodel.dev](https://anymodel.dev)** — full docs, presets, and FAQ.

---

## Quick Start

```bash
# Terminal 1 — start the proxy:
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy deepseek

# Terminal 2 — connect:
npx anymodel
```

The model is set on the proxy via preset or `--model`. Connecting is always just `npx anymodel`.

Get your free OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys) — no credit card for free models.

---

## Presets

```bash
npx anymodel proxy gpt        # → openai/gpt-5.4              (paid)
npx anymodel proxy codex      # → openai/gpt-5.3-codex        (paid, coding)
npx anymodel proxy gemini     # → google/gemini-3.1-flash-lite (paid)
npx anymodel proxy deepseek   # → deepseek/deepseek-r1-0528   (paid)
npx anymodel proxy qwen       # → qwen/qwen3-coder:free       (free)
npx anymodel proxy nemotron   # → nvidia/nemotron-3-super-120b (free)
npx anymodel proxy llama      # → meta-llama/llama-3.3-70b    (free)
npx anymodel proxy gemma      # → google/gemma-4-31b-it        (paid)
```

Or any model: `npx anymodel proxy --model mistralai/codestral-latest`

## How It Works

```
AnyModel → anymodel proxy (:9090) → OpenRouter / Ollama
```

The proxy intercepts `/v1/messages`, strips incompatible fields, retries with backoff, and streams back.

### Multiple Models

```bash
npx anymodel proxy --port 9090 --model openai/gpt-5.4
npx anymodel proxy --port 9091 --model deepseek/deepseek-r1-0528
npx anymodel proxy --port 9092 --model google/gemini-3.1-flash-lite-preview
```

### Fully Local (Ollama)

```bash
ollama pull gemma3n
npx anymodel proxy ollama --model gemma3n

# Terminal 2:
npx anymodel
```

### OpenAI-Compatible APIs

```bash
OPENAI_API_KEY=sk-your-key npx anymodel proxy openai --model gpt-4o

# Terminal 2:
npx anymodel
```

Translates Anthropic Messages API ↔ OpenAI Chat Completions bidirectionally.

## CLI Reference

```
anymodel                              # connect to running proxy
anymodel proxy <preset>               # start proxy with preset
anymodel proxy --model <id>           # start proxy with any model
anymodel proxy ollama --model <name>  # proxy with local Ollama
anymodel claude                       # run with native Claude (no proxy)

Options:
  --model, -m     Model ID
  --port, -p      Port (default: 9090)
  --free-only     Block paid models
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

`OPENROUTER_API_KEY` is only needed when starting the proxy.

## Links

- [anymodel.dev](https://anymodel.dev) — Homepage, docs, FAQ
- [OpenRouter](https://openrouter.ai/keys) — Get your API key
- [npm](https://www.npmjs.com/package/anymodel) — Package
- [GitHub](https://github.com/anton-abyzov/anymodel) — Source

## License

MIT — [Anton Abyzov](https://github.com/antonoly)
