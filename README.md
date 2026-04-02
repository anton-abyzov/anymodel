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

Options:
  --model, -m   Model to use (e.g., google/gemini-2.5-flash)
  --port, -p    Proxy port (default: 9090)
  --help, -h    Show help
```

## Links

- [anymodel.dev](https://anymodel.dev) — Project homepage
- [OpenRouter](https://openrouter.ai) — Multi-model API gateway
- [GitHub](https://github.com/antonoly/anymodel) — Source code

## License

MIT &copy; 2025 [antonoly](https://github.com/antonoly)
