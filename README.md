# anymodel

**Run Claude Code with any AI model — Claude, GPT, Gemini, Llama, DeepSeek, and 200+ more.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/anton-abyzov/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

anymodel is a CLI that runs Claude Code directly or proxies it through any model provider. It strips Anthropic-specific fields, handles retries, and routes requests to OpenRouter (200+ models), Ollama (local), or any OpenAI-compatible API. Zero dependencies — just Node.js.

**[anymodel.dev](https://anymodel.dev)** — full docs, guides, and FAQ.

---

## Quick Start

```bash
# Terminal 1 — start the proxy with a model:
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy --model deepseek/deepseek-r1

# Terminal 2 — connect Claude Code:
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

The model is set on the proxy via `--model`. Claude Code just connects to it.

Get your free OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys) — no credit card for free models.

---

## Model Presets

Pick a model by name — no `--model` flag needed. Start the proxy first, then connect:

```bash
# Start proxy first (Terminal 1):
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy

# Then pick a model (Terminal 2):
npx anymodel gpt        # → openai/gpt-4o
npx anymodel gemini     # → google/gemini-2.5-flash
npx anymodel qwen       # → qwen/qwen3-coder:free
npx anymodel llama      # → meta-llama/llama-3.3-70b-instruct:free
npx anymodel deepseek   # → deepseek/deepseek-r1
npx anymodel nemotron   # → nvidia/nemotron-3-super-120b-a12b:free
```

Or use `--model` for any of 200+ models on OpenRouter:

```bash
# Terminal 1:
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy

# Terminal 2:
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

Or with a custom model via proxy:

```bash
npx anymodel proxy --model qwen/qwen3.6-plus:free
```

## How It Works

```
Claude Code → anymodel proxy → OpenRouter / Ollama / OpenAI-compatible
```

The proxy intercepts `/v1/messages`, translates formats if needed, strips incompatible fields, retries with backoff, and streams back.

### Multiple Models at Once

Run separate proxy instances on different ports — one per model:

```bash
# Start each proxy with its own model and port:
OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy --port 9090 --model openai/gpt-4o
OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy --port 9091 --model deepseek/deepseek-r1
OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy --port 9092 --model google/gemini-2.5-flash

# Connect to any — the model is already set on the proxy:
ANTHROPIC_BASE_URL=http://localhost:9090 claude    # GPT-4o
ANTHROPIC_BASE_URL=http://localhost:9091 claude    # DeepSeek R1
ANTHROPIC_BASE_URL=http://localhost:9092 claude    # Gemini
```

### Fully Local with Ollama

No internet, no API key — everything stays on your machine:

```bash
# 1. Pull a model:
ollama pull llama4-maverick

# 2. Start proxy (Terminal 1):
npx anymodel proxy ollama --model llama4-maverick

# 3. Use it (Terminal 2):
npx anymodel llama --port 9090
```

### OpenAI-Compatible Provider

Use **any OpenAI-compatible API** — OpenAI, Azure, Together, Groq, local vLLM, LMStudio:

```bash
# Terminal 1: start proxy with OpenAI translation
OPENAI_API_KEY=sk-your-key npx anymodel proxy openai --model gpt-4o

# Terminal 2: run Claude Code
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

The proxy translates between Anthropic Messages API and OpenAI Chat Completions:
- Messages, tool calls, streaming — all translated bidirectionally
- Tool use (`tool_use`/`tool_result`) mapped to function calling (`tool_calls`/`tool`)
- SSE streaming format conversion

Custom endpoint (vLLM, LMStudio, etc.):
```bash
OPENAI_API_KEY=none OPENAI_BASE_URL=http://localhost:8080/v1 \
  npx anymodel proxy openai --model llama3
```

## CLI Reference

```
anymodel                              # show usage / help
anymodel claude                       # run Claude Code directly (no proxy)
anymodel proxy                        # start proxy (requires OPENROUTER_API_KEY)
anymodel gpt                          # connect to proxy with GPT-4o
anymodel gemini                       # connect to proxy with Gemini 2.5 Flash
anymodel qwen                         # connect to proxy with Qwen3 Coder (free)
anymodel llama                        # connect to proxy with Llama 3.3 70B (free)
anymodel deepseek                     # connect to proxy with DeepSeek R1
anymodel nemotron                     # connect to proxy with Nemotron 120B (free)
anymodel proxy ollama                 # proxy with local Ollama
anymodel proxy openai                 # proxy with OpenAI-compatible (translates format)

Options:
  --model, -m     Model (e.g., qwen/qwen3-coder:free)
  --port, -p      Port (default: 9090)
  --free-only     Block paid models
  --token, -t     Require auth token
  --rpm           Rate limit per minute (default: 60)
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

`OPENROUTER_API_KEY` is only needed when starting the proxy (`anymodel proxy`). Model presets and `anymodel claude` don't require it.

anymodel auto-loads `.env` from the current directory.

## Cloudflare Worker

The remote proxy runs as a Cloudflare Worker at `api.anymodel.dev`. Deploy your own:

```bash
cd worker/
wrangler secret put OPENROUTER_API_KEY
wrangler deploy
```

BYOK: the worker uses the caller's OpenRouter key from the request — no shared key.

## Local Development (Optional)

For contributing or customizing anymodel, you can clone the repo:

```bash
git clone https://github.com/antonoly/claude-code-anymodel && cd claude-code-anymodel
```

This is optional — `npx anymodel` works without cloning.

## Links

- [anymodel.dev](https://anymodel.dev) — Homepage, docs, guides
- [api.anymodel.dev/health](https://api.anymodel.dev/health) — Remote proxy status
- [OpenRouter](https://openrouter.ai/keys) — Get your API key
- [npm](https://www.npmjs.com/package/anymodel) — Package

## License

MIT — [Anton Abyzov](https://github.com/antonoly)
