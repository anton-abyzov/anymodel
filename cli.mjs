#!/usr/bin/env node

// anymodel CLI — Universal AI model proxy
// Usage:
//   npx anymodel                          # auto-detect provider
//   npx anymodel openrouter               # use OpenRouter
//   npx anymodel ollama                   # use local Ollama
//   npx anymodel --model google/gemini-2.5-flash --port 8080

import { createProxy, loadEnv } from './proxy.mjs';

const PROVIDERS = ['openrouter', 'ollama'];

export function parseArgs(argv) {
  const opts = { provider: 'auto', port: 9090, model: null, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--model' || arg === '-m') {
      opts.model = argv[++i] || null;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = parseInt(argv[++i], 10) || 9090;
    } else if (!arg.startsWith('-') && PROVIDERS.includes(arg)) {
      opts.provider = arg;
    }
  }

  return opts;
}

export async function detectProvider() {
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';

  const { default: ollama } = await import('./providers/ollama.mjs');
  if (await ollama.detect()) return 'ollama';

  return null;
}

function printHelp() {
  console.log(`
\x1b[35m  anymodel\x1b[0m — Universal AI model proxy for any LLM

  \x1b[1mUsage:\x1b[0m
    anymodel [provider] [options]

  \x1b[1mProviders:\x1b[0m
    openrouter    Route through OpenRouter (needs OPENROUTER_API_KEY)
    ollama        Route through local Ollama instance

  \x1b[1mOptions:\x1b[0m
    --model, -m   Model to use (e.g., google/gemini-2.5-flash)
    --port, -p    Proxy port (default: 9090)
    --help, -h    Show this help

  \x1b[1mExamples:\x1b[0m
    anymodel                                    # auto-detect provider
    anymodel openrouter                         # use OpenRouter
    anymodel ollama --model llama3              # use Ollama with llama3
    anymodel --model google/gemini-2.5-flash    # specific model via OpenRouter

  \x1b[1mEnvironment:\x1b[0m
    OPENROUTER_API_KEY   Your OpenRouter API key (https://openrouter.ai/keys)
    OPENROUTER_MODEL     Default model override
    PROXY_PORT           Default port override

  https://anymodel.dev
`);
}

async function main() {
  loadEnv();

  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve provider
  let providerName = opts.provider;
  if (providerName === 'auto') {
    providerName = await detectProvider();
    if (!providerName) {
      console.error('\x1b[31mError: Could not auto-detect a provider.\x1b[0m');
      console.error('');
      console.error('  Set OPENROUTER_API_KEY for OpenRouter:');
      console.error('    export OPENROUTER_API_KEY=sk-or-...');
      console.error('    Get your key at https://openrouter.ai/keys');
      console.error('');
      console.error('  Or start Ollama for local models:');
      console.error('    ollama serve');
      console.error('');
      process.exit(1);
    }
    console.log(`\x1b[36m[AUTO]\x1b[0m Detected provider: ${providerName}`);
  }

  // Validate OpenRouter has API key
  if (providerName === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.error('\x1b[31mError: OPENROUTER_API_KEY environment variable is required\x1b[0m');
    console.error('Get your key at https://openrouter.ai/keys');
    process.exit(1);
  }

  // Load provider
  const { default: provider } = await import(`./providers/${providerName}.mjs`);

  // Model override: CLI flag > env var > none
  const model = opts.model || process.env.OPENROUTER_MODEL || null;
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  createProxy(provider, { port, model });
}

// Only run main when executed directly (not imported for testing)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);
if (isMain) main();
