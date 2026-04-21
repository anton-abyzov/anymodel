#!/usr/bin/env node

// anymodel CLI — Universal AI coding tool
//
// Usage:
//   npx anymodel                              # show usage
//   npx anymodel claude                       # run Claude Code directly
//   npx anymodel proxy                        # start proxy (requires OPENROUTER_API_KEY)
//   npx anymodel gpt                          # connect to running proxy with GPT-4o
//   npx anymodel gemini                       # connect to running proxy with Gemini
//   npx anymodel proxy ollama                 # start proxy with Ollama

import { spawn, execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createProxy, loadEnv } from './proxy.mjs';

const PROVIDERS = ['openrouter', 'ollama', 'openai', 'lmstudio', 'llamacpp'];
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'llamacpp'];

// Model presets — short aliases for popular models
const MODEL_PRESETS = {
  gpt:      'openai/gpt-5.4',
  codex:    'openai/gpt-5.3-codex',
  gemini:   'google/gemini-3.1-flash-lite-preview',
  deepseek: 'deepseek/deepseek-r1-0528',
  mistral:  'mistralai/devstral-2512',
  gemma:    'google/gemma-4-31b-it',
  qwen:     'qwen/qwen3-coder:free',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b:free',
  llama:    'meta-llama/llama-3.3-70b-instruct:free',
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
  const opts = { provider: 'auto', port: 9090, model: null, help: false, freeOnly: false, token: null, rpm: 60, passthrough: [], fullMcp: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `--` separator: everything after is forwarded verbatim to the Claude Code client
    if (arg === '--') {
      opts.passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--model' || arg === '-m') {
      opts.model = argv[++i] || null;
    } else if (arg === '--port' || arg === '-p') {
      const p = parseInt(argv[++i], 10);
      opts.port = (p > 0 && p <= 65535) ? p : 9090;
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
    } else if (arg === '--lmstudio') {
      opts.provider = 'lmstudio';
    } else if (arg === '--llamacpp') {
      opts.provider = 'llamacpp';
    } else if (arg === '--full-mcp') {
      // Opt out of auto-MCP-suppression on local providers (keep global MCP servers)
      opts.fullMcp = true;
    } else if (!arg.startsWith('-') && MODEL_PRESETS[arg] && !opts.model) {
      opts.model = MODEL_PRESETS[arg];
    }
  }

  return opts;
}

// Decide whether to auto-strip global MCP servers for the current session.
// Local providers always get suppressed unless the user opts out or already passed an MCP flag.
export function shouldAutoSuppressMcp(providerName, opts) {
  if (!LOCAL_PROVIDERS.includes(providerName)) return false;
  if (opts.fullMcp) return false;
  if (process.env.ANYMODEL_FULL_MCP === '1') return false;
  // If user explicitly passed --mcp-config or --strict-mcp-config, respect their choice
  const userMcpFlag = opts.passthrough.some(a => a === '--mcp-config' || a === '--strict-mcp-config');
  if (userMcpFlag) return false;
  return true;
}

// Find the right MCP config path. Prefer project-local ./.claude/.mcp.json, otherwise
// create a one-shot empty config in a stable cache dir so repeated launches reuse it.
export function resolveProjectMcpPath() {
  const projectMcp = join(process.cwd(), '.claude', '.mcp.json');
  if (existsSync(projectMcp)) return projectMcp;
  // Cached empty MCP so we don't spam the tempdir on every launch
  const cacheDir = join(tmpdir(), 'anymodel');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const emptyPath = join(cacheDir, 'empty-mcp.json');
  if (!existsSync(emptyPath)) writeFileSync(emptyPath, '{"mcpServers":{}}\n');
  return emptyPath;
}

// Pure formatter for the local-provider onboarding banner. Takes fs facts as
// arguments so it's unit-testable without mocking the filesystem.
// Returns an array of pre-colored lines ready for console.log.
export function formatLocalProviderBanner({ providerName, mcpPath, hasProjectMcp, hasProjectClaudeDir, hasProjectSkills, hasProjectAgents }) {
  const tag = C.green('[anymodel]');
  const lines = [];

  if (hasProjectMcp) {
    const rel = mcpPath.replace(process.cwd(), '.');
    lines.push(`${tag} Local provider (${providerName}) — global MCP suppressed, using project MCP: ${C.cyan(rel)}`);
    const extras = [];
    if (hasProjectSkills) extras.push('skills');
    if (hasProjectAgents) extras.push('agents');
    if (extras.length) lines.push(`${tag} Project ${extras.join(' + ')} from ${C.cyan('./.claude/')} will also load`);
    lines.push(`${tag} Pass ${C.bold('--full-mcp')} to keep global MCP servers`);
  } else if (hasProjectClaudeDir) {
    lines.push(`${tag} Local provider (${providerName}) — global MCP suppressed (no MCP servers this session)`);
    const extras = [];
    if (hasProjectSkills) extras.push('skills');
    if (hasProjectAgents) extras.push('agents');
    if (extras.length) lines.push(`${tag} Project ${extras.join(' + ')} from ${C.cyan('./.claude/')} will load`);
    lines.push('');
    lines.push(`  ${C.bold('Tip:')} to add MCP tools, create ${C.cyan('./.claude/.mcp.json')}:`);
    lines.push(`    ${C.cyan('{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}}')}`);
    lines.push('');
  } else {
    lines.push(`${tag} Local provider (${providerName}) — global MCP, skills, and plugins suppressed for speed`);
    lines.push('');
    lines.push(`  ${C.bold('No project config detected. To add tools to this session, create:')}`);
    lines.push(`    ${C.cyan('./.claude/.mcp.json')}              — MCP servers`);
    lines.push(`    ${C.cyan('./.claude/skills/<name>/SKILL.md')}  — custom skills`);
    lines.push(`    ${C.cyan('./.claude/agents/<name>.md')}        — custom subagents`);
    lines.push(`    ${C.cyan('./CLAUDE.md')}                       — project instructions`);
    lines.push('');
    lines.push(`  Or pass ${C.bold('--full-mcp')} to keep global MCP (slow on local).`);
    lines.push(`  Docs: ${C.cyan('https://github.com/anton-abyzov/anymodel/blob/main/LOCAL_SETUP.md')}`);
    lines.push('');
  }
  return lines;
}

// Helper that the connectToProxy function calls — does the fs I/O and prints.
export function printLocalProviderBanner(providerName, mcpPath) {
  const cwd = process.cwd();
  const lines = formatLocalProviderBanner({
    providerName,
    mcpPath,
    hasProjectMcp: existsSync(join(cwd, '.claude', '.mcp.json')),
    hasProjectClaudeDir: existsSync(join(cwd, '.claude')),
    hasProjectSkills: existsSync(join(cwd, '.claude', 'skills')),
    hasProjectAgents: existsSync(join(cwd, '.claude', 'agents')),
  });
  lines.forEach(l => console.log(l));
}

export async function detectProvider(model) {
  if (model && model.includes('/')) {
    return 'openrouter';
  }
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_API_KEY) return 'openai';
  const { default: ollama } = await import('./providers/ollama.mjs');
  if (await ollama.detect()) return 'ollama';
  const { default: lmstudio } = await import('./providers/lmstudio.mjs');
  if (await lmstudio.detect()) return 'lmstudio';
  const { default: llamacpp } = await import('./providers/llamacpp.mjs');
  if (await llamacpp.detect()) return 'llamacpp';
  return null;
}

function printQuickUsage() {
  console.log(`
${C.magenta('anymodel')} — universal AI coding tool

${C.bold('Quick start:')}
  ${C.cyan('Terminal 1:')} OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy deepseek
  ${C.cyan('Terminal 2:')} npx anymodel

${C.bold('Commands:')}
  anymodel                          Connect to running proxy
  anymodel proxy <preset>           Start proxy with a preset model
  anymodel proxy --model <id>       Start proxy with any model
  anymodel claude                   Run Claude Code directly (no proxy)

${C.bold('Presets:')} gpt, codex, gemini, deepseek, mistral, gemma, qwen, nemotron, llama

Run ${C.bold('anymodel --help')} for full options.
`);
}

function printHelp() {
  console.log(`
${C.magenta('  anymodel')} — universal AI coding tool

  ${C.bold('Commands:')}
    anymodel                                      ${C.cyan('# connect to running proxy')}
    anymodel proxy deepseek                       ${C.cyan('# start proxy with DeepSeek R1')}
    anymodel proxy --model <id>                   ${C.cyan('# start proxy with any model')}
    anymodel proxy ollama --model llama3          ${C.cyan('# start proxy with local Ollama')}
    anymodel proxy lmstudio --model qwen2.5-coder ${C.cyan('# start proxy with local LM Studio')}
    anymodel proxy llamacpp --model qwen2.5-coder ${C.cyan('# start proxy with local llama.cpp')}
    anymodel proxy openai --model gpt-4o          ${C.cyan('# start proxy with OpenAI-compatible')}
    anymodel claude                               ${C.cyan('# run Claude Code directly (no proxy)')}

  ${C.bold('Model Presets:')}
    gpt       → openai/gpt-5.4
    codex     → openai/gpt-5.3-codex            ${C.cyan('(coding)')}
    gemini    → google/gemini-3.1-flash-lite-preview
    deepseek  → deepseek/deepseek-r1-0528
    mistral   → mistralai/devstral-2512         ${C.cyan('(coding)')}
    gemma     → google/gemma-4-31b-it
    qwen      → qwen/qwen3-coder:free          ${C.cyan('(free)')}
    nemotron  → nvidia/nemotron-3-super-120b-a12b:free ${C.cyan('(free)')}
    llama     → meta-llama/llama-3.3-70b-instruct:free ${C.cyan('(free)')}

  ${C.bold('Proxy Options:')} (only apply to ${C.bold('anymodel proxy')})
    --model, -m     Model to use (e.g., qwen/qwen3-coder:free)
    --port, -p      Proxy port (default: 9090)
    --free-only     Only allow free models
    --token, -t     Require auth token for requests
    --rpm           Rate limit: requests per minute (default: 60)

  ${C.bold('General Options:')}
    --port, -p      Port to check/connect (for presets, default: 9090)
    --full-mcp      Keep all globally-configured MCP servers (default on local: suppress global MCP)
    --help, -h      Show this help

  ${C.bold('Client passthrough:')} everything after ${C.bold('--')} is forwarded to Claude Code
    ${C.cyan('npx anymodel -- --bare                                  # skip global config')}
    ${C.cyan('npx anymodel -- --append-system-prompt "$(cat CLAUDE.md)"  # inject project context')}

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
    LMSTUDIO_BASE_URL    LM Studio base URL (default: http://127.0.0.1:1234/v1)
    LLAMACPP_BASE_URL    llama.cpp base URL (default: http://127.0.0.1:8080/v1)
    ANYMODEL_TOKEN       Auth token for remote mode
    PROXY_PORT           Default port override

  https://anymodel.dev
`);
}

// ── Find a client to launch ──────────────────────────
function findClient() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // 0. ANYMODEL_CLIENT env var — explicit path to custom cli.js (highest priority)
  const envClient = process.env.ANYMODEL_CLIENT;
  if (envClient && existsSync(envClient)) {
    return { cmd: process.execPath, args: [envClient], label: 'cli.js (ANYMODEL_CLIENT)' };
  }

  // 1. cli.js next to this script (bundled with npm package)
  const siblingCli = join(__dirname, 'cli.js');
  if (existsSync(siblingCli)) {
    return { cmd: process.execPath, args: [siblingCli], label: 'cli.js (bundled)' };
  }

  // 2. cli.js in current directory (local dev clone)
  const localCli = join(process.cwd(), 'cli.js');
  if (existsSync(localCli)) {
    return { cmd: process.execPath, args: [localCli], label: 'cli.js (local)' };
  }

  // 3. Sibling repos (umbrella/monorepo layout)
  for (const name of ['claude-code', 'claude-code-anymodel']) {
    const p = join(__dirname, '..', name, 'cli.js');
    if (existsSync(p)) {
      return { cmd: process.execPath, args: [p], label: `cli.js (${name})` };
    }
  }

  // 4. Well-known home directory locations
  for (const rel of ['claude-code-anymodel/cli.js', 'claude-code/cli.js']) {
    const p = join(home, rel);
    if (existsSync(p)) {
      return { cmd: process.execPath, args: [p], label: `cli.js (~/${rel})` };
    }
  }

  // 5. claude in PATH (global install — fallback)
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

  clientChild.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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

  // Query proxy for model + provider name
  let modelName = '';
  let providerName = '';
  try {
    const http = await import('http');
    const healthData = await new Promise((resolve) => {
      http.default.get(`http://localhost:${port}/health`, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      }).on('error', () => resolve({}));
    });
    modelName = healthData.model || '';
    providerName = healthData.provider || '';
  } catch {}

  console.log(`${C.green('[anymodel]')} Connected to proxy on :${port}`);
  if (modelName) console.log(`${C.green('[anymodel]')} Model: ${C.cyan(modelName)}`);
  if (opts.passthrough.length) {
    console.log(`${C.green('[anymodel]')} Passthrough args: ${opts.passthrough.join(' ')}`);
  }

  // Auto-suppress global MCP servers when driving a local model. Claude Code's
  // default behavior is to forward ALL globally-configured MCP servers (often 15+
  // = 50K+ tokens of tool schemas), which local models can't handle. We scope it
  // to the project's own MCP config if present, else an empty one.
  const autoArgs = [];
  if (shouldAutoSuppressMcp(providerName, opts)) {
    const mcpPath = resolveProjectMcpPath();
    autoArgs.push('--strict-mcp-config', '--mcp-config', mcpPath);
    printLocalProviderBanner(providerName, mcpPath);
  } else if (providerName && LOCAL_PROVIDERS.includes(providerName) && opts.fullMcp) {
    console.log(`${C.yellow('[anymodel]')} --full-mcp: keeping global MCP servers (may be slow on local models)`);
  }

  console.log(`${C.green('[anymodel]')} Starting...`);
  console.log('');

  // clientArgs: auto-injected strict-mcp-config (if local provider) + user passthrough
  const clientArgs = [...client.args, ...autoArgs, ...opts.passthrough];
  const clientChild = spawn(client.cmd, clientArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${port}`,
      // Suppress "Not logged in" — proxy handles auth, Claude Code doesn't need its own key
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'anymodel-proxy',
      // Override Claude Code's displayed model so /context shows the actual backend model
      // instead of the default claude-opus-*. Respects user's ANTHROPIC_MODEL if already set.
      ...(modelName && !process.env.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: modelName } : {}),
      ...(modelName ? { ANYMODEL_MODEL: modelName } : {}),
    },
  });

  clientChild.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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
  let model = opts.model || process.env.OPENROUTER_MODEL;
  const port = opts.port || parseInt(process.env.PROXY_PORT, 10) || 9090;

  // For Ollama: validate model exists or auto-detect first installed model
  if (providerName === 'ollama') {
    try {
      const http = await import('http');
      const models = await new Promise((resolve) => {
        http.default.get('http://localhost:11434/api/tags', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
      });
      if (!models?.models?.length) {
        console.error(`${C.red('Error:')} No models installed in Ollama.`);
        console.error('');
        console.error(`  Pull a model first:`);
        console.error(`    ${C.bold('ollama pull gemma3n')}`);
        console.error('');
        console.error(`  Then run:`);
        console.error(`    ${C.bold('npx anymodel proxy ollama --model gemma3n')}`);
        console.error('');
        process.exit(1);
      }
      const names = models.models.map(m => m.name);
      if (model) {
        // Validate that the specified model exists in Ollama
        const exact = names.includes(model);
        const withTag = names.includes(`${model}:latest`);
        const baseMatch = names.find(n => n.split(':')[0] === model.split(':')[0]);
        if (!exact && !withTag) {
          console.error(`${C.red('Error:')} Model ${C.bold(model)} not found in Ollama.`);
          console.error('');
          if (baseMatch) {
            console.error(`  Did you mean: ${C.bold(baseMatch)}?`);
            console.error('');
          }
          console.error(`  Pull it first:`);
          console.error(`    ${C.bold(`ollama pull ${model}`)}`);
          console.error('');
          console.error(`  Available models:`);
          names.slice(0, 10).forEach(n => console.error(`    ${n}`));
          if (names.length > 10) console.error(`    ... and ${names.length - 10} more (${C.bold('ollama list')})`);
          console.error('');
          process.exit(1);
        }
      } else {
        // Auto-detect first installed model
        model = names[0];
        console.log(`${C.cyan('[OLLAMA]')} Found ${names.length} model(s). Using: ${C.bold(model)}`);
        if (names.length > 1) {
          console.log(`${C.cyan('[OLLAMA]')} Other available: ${names.slice(1, 5).join(', ')}`);
          console.log(`${C.cyan('[OLLAMA]')} List all: ${C.bold('ollama list')}`);
        }
      }
    } catch {
      console.error(`${C.red('Error:')} Cannot connect to Ollama at localhost:11434.`);
      console.error('');
      console.error(`  Start Ollama first: ${C.bold('ollama serve')}`);
      process.exit(1);
    }
  }

  // For lmstudio/llamacpp: probe /v1/models and pick the best default if --model not set.
  // Providers return [{ id, loaded, capabilities }] — prefer already-loaded coding models
  // so the first real request doesn't trigger a 30-60s cold load.
  if (providerName === 'lmstudio' || providerName === 'llamacpp') {
    try {
      const entries = await provider.listModels();
      if (!entries.length) {
        const base = providerName === 'lmstudio'
          ? (process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1')
          : (process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080/v1');
        console.error(`${C.red('Error:')} No models available from ${providerName} at ${base}.`);
        console.error('');
        if (providerName === 'lmstudio') {
          console.error(`  Load a model in LM Studio first, or check ${C.bold('LMSTUDIO_BASE_URL')}.`);
        } else {
          console.error(`  Start llama-server with a model: ${C.bold('llama-server -m model.gguf --port 8080')}`);
          console.error(`  Or check ${C.bold('LLAMACPP_BASE_URL')}.`);
        }
        console.error('');
        process.exit(1);
      }
      if (!model) {
        // Priority: loaded+coding > loaded+any > unloaded+coding > first
        const codingRx = [/qwen3.*coder/i, /qwen.*coder/i, /deepseek.*coder/i, /coder/i, /qwen3/i, /qwen/i];
        const firstMatch = (pool, rx) => rx.map(r => pool.find(e => r.test(e.id))).find(Boolean);
        const loaded = entries.filter(e => e.loaded === true);
        const pickedLoadedCoder = firstMatch(loaded, codingRx);
        const pickedAnyCoder = firstMatch(entries, codingRx);
        const picked = pickedLoadedCoder || loaded[0] || pickedAnyCoder || entries[0];
        model = picked.id;
        const reason = pickedLoadedCoder ? 'loaded + coding-preferred'
          : picked.loaded ? 'loaded'
          : pickedAnyCoder ? 'coding-preferred (will cold-load)'
          : 'first-available (will cold-load)';
        const tag = providerName.toUpperCase();
        console.log(`${C.cyan(`[${tag}]`)} Found ${entries.length} model(s). Using: ${C.bold(model)} ${C.cyan(`(${reason})`)}`);
        if (entries.length > 1) {
          const others = entries.filter(e => e.id !== model).slice(0, 4)
            .map(e => e.id + (e.loaded ? ' (loaded)' : ''));
          console.log(`${C.cyan(`[${tag}]`)} Other available: ${others.join(', ')}`);
        }
      }
    } catch (e) {
      console.error(`${C.red('Error:')} Cannot connect to ${providerName}: ${e.message}`);
      process.exit(1);
    }
  }

  // Fall back to default for cloud providers
  if (!model) {
    model = DEFAULT_PROXY_MODEL;
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
const isConnectWithFlags = !isBare && firstArg && firstArg.startsWith('-') && !isHelpFlag;

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);

if (isMain) {
  if (isBare || isConnectWithFlags) {
    // `anymodel` or `anymodel --port 9092` — connect to running proxy
    connectToProxy(rawArgs);
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
