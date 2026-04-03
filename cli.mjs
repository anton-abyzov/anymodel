#!/usr/bin/env node

// anymodel CLI — Run Claude Code with any AI model
//
// Usage:
//   npx anymodel                              # show usage
//   npx anymodel claude                       # run Claude Code directly
//   npx anymodel proxy                        # start proxy (requires OPENROUTER_API_KEY)
//   npx anymodel gpt                          # connect to running proxy with GPT-4o
//   npx anymodel gemini                       # connect to running proxy with Gemini
//   npx anymodel proxy ollama                 # start proxy with Ollama

import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createProxy, loadEnv } from './proxy.mjs';

const PROVIDERS = ['openrouter', 'ollama', 'openai'];

// Model presets — short aliases for popular models
const MODEL_PRESETS = {
  gpt:      'openai/gpt-5.4',
  gemini:   'google/gemini-3.1-flash-lite-preview',
  deepseek: 'deepseek/deepseek-r1-0528',
  qwen:     'qwen/qwen3-coder:free',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b:free',
  llama:    'meta-llama/llama-3.3-70b-instruct:free',
  gemma:    'google/gemma-3n-e4b-it:free',
};

// Verified free models on OpenRouter (zero cost) — from live /v1/models API
export const FREE_MODELS = [
  'openrouter/free',                                 // Auto-selects best free model
  'qwen/qwen3-coder:free',
  'qwen/qwen3.6-plus:free',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'nousresearch/hermes-3-llama-3.1-405b:free',
  'stepfun/step-3.5-flash:free',
  'minimax/minimax-m2.5:free',
];

// ANSI colors (lightweight, no dependency)
const C = {
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

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
      opts.freeOnly = true;
      if (!opts.token) opts.token = process.env.ANYMODEL_TOKEN || null;
    } else if (!arg.startsWith('-') && MODEL_PRESETS[arg] && !opts.model) {
      opts.model = MODEL_PRESETS[arg];
    }
  }

  return opts;
}

export async function detectProvider(model) {
  if (model && model.includes('/')) {
    if (process.env.OPENROUTER_API_KEY) return 'openrouter';
    return 'openrouter';
  }
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  const { default: ollama } = await import('./providers/ollama.mjs');
  if (await ollama.detect()) return 'ollama';
  return null;
}

function printQuickUsage() {
  console.log(`
${C.magenta('anymodel')} — run Claude Code with any AI model

${C.bold('Quick start:')}
  ${C.cyan('Terminal 1:')} OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy deepseek
  ${C.cyan('Terminal 2:')} npx anymodel

${C.bold('Commands:')}
  anymodel                          Connect to running proxy
  anymodel proxy <preset>           Start proxy with a preset model
  anymodel proxy --model <id>       Start proxy with any model
  anymodel claude                   Run Claude Code directly (no proxy)

${C.bold('Presets:')} gpt, gemini, deepseek, qwen, llama, nemotron, gemma

Run ${C.bold('anymodel --help')} for full options.
`);
}

function printHelp() {
  console.log(`
${C.magenta('  anymodel')} — run Claude Code with any AI model

  ${C.bold('Commands:')}
    anymodel                                      ${C.cyan('# connect to running proxy')}
    anymodel proxy deepseek                       ${C.cyan('# start proxy with DeepSeek R1')}
    anymodel proxy --model <id>                   ${C.cyan('# start proxy with any model')}
    anymodel proxy ollama --model llama3          ${C.cyan('# start proxy with local Ollama')}
    anymodel proxy openai --model gpt-4o          ${C.cyan('# start proxy with OpenAI-compatible')}
    anymodel claude                               ${C.cyan('# run Claude Code directly (no proxy)')}

  ${C.bold('Model Presets:')}
    gpt       → openai/gpt-5.4
    gemini    → google/gemini-3.1-flash-lite
    deepseek  → deepseek/deepseek-r1-0528
    qwen      → qwen/qwen3-coder:free          ${C.cyan('(free)')}
    nemotron  → nvidia/nemotron-3-super-120b:free ${C.cyan('(free)')}
    llama     → meta-llama/llama-3.3-70b:free   ${C.cyan('(free)')}
    gemma     → google/gemma-3n-e4b-it:free     ${C.cyan('(free)')}

  ${C.bold('Proxy Options:')} (only apply to ${C.bold('anymodel proxy')})
    --model, -m     Model to use (e.g., qwen/qwen3-coder:free)
    --port, -p      Proxy port (default: 9090)
    --free-only     Only allow free models
    --token, -t     Require auth token for requests
    --rpm           Rate limit: requests per minute (default: 60)

  ${C.bold('General Options:')}
    --port, -p      Port to check/connect (for presets, default: 9090)
    --help, -h      Show this help

  ${C.bold('Workflow:')}
    ${C.cyan('Terminal 1:')} OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy deepseek
    ${C.cyan('Terminal 2:')} npx anymodel

  ${C.bold('How it works:')}
    ${C.bold('anymodel proxy deepseek')} = starts proxy with DeepSeek R1 preset
    ${C.bold('anymodel proxy --model X')} = starts proxy with any OpenRouter model
    ${C.bold('anymodel')}                = connects to the running proxy
    ${C.bold('anymodel claude')}          = runs Claude Code directly (no proxy)

  ${C.bold('Environment:')}
    OPENROUTER_API_KEY   Your OpenRouter API key (for ${C.bold('proxy')} command)
    OPENROUTER_MODEL     Default model override
    OPENAI_API_KEY       API key for OpenAI-compatible endpoints
    OPENAI_BASE_URL      Base URL (default: https://api.openai.com/v1)
    ANYMODEL_TOKEN       Auth token for remote mode
    PROXY_PORT           Default port override

  https://anymodel.dev
`);
}

// ── Find a client to launch ──────────────────────────
function findClient() {
  // 1. cli.js in current directory (user's fork)
  const localCli = join(process.cwd(), 'cli.js');
  if (existsSync(localCli)) {
    return { cmd: process.execPath, args: [localCli], label: 'cli.js (local fork)' };
  }

  // 2. claude in PATH (Anthropic's global install)
  try {
    const isWin = process.platform === 'win32';
    const findCmd = isWin ? 'where claude 2>nul' : 'which claude 2>/dev/null';
    const claudePath = execSync(findCmd, { encoding: 'utf8' }).trim().split('\n')[0];
    if (claudePath && existsSync(claudePath)) {
      return { cmd: claudePath, args: [], label: 'claude (global)' };
    }
  } catch {}

  return null;
}

// ── Wait for proxy to be ready ───────────────────────
async function waitForProxy(port, maxAttempts = 50) {
  const http = await import('http');
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.default.get(`http://localhost:${port}/health`, res => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject();
        });
        req.on('error', reject);
        req.setTimeout(500, () => { req.destroy(); reject(); });
      });
      return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── Mode 1: Launch Claude Code directly (no proxy) ──
function launchClaude() {
  const client = findClient();
  if (!client) {
    console.error(`${C.red('Error:')} Claude Code not found.`);
    console.error('');
    console.error(`  Install it with:`);
    console.error(`    ${C.bold('npm i -g @anthropic-ai/claude-code')}`);
    console.error('');
    console.error(`  Then run:`);
    console.error(`    ${C.bold('npx anymodel claude')}`);
    console.error('');
    process.exit(1);
  }

  console.log(`${C.green('[anymodel]')} Launching Claude Code (${client.label})...`);
  console.log('');

  const clientChild = spawn(client.cmd, client.args, {
    stdio: 'inherit',
    env: process.env,
  });

  clientChild.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { clientChild.kill('SIGTERM'); process.exit(0); });
}

// ── Mode 2: Connect to running proxy ────────────────
async function connectToProxy(args) {
  const opts = parseArgs(args || []);
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  // Check if proxy is running
  const proxyUp = await waitForProxy(port, 1);
  if (!proxyUp) {
    console.error(`${C.red('Error:')} Proxy not running on :${port}.`);
    console.error('');
    console.error(`  Start the proxy first:`);
    console.error(`    ${C.bold(`OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy deepseek`)}`);
    console.error('');
    console.error(`  Then in another terminal:`);
    console.error(`    ${C.bold(`npx anymodel`)}`);
    console.error('');
    process.exit(1);
  }

  // Find Claude Code client
  const client = findClient();
  if (!client) {
    console.error(`${C.red('Error:')} Claude Code not found.`);
    console.error('');
    console.error(`  Install it with:`);
    console.error(`    ${C.bold('npm i -g @anthropic-ai/claude-code')}`);
    console.error('');
    process.exit(1);
  }

  console.log(`${C.green('[anymodel]')} Connected to proxy on :${port}`);
  console.log(`${C.green('[anymodel]')} Starting Claude Code...`);
  console.log('');

  const clientChild = spawn(client.cmd, client.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
    },
  });

  clientChild.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { clientChild.kill('SIGTERM'); process.exit(0); });
}

// ── Mode 3: Proxy only ──────────────────────────────
async function startProxyOnly(args) {
  loadEnv();
  const opts = parseArgs(args);

  if (opts.help) { printHelp(); process.exit(0); }

  let providerName = opts.provider;
  if (providerName === 'auto') {
    providerName = await detectProvider(opts.model);
    if (!providerName) {
      console.error(`${C.red('Error:')} Could not auto-detect a provider.`);
      console.error('');
      console.error('  Set OPENROUTER_API_KEY for OpenRouter:');
      console.error('    export OPENROUTER_API_KEY=sk-or-...');
      console.error('');
      console.error('  Set OPENAI_API_KEY for OpenAI-compatible endpoints:');
      console.error('    export OPENAI_API_KEY=sk-...');
      console.error('');
      console.error('  Or start Ollama for local models:');
      console.error('    ollama serve');
      process.exit(1);
    }
    console.log(`${C.cyan('[AUTO]')} Detected provider: ${providerName}`);
  }

  if (providerName === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.error(`${C.red('Error:')} OPENROUTER_API_KEY environment variable is required`);
    console.error('Get your key at https://openrouter.ai/keys');
    process.exit(1);
  }

  const { default: provider } = await import(`./providers/${providerName}.mjs`);

  const DEFAULT_PROXY_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
  let model = opts.model || process.env.OPENROUTER_MODEL || DEFAULT_PROXY_MODEL;
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  if (!opts.model && !process.env.OPENROUTER_MODEL) {
    console.log(`${C.cyan('[MODEL]')} Defaulting to ${C.bold(model)}`);
  }

  if (opts.freeOnly && !model.endsWith(':free') && !FREE_MODELS.includes(model)) {
    console.error(`${C.red('Error:')} --free-only is active but model "${model}" is not free.`);
    console.error('  Use a :free model or disable --free-only');
    process.exit(1);
  }

  if (opts.token) {
    console.log(`${C.cyan('[AUTH]')} Token authentication enabled`);
  }

  createProxy(provider, { port, model, freeOnly: opts.freeOnly, freeModels: FREE_MODELS, token: opts.token, rpm: opts.rpm });
}

// ── Entry point ──────────────────────────────────────
const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];

// Detect mode
const isHelpFlag = rawArgs.includes('--help') || rawArgs.includes('-h');
const isProxyMode = firstArg === 'proxy' || PROVIDERS.includes(firstArg) || firstArg === 'remote';
const isClientMode = firstArg === 'claude';
const isPreset = firstArg && MODEL_PRESETS[firstArg];
const isBare = rawArgs.length === 0;

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);

if (isMain) {
  if (isBare) {
    // `anymodel` — auto-connect to running proxy, or show usage
    connectToProxy([]);
  } else if (isHelpFlag && !isProxyMode) {
    // `anymodel --help` — show full help (but let proxy mode handle its own --help)
    printHelp();
  } else if (isClientMode) {
    // `anymodel claude` — launch Claude Code directly (no proxy)
    launchClaude();
  } else if (isProxyMode) {
    // `anymodel proxy [preset|provider] ...` — start proxy (presets resolved in parseArgs)
    const proxyArgs = firstArg === 'proxy' ? rawArgs.slice(1) : rawArgs;
    startProxyOnly(proxyArgs);
  } else if (isPreset) {
    // `anymodel gpt` — treated as `anymodel proxy gpt` (start proxy with preset)
    startProxyOnly(rawArgs);
  } else {
    // Unknown command — show quick usage
    console.error(`${C.red('Error:')} Unknown command "${firstArg}"`);
    console.error('');
    printQuickUsage();
    process.exit(1);
  }
}
