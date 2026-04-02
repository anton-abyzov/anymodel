# anymodel

**Run Claude Code with any AI model — Claude, GPT, Gemini, Llama, DeepSeek, and 200+ more.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/anton-abyzov/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

anymodel is a proxy that sits between Claude Code and your model provider. It strips Anthropic-specific fields, handles retries, and routes requests to OpenRouter (200+ models) or Ollama (local). Zero dependencies — just Node.js.

**[anymodel.dev](https://anymodel.dev)** — full docs, guides, and FAQ.

---

## Quick Start

### Proxy only (one command)

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel
```

Starts the proxy on `:9090`. Connect any client with `ANTHROPIC_BASE_URL=http://localhost:9090`.
Default model: `nvidia/nemotron-3-super-120b-a12b:free`.

### With Claude Code

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel claude
```

Starts the proxy and launches Claude Code automatically.

### Local (two terminals)

```bash
# Terminal 1 — start the proxy:
OPENROUTER_API_KEY=sk-or-v1-your-key npx anymodel proxy

# Terminal 2 — run Claude Code:
ANTHROPIC_BASE_URL=http://localhost:9090 claude
```

Get your free OpenRouter key at [openrouter.ai/keys](https://openrouter.ai/keys) — no credit card for free models.

---

## Model Presets

Pick a model by name — no `--model` flag needed:

```bash
npx anymodel gpt        # → openai/gpt-4o
npx anymodel gemini     # → google/gemini-2.5-flash
npx anymodel qwen       # → qwen/qwen3-coder:free
npx anymodel llama      # → meta-llama/llama-3.3-70b-instruct:free
npx anymodel deepseek   # → deepseek/deepseek-r1
npx anymodel nemotron   # → nvidia/nemotron-3-super-120b-a12b:free
```

Or use `--model` for any of 200+ models on OpenRouter:

```bash
npx anymodel --model qwen/qwen3.6-plus:free
npx anymodel --model anthropic/claude-opus-4.6
npx anymodel --model google/gemini-2.5-pro
```

## How It Works

```
PROXY:   anymodel → localhost:9090 → OpenRouter / Ollama / OpenAI-compatible
CLIENT:  anymodel claude → proxy + Claude Code (auto-connected)
```

The proxy intercepts `/v1/messages`, translates formats if needed, strips incompatible fields, retries with backoff, and streams back.

### OpenAI-Compatible Provider

Use **any OpenAI-compatible API** — OpenAI, Azure, Together, Groq, local vLLM, LMStudio:

```bash
# Terminal 1: proxy with OpenAI translation
OPENAI_API_KEY=sk-your-key \
  npx anymodel proxy openai --model gpt-4o

# Terminal 2: run the app
ANTHROPIC_BASE_URL=http://localhost:9090 node cli.js
```

The proxy translates between Anthropic Messages API ↔ OpenAI Chat Completions:
- Messages, tool calls, streaming — all translated bidirectionally
- Tool use (`tool_use`/`tool_result`) ↔ function calling (`tool_calls`/`tool`)
- SSE streaming format conversion

Custom endpoint (vLLM, LMStudio, etc.):
```bash
OPENAI_API_KEY=none OPENAI_BASE_URL=http://localhost:8080/v1 \
  npx anymodel proxy openai --model llama3
```

## CLI Reference

```
anymodel                              # proxy only (auto-detect provider)
anymodel claude                       # proxy + Claude Code client
anymodel gpt                          # proxy with GPT-4o preset
anymodel gemini                       # proxy with Gemini 2.5 Flash preset
anymodel qwen                         # proxy with Qwen3 Coder preset (free)
anymodel llama                        # proxy with Llama 3.3 70B preset (free)
anymodel deepseek                     # proxy with DeepSeek R1 preset
anymodel nemotron                     # proxy with Nemotron 120B preset (free)
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

anymodel auto-loads `.env` from the current directory.

## Cloudflare Worker

The remote proxy runs as a Cloudflare Worker at `api.anymodel.dev`. Deploy your own:

```bash
cd worker/
wrangler secret put OPENROUTER_API_KEY
wrangler deploy
```

BYOK: the worker uses the caller's OpenRouter key from the request — no shared key.

## Local Fork

For the full anymodel experience (custom banner, model display), clone [claude-code-anymodel](https://github.com/antonoly/claude-code-anymodel):

```bash
git clone https://github.com/antonoly/claude-code-anymodel && cd claude-code-anymodel
OPENROUTER_API_KEY=sk-or-v1-... npx anymodel
```

## Links

- [anymodel.dev](https://anymodel.dev) — Homepage, docs, guides
- [api.anymodel.dev/health](https://api.anymodel.dev/health) — Remote proxy status
- [OpenRouter](https://openrouter.ai/keys) — Get your API key
- [npm](https://www.npmjs.com/package/anymodel) — Package

## License

MIT — [Anton Abyzov](https://github.com/antonoly)
