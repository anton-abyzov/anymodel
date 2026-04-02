#!/usr/bin/env node

// anymodel CLI — Universal AI model proxy + client launcher
//
// Usage:
//   npx anymodel                              # full experience: proxy + client
//   npx anymodel proxy                        # just the proxy server
//   npx anymodel proxy openrouter             # proxy with OpenRouter
//   npx anymodel proxy ollama                 # proxy with Ollama
//   npx anymodel --model qwen/qwen3-coder:free  # full experience with specific model

import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { createProxy, loadEnv } from './proxy.mjs';

const PROVIDERS = ['openrouter', 'ollama'];

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
  const { default: ollama } = await import('./providers/ollama.mjs');
  if (await ollama.detect()) return 'ollama';
  return null;
}

function printHelp() {
  console.log(`
${C.magenta('  anymodel')} — AI coding assistant with any model

  ${C.bold('Usage:')}
    anymodel                                      ${C.cyan('# launch app (proxy + client)')}
    anymodel proxy                                ${C.cyan('# just the proxy server')}
    anymodel proxy openrouter                     ${C.cyan('# proxy with OpenRouter')}
    anymodel proxy ollama                         ${C.cyan('# proxy with Ollama')}
    anymodel proxy remote --token secret          ${C.cyan('# proxy for deployment')}

  ${C.bold('Options:')}
    --model, -m     Model to use (e.g., qwen/qwen3-coder:free)
    --port, -p      Proxy port (default: 9090)
    --free-only     Only allow free models
    --token, -t     Require auth token for requests
    --rpm           Rate limit: requests per minute (default: 60)
    --help, -h      Show this help

  ${C.bold('How it works:')}
    ${C.bold('anymodel')}       = starts proxy in background + launches client
    ${C.bold('anymodel proxy')} = starts just the proxy (connect your own client)

  ${C.bold('Client auto-detection:')}
    1. ${C.cyan('./cli.js')} in current directory (your fork)
    2. ${C.cyan('claude')} in PATH (Anthropic's global install)
    3. If neither found, proxy starts and prints connect instructions

  ${C.bold('Free Models (all $0):')}
    qwen/qwen3-coder:free                 Best for coding
    nvidia/nemotron-3-super-120b-a12b:free NVIDIA reasoning 120B
    qwen/qwen3.6-plus:free                1M context
    openai/gpt-oss-120b:free              OpenAI open-source

  ${C.bold('Environment:')}
    OPENROUTER_API_KEY   Your OpenRouter API key
    OPENROUTER_MODEL     Default model override
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
    const claudePath = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
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

// ── Mode 1: Full experience (proxy + client) ────────
async function startFull(args) {
  loadEnv();
  const opts = parseArgs(args);

  if (opts.help) { printHelp(); process.exit(0); }

  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;
  const remoteUrl = process.env.ANYMODEL_REMOTE_URL || 'https://anymodel-proxy.anton-abyzov.workers.dev';
  const remoteToken = process.env.ANYMODEL_TOKEN || '';

  // Try remote proxy when OPENROUTER_API_KEY is set (simplest path)
  if (!opts.provider || opts.provider === 'auto') {
    const openrouterKey = process.env.OPENROUTER_API_KEY || '';
    if (openrouterKey.startsWith('sk-or-')) {
      console.log(`${C.cyan('[anymodel]')} Checking remote proxy...`);
      try {
        const https = await import('https');
        const ok = await new Promise((resolve) => {
          const req = https.default.get(`${remoteUrl}/health`, { timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        });
        if (ok) {
          console.log(`${C.green('[anymodel]')} Remote proxy available at ${C.bold('api.anymodel.dev')}`);
          const modelLabel = opts.model || 'openrouter/free (auto-selects best free model)';
          const client = findClient();
          if (client) {
            console.log(`${C.green('[anymodel]')} Launching ${C.bold(client.label)}`);
            console.log(`${C.green('[anymodel]')} Model: ${C.cyan(modelLabel)}`);
            console.log('');
            const clientChild = spawn(client.cmd, client.args, {
              stdio: 'inherit',
              env: {
                ...process.env,
                ANTHROPIC_BASE_URL: remoteUrl,
                ANTHROPIC_API_KEY: openrouterKey,  // BYOK: user's own key
                ANYMODEL_MODEL: modelLabel,
              },
            });
            clientChild.on('exit', (code) => process.exit(code || 0));
            process.on('SIGINT', () => { clientChild.kill('SIGTERM'); process.exit(0); });
            return;
          }
        }
      } catch {}
      console.log(`${C.yellow('[anymodel]')} Remote not available, starting local proxy...`);
    }
  }

  // Build proxy args
  const proxyArgs = ['proxy'];
  if (opts.model) proxyArgs.push('--model', opts.model);
  if (opts.freeOnly) proxyArgs.push('--free-only');
  if (opts.port) proxyArgs.push('--port', String(opts.port));
  if (opts.provider !== 'auto') proxyArgs.push(opts.provider);

  // Start proxy as child process with IPC for port discovery
  const __filename = fileURLToPath(import.meta.url);
  const proxyChild = spawn(process.execPath, [__filename, ...proxyArgs], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  });

  proxyChild.on('error', (err) => {
    console.error(`${C.red('[ERROR]')} Failed to start proxy: ${err.message}`);
    process.exit(1);
  });

  // Wait for proxy to report its actual port via IPC
  console.log(`${C.cyan('[anymodel]')} Starting proxy...`);
  const actualPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Proxy startup timeout')), 15000);
    proxyChild.on('message', (msg) => {
      if (msg.type === 'port') { clearTimeout(timeout); resolve(msg.port); }
    });
    proxyChild.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Proxy exited with code ${code}`));
    });
  }).catch(err => {
    console.error(`${C.red('[ERROR]')} ${err.message}. Check OPENROUTER_API_KEY in your .env`);
    proxyChild.kill();
    process.exit(1);
  });

  // Find client
  const client = findClient();
  if (!client) {
    console.log('');
    console.log(`${C.green('[anymodel]')} Proxy running. No client found in this directory.`);
    console.log('');
    console.log(`  ${C.bold('Option A:')} cd to your fork and re-run:`);
    console.log(`    cd ~/Projects/claude-code-umb/repositories/antonoly/claude-code`);
    console.log(`    npx anymodel`);
    console.log('');
    console.log(`  ${C.bold('Option B:')} Connect manually:`);
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${actualPort} node cli.js`);
    console.log(`    ANTHROPIC_BASE_URL=http://localhost:${actualPort} claude`);
    console.log('');
    // Keep proxy running — user will connect manually
    return;
  }

  // Determine model label for the banner — show the ACTUAL model, not "auto"
  const modelLabel = opts.model || process.env.OPENROUTER_MODEL || FREE_MODELS[0];

  console.log(`${C.green('[anymodel]')} Launching ${C.bold(client.label)}`);
  console.log(`${C.green('[anymodel]')} Model: ${C.cyan(modelLabel)}`);
  console.log('');

  // Launch client with ANTHROPIC_BASE_URL and ANYMODEL_MODEL set
  const clientChild = spawn(client.cmd, client.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${actualPort}`,
      ANYMODEL_MODEL: modelLabel,
    },
  });

  // Clean shutdown: when client exits, kill proxy
  clientChild.on('exit', (code) => {
    proxyChild.kill();
    process.exit(code || 0);
  });

  // Handle Ctrl+C
  const cleanup = () => {
    clientChild.kill('SIGTERM');
    proxyChild.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ── Mode 2: Proxy only (current behavior) ────────────
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

  let model = opts.model || process.env.OPENROUTER_MODEL || null;
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  if (opts.freeOnly && !model) {
    model = FREE_MODELS[0];
    console.log(`${C.cyan('[FREE]')} Defaulting to ${C.bold(model)}`);
  }

  if (opts.freeOnly && model && !model.endsWith(':free') && !FREE_MODELS.includes(model)) {
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
const isProxyMode = firstArg === 'proxy' || PROVIDERS.includes(firstArg) || firstArg === 'remote';

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);

if (isMain) {
  if (isProxyMode) {
    // `anymodel proxy ...` or `anymodel openrouter` or `anymodel remote`
    const proxyArgs = firstArg === 'proxy' ? rawArgs.slice(1) : rawArgs;
    startProxyOnly(proxyArgs);
  } else {
    // `anymodel` or `anymodel --model X` — full experience
    startFull(rawArgs);
  }
}
