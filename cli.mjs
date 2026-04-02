#!/usr/bin/env node

// anymodel CLI — Universal AI model proxy
// Usage:
//   npx anymodel                          # auto-detect provider
//   npx anymodel openrouter               # use OpenRouter
//   npx anymodel ollama                   # use local Ollama
//   npx anymodel --model google/gemini-2.5-flash --port 8080

import { createProxy, loadEnv } from './proxy.mjs';

const PROVIDERS = ['openrouter', 'ollama'];

// Known free models on OpenRouter (zero cost, with tool use support)
export const FREE_MODELS = [
  'qwen/qwen3-coder:free',                          // Best free coding model (480B MoE)
  'google/gemini-2.5-flash:free',                    // Fast, great at code (94.2% HumanEval)
  'qwen/qwen3.6-plus-preview:free',                  // Newest, 1M context
  'openai/gpt-oss-120b:free',                        // OpenAI open-source 120B
  'deepseek/deepseek-chat-v3-0324:free',             // DeepSeek V3
  'meta-llama/llama-4-maverick:free',                // Llama 4 open weight
  'meta-llama/llama-4-scout:free',                   // Llama 4 lighter
  'qwen/qwen3-235b-a22b:free',                       // 235B MoE reasoning
  'google/gemini-3-flash-preview-20251217:free',      // Gemini 3 Flash preview
  'mistralai/mistral-small-3.1-24b-instruct:free',   // Mistral Small
];

export function parseArgs(argv) {
  const opts = { provider: 'auto', port: 9090, model: null, help: false, freeOnly: false, token: null, rpm: 60 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--model' || arg === '-m') {
      opts.model = argv[++i] || null;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = parseInt(argv[++i], 10) || 9090;
    } else if (arg === '--free-only' || arg === '--free') {
      opts.freeOnly = true;
    } else if (arg === '--token' || arg === '-t') {
      opts.token = argv[++i] || null;
    } else if (arg === '--rpm') {
      opts.rpm = parseInt(argv[++i], 10) || 60;
    } else if (!arg.startsWith('-') && PROVIDERS.includes(arg)) {
      opts.provider = arg;
    } else if (!arg.startsWith('-') && arg === 'remote') {
      opts.provider = 'openrouter';
      opts.freeOnly = true; // remote defaults to free-only for safety
      if (!opts.token) opts.token = process.env.ANYMODEL_TOKEN || null;
    }
  }

  return opts;
}

export async function detectProvider(model) {
  // If model contains '/', it's an OpenRouter-style model ID (e.g., google/gemini-2.5-flash)
  if (model && model.includes('/')) {
    if (process.env.OPENROUTER_API_KEY) return 'openrouter';
    // Model looks like OpenRouter but no key — still prefer OpenRouter, let it fail with clear error
    return 'openrouter';
  }

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
    remote        OpenRouter with --free-only + auth (for shared/deployed use)

  \x1b[1mOptions:\x1b[0m
    --model, -m     Model to use (e.g., google/gemini-2.5-flash:free)
    --port, -p      Proxy port (default: 9090)
    --free-only     Only allow free models (default for 'remote' mode)
    --token, -t     Require auth token for requests
    --rpm           Rate limit: requests per minute (default: 60)
    --help, -h      Show this help

  \x1b[1mExamples:\x1b[0m
    anymodel                                      # auto-detect provider
    anymodel openrouter                           # use OpenRouter
    anymodel --model google/gemini-2.5-flash      # specific model
    anymodel remote --token mysecret              # shared proxy, free models only
    anymodel --free-only                          # local, free models only

  \x1b[1mFree Models (all $0, with tool use):\x1b[0m
    qwen/qwen3-coder:free            Best for coding (480B MoE)
    google/gemini-2.5-flash:free     Fast, 94% HumanEval
    openai/gpt-oss-120b:free         OpenAI open-source 120B
    deepseek/deepseek-chat-v3-0324:free  DeepSeek V3
    meta-llama/llama-4-maverick:free Open weight Llama 4

  \x1b[1mEnvironment:\x1b[0m
    OPENROUTER_API_KEY   Your OpenRouter API key (https://openrouter.ai/keys)
    OPENROUTER_MODEL     Default model override
    ANYMODEL_TOKEN       Default auth token for remote mode
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
    providerName = await detectProvider(opts.model);
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
  let model = opts.model || process.env.OPENROUTER_MODEL || null;
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  // Free-only mode: if no model specified, default to best free model
  if (opts.freeOnly && !model) {
    model = FREE_MODELS[0]; // google/gemini-2.5-flash:free
    console.log(`${C.cyan('[FREE]')} No model specified, defaulting to ${C.bold(model)}`);
  }

  // Free-only validation
  if (opts.freeOnly && model && !model.endsWith(':free') && !FREE_MODELS.includes(model)) {
    console.error(`${C.red('Error:')} --free-only is active but model "${model}" is not free.`);
    console.error('');
    console.error('  Free models (append :free or use these IDs):');
    for (const m of FREE_MODELS.slice(0, 5)) {
      console.error(`    ${m}`);
    }
    console.error('');
    console.error('  Disable with: anymodel openrouter --model your-model (without --free-only)');
    process.exit(1);
  }

  if (opts.token) {
    console.log(`${C.cyan('[AUTH]')} Token authentication enabled`);
  }

  const { FREE_MODELS: fm } = await import('./cli.mjs');
  createProxy(provider, { port, model, freeOnly: opts.freeOnly, freeModels: fm, token: opts.token, rpm: opts.rpm });
}

// Only run main when executed directly (not imported for testing)
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);
if (isMain) main();
