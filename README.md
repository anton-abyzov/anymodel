# anymodel

**Universal AI model proxy — route any coding tool through OpenRouter, Ollama, or any LLM provider.**

[![npm version](https://img.shields.io/npm/v/anymodel)](https://www.npmjs.com/package/anymodel)
[![license](https://img.shields.io/npm/l/anymodel)](https://github.com/antonoly/anymodel/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/anymodel)](https://nodejs.org)

Use **any model** with your AI coding tools — GPT-4o, Gemini, Llama, Mistral, DeepSeek, and hundreds more. anymodel is a lightweight proxy that sits between your tools and your preferred AI provider, translating requests on the fly.

**Zero dependencies.** Just Node.js.

## Quick Start

```bash
npx anymodel
```

That's it. anymodel auto-detects your available provider and starts a local proxy.

## Usage

```bash
# Auto-detect provider (checks OPENROUTER_API_KEY, then local Ollama)
npx anymodel

# Explicitly use OpenRouter
npx anymodel openrouter

# Use local Ollama
npx anymodel ollama

# Specify a model
npx anymodel --model google/gemini-2.5-flash

# Custom port
npx anymodel --port 8080

# Combine options
npx anymodel openrouter --model deepseek/deepseek-r1 --port 3000
```

Then point your AI tool at the proxy:

```bash
ANTHROPIC_BASE_URL=http://localhost:9090 your-tool
```

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Your AI     │────>│   anymodel   │────>│  OpenRouter /     │
│  Tool        │<────│  :9090       │<────│  Ollama / etc.    │
└─────────────┘     └──────────────┘     └──────────────────┘
```

anymodel intercepts `/v1/messages` requests and routes them to your chosen provider. All other requests pass through unchanged.

The proxy automatically:
- Translates API-specific fields for cross-provider compatibility
- Normalizes `tool_choice` format across providers
- Retries failed requests with exponential backoff (3 attempts, max 8s delay)
- Streams responses back in real-time

## Supported Providers

| Provider | Command | Requirements |
|----------|---------|-------------|
| [OpenRouter](https://openrouter.ai) | `anymodel openrouter` | `OPENROUTER_API_KEY` |
| [Ollama](https://ollama.ai) | `anymodel ollama` | Ollama running locally |

### OpenRouter

Access 200+ models through a single API. [Get your API key](https://openrouter.ai/keys).

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npx anymodel openrouter --model google/gemini-2.5-flash
```

Popular models: `google/gemini-2.5-flash`, `deepseek/deepseek-r1`, `meta-llama/llama-4-maverick`, `openai/gpt-4o`

### Ollama

Run models locally with zero cloud dependency.

```bash
ollama serve
npx anymodel ollama --model llama3
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key | — |
| `OPENROUTER_MODEL` | Default model override | passthrough |
| `PROXY_PORT` | Proxy listen port | `9090` |

### .env File

anymodel auto-loads a `.env` file from the current directory:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.5-flash
```

## CLI Reference

```
anymodel [provider] [options]

Providers:
  openrouter    Route through OpenRouter
  ollama        Route through local Ollama
  remote        OpenRouter with free-only + auth (for shared/deployed use)

Options:
  --model, -m     Model to use (e.g., google/gemini-2.5-flash:free)
  --port, -p      Proxy port (default: 9090)
  --free-only     Only allow free models (default for remote)
  --token, -t     Require auth token for requests
  --rpm           Rate limit: requests per minute (default: 60)
  --help, -h      Show help
```

## Remote / Cloudflare Worker

anymodel includes a Cloudflare Worker for running the proxy at the edge — zero server management, global latency.

**Live endpoint:** `https://anymodel-proxy.anton-abyzov.workers.dev`

```bash
# Connect Claude Code to the remote proxy
ANTHROPIC_BASE_URL=https://anymodel-proxy.anton-abyzov.workers.dev \
ANTHROPIC_API_KEY=your-token \
claude
```

### Deploy your own

```bash
cd worker/
wrangler secret put OPENROUTER_API_KEY    # your OpenRouter key
wrangler secret put ANYMODEL_TOKEN        # auth token for clients
wrangler deploy                           # deploys to *.workers.dev
```

Features: free-only models by default, token auth, 60 req/min rate limiting, streaming, CORS.

### Test locally

```bash
ANYMODEL_TOKEN=test node worker/serve-local.mjs
curl http://localhost:9091/health
```

## Links

- [anymodel.dev](https://anymodel.dev) — Project homepage
- [OpenRouter](https://openrouter.ai) — Multi-model API gateway
- [GitHub](https://github.com/antonoly/anymodel) — Source code
- [Remote Proxy](https://anymodel-proxy.anton-abyzov.workers.dev/health) — Live Cloudflare Worker

## Origin

anymodel is based on the original `openrouter-proxy.mjs` by [Anton Abyzov](https://github.com/antonoly), built as a standalone tool to make AI model routing accessible to everyone.

## License

MIT &copy; 2025-2026 [Anton Abyzov (antonoly)](https://github.com/antonoly)
