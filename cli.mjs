#!/usr/bin/env node

// AnyModel CLI — optional API compatibility adapter
//
// Usage:
//   npx anymodel                              # show usage
//   npx anymodel claude                       # run Claude Code directly
//   npx anymodel proxy                        # start proxy (requires OPENROUTER_API_KEY)
//   npx anymodel gpt                          # connect to running proxy with GPT-4o
//   npx anymodel gemini                       # connect to running proxy with Gemini
//   npx anymodel proxy ollama                 # start proxy with Ollama

import { spawn, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createProxy, loadEnv } from './proxy.mjs';
import { buildSkillBridge } from './providers/skill-bridge.mjs';
import { MODEL_PRESETS, preflightOpenRouterModel, runCatalogCommand } from './catalog/openrouter.mjs';

const PROVIDERS = ['openrouter', 'ollama', 'openai', 'lmstudio', 'llamacpp'];
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', 'llamacpp'];

// Legacy preset IDs are preserved in catalog/openrouter.mjs and checked live.

// Free-tier detection — trust OpenRouter's `:free` suffix convention (documented,
// stable) instead of a hardcoded allowlist that goes stale every quarter as the
// free tier churns. `openrouter/free` is the single auto-router special case.
//
// This is the authoritative function. `createProxy()` in proxy.mjs uses the same
// check internally when `freeOnly` mode is active.
export function isFreeTierModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  if (modelId === 'openrouter/free') return true;
  return modelId.endsWith(':free');
}

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
  const opts = { provider: 'auto', port: 9090, host: null, model: null, help: false, freeOnly: false, token: null, rpm: 60, passthrough: [], fullMcp: false, localFidelity: null, localAgentic: false };

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
    } else if (arg === '--host') {
      // P1.7: opt in to LAN exposure. Default (unset) binds loopback 127.0.0.1.
      opts.host = argv[++i] || null;
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
    } else if (arg === '--local-agentic') {
      // 0013/US-006: preset for agentic local coding — keep the Skill tool (--full-mcp),
      // balanced skill-fidelity, and agentic env defaults (see applyLocalAgenticEnv).
      opts.localAgentic = true;
      opts.fullMcp = true;
      if (!opts.localFidelity) opts.localFidelity = 'balanced';
    } else if (arg === '--local-fidelity' || arg.startsWith('--local-fidelity=')) {
      // Local skill-fidelity tier: lean | balanced | full (default balanced). 0010.
      const v = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      opts.localFidelity = (v || '').toLowerCase();
    } else if (!arg.startsWith('-') && Object.hasOwn(MODEL_PRESETS, arg) && !opts.model) {
      opts.model = MODEL_PRESETS[arg];
    }
  }

  return opts;
}

// 0013/US-006: apply the agentic-local env defaults WITHOUT overriding anything the user
// set explicitly. No-op unless opts.localAgentic — so default behavior is unchanged.
export function applyLocalAgenticEnv(env, opts = {}) {
  if (!opts || !opts.localAgentic) return env;
  if (env.LOCAL_REFUSAL_RETRY == null) env.LOCAL_REFUSAL_RETRY = 'on';
  if (env.LOCAL_NUM_CTX == null) env.LOCAL_NUM_CTX = '65536';
  if (env.LOCAL_FIDELITY == null) env.LOCAL_FIDELITY = opts.localFidelity || 'balanced';
  return env;
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

function printQuickUsage() { printHelp(); }

function printHelp() {
  console.log(`
${C.magenta('AnyModel')} — optional API compatibility adapter

Use your maintained native coding agent directly when its provider already works.
SpecWeave Studio keeps native frontier sessions, plans and approvals; it does not
require AnyModel. An API model listing is not native subscription entitlement.

${C.bold('Discover hosted models (public catalog; no API key or inference):')}
  anymodel models [--search text] [--free] [--tools] [--json]
  anymodel check <model-id|preset> [--free] [--tools] [--json]

${C.bold('Only when you need an adapter:')}
  anymodel proxy openrouter --model <explicit-model-id>
  anymodel proxy openai --model <explicit-model-id>
  anymodel [--port 9090] [--token <proxy-token>] -- <client args>
  anymodel claude                     Run your installed client directly

${C.bold('Presets are legacy aliases, never automatic upgrades:')}
${Object.entries(MODEL_PRESETS).map(([alias, id]) => `  ${alias.padEnd(10)} ${id}`).join('\n')}
OpenRouter startup verifies the exact ID against its live public catalog.
Missing aliases fail; former free models are never replaced with paid models.
Use anymodel models --free for currently listed zero-priced entries.

${C.bold('Proxy options:')}
  --model, -m     Explicit model ID
  --port, -p      Port (default: 9090)
  --host         Bind address (default: 127.0.0.1); LAN needs --token
  --token, -t    Proxy access token (client and server must match)
  --free-only    Require a free-tier model; catalog pricing checked on startup
  --rpm          Request limit per minute (default: 60)
  --help, -h     Show help
  --version, -v  Show installed package version

${C.bold('Client and provider configuration:')}
  Install and maintain Claude Code separately, or set ANYMODEL_CLIENT to an
  explicit client path you are authorized to use. No bundled client is selected.
  OPENROUTER_API_KEY   OpenRouter API billing, separate from subscriptions
  OPENROUTER_MODEL     Explicit default model ID
  OPENAI_API_KEY       OpenAI-compatible provider API key
  OPENAI_BASE_URL      OpenAI-compatible endpoint
  ANYMODEL_TOKEN      Token used when connecting to your proxy
  PROXY_PORT          Proxy port

Existing local providers remain explicit options: ollama, lmstudio, llamacpp.
Their legacy --full-mcp, --local-fidelity and --local-agentic settings remain.
No local model is contacted by models/check. See LOCAL_SETUP.md for legacy setup.

Docs and 2.0 migration: https://anymodel.dev
`);
}

// ── Maintained native client, or an explicit user-owned client ──────────
export function findClient({ env = process.env, exists = existsSync, locateNative } = {}) {
  const explicit = env.ANYMODEL_CLIENT;
  if (explicit) {
    if (!exists(explicit)) throw new Error('ANYMODEL_CLIENT does not exist. Set an explicit client path you are authorized to use, or unset it to use installed Claude Code.');
    return /\.[cm]?js$/i.test(explicit)
      ? { cmd: process.execPath, args: [explicit], label: 'explicit user-supplied client' }
      : { cmd: explicit, args: [], label: 'explicit user-supplied client' };
  }
  try {
    const native = locateNative ? locateNative() : execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    if (native && exists(native)) return { cmd: native, args: [], label: 'installed Claude Code' };
  } catch {}
  return null;
}

export function proxyClientEnvironment(port, model, token, base = process.env) {
  return {
    ...base,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: token || 'anymodel-proxy',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
    ...(model ? { ANTHROPIC_MODEL: model, ANYMODEL_MODEL: model } : {}),
  };
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
// ── Universal skill bridge ───────────────────────────
// Discover foreign-ecosystem skills (.agents / .codex / .gemini / .agent) — all of
// which use the same open SKILL.md standard — and symlink them into a per-session temp
// `.claude/skills` shadow passed to the client via `--add-dir`, so the client's native
// SKILL.md loader picks them up. Best-effort: never blocks launch. Returns { args, cleanup }.
export function setupSkillBridge() {
  try {
    const cwd = process.cwd();
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const { discovered, plan, bridge } = buildSkillBridge({ cwd, homeDir, env: process.env });
    if (bridge && bridge.bridgeDir && bridge.linked.length) {
      console.log(`${C.green('[anymodel]')} Bridged ${bridge.linked.length} skill(s) from .agents/.codex/.gemini: ${C.cyan(bridge.linked.join(', '))}`);
      if (plan.shadowed.length) {
        console.log(`${C.yellow('[anymodel]')} ${plan.shadowed.length} foreign skill(s) shadowed by name conflict`);
      }
      if (bridge.skipped && bridge.skipped.length) {
        console.log(`${C.yellow('[anymodel]')} ${bridge.skipped.length} skill(s) could not be linked (${bridge.skipped.map(s => s.code).join(', ')})`);
      }
      const dir = bridge.bridgeDir;
      return { args: ['--add-dir', dir], cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
    }
    // Found skills but linked none (e.g. Windows without symlink privilege) — say so,
    // don't pretend nothing was there.
    if (discovered.length && bridge && bridge.skipped && bridge.skipped.length) {
      console.log(`${C.yellow('[anymodel]')} ${discovered.length} foreign skill(s) found but none could be linked (${bridge.skipped.map(s => s.code).join(', ')}) — skills not loaded.`);
    }
  } catch { /* best-effort: skill discovery never blocks the client */ }
  return { args: [], cleanup: () => {} };
}

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

  const skillBridge = setupSkillBridge();
  const clientChild = spawn(client.cmd, [...client.args, ...skillBridge.args], {
    stdio: 'inherit',
    env: process.env,
  });

  clientChild.on('exit', (code, signal) => { skillBridge.cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
  clientChild.on('error', (e) => { skillBridge.cleanup(); console.error(`${C.red('Error:')} failed to launch client: ${e.message}`); process.exit(1); });
  process.on('SIGINT', () => { skillBridge.cleanup(); clientChild.kill('SIGTERM'); process.exit(0); });
  process.on('SIGTERM', () => { skillBridge.cleanup(); clientChild.kill('SIGTERM'); process.exit(0); });
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

  // Universal skill bridge — applies to every provider (cloud + local).
  const skillBridge = setupSkillBridge();
  autoArgs.push(...skillBridge.args);

  console.log(`${C.green('[anymodel]')} Starting...`);
  console.log('');

  // clientArgs: auto-injected strict-mcp-config + skill-bridge --add-dir + user passthrough
  const clientArgs = [...client.args, ...autoArgs, ...opts.passthrough];
  const clientChild = spawn(client.cmd, clientArgs, {
    stdio: 'inherit',
    env: {
      ...proxyClientEnvironment(port, modelName, opts.token || process.env.ANYMODEL_TOKEN),
    },
  });

  clientChild.on('exit', (code, signal) => { skillBridge.cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
  clientChild.on('error', (e) => { skillBridge.cleanup(); console.error(`${C.red('Error:')} failed to launch client: ${e.message}`); process.exit(1); });
  process.on('SIGINT', () => { skillBridge.cleanup(); clientChild.kill('SIGTERM'); process.exit(0); });
  process.on('SIGTERM', () => { skillBridge.cleanup(); clientChild.kill('SIGTERM'); process.exit(0); });
}

// ── Mode 3: Proxy only ──────────────────────────────
async function startProxyOnly(args) {
  loadEnv();
  const opts = parseArgs(args);

  if (opts.help) { printHelp(); process.exit(0); }

  // Local skill-fidelity tier (increment 0010) → drive the in-process proxy via env.
  const localFidelity = opts.localFidelity || (process.env.ANYMODEL_LOCAL_FIDELITY || '').toLowerCase();
  if (localFidelity) {
    if (!['lean', 'balanced', 'full'].includes(localFidelity)) {
      console.error(`${C.red('Error:')} --local-fidelity must be lean | balanced | full (got "${localFidelity}")`);
      process.exit(1);
    }
    process.env.LOCAL_FIDELITY = localFidelity;
  }

  // 0013/US-006: agentic-local preset — set env defaults + surface hook-relaxation guidance.
  if (opts.localAgentic) {
    applyLocalAgenticEnv(process.env, opts);
    console.log(`${C.green('[anymodel]')} ${C.bold('--local-agentic')}: LOCAL_REFUSAL_RETRY=on, LOCAL_NUM_CTX=${process.env.LOCAL_NUM_CTX}, LOCAL_FIDELITY=${process.env.LOCAL_FIDELITY}, full MCP (Skill tool kept)`);
    console.log(`${C.yellow('[anymodel]')} Legacy local mode does not establish coding parity. Keep project acceptance checks and permission boundaries intact.`);
  }

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

  // The OpenRouter default retains its historical free ID; never choose a paid replacement.
  if (!model && providerName === 'openai') throw new Error('An OpenAI-compatible endpoint requires an explicit --model ID.');
  if (!model) {
    model = DEFAULT_PROXY_MODEL;
    console.log(`${C.cyan('[MODEL]')} Defaulting to ${C.bold(model)}`);
  }

  if (opts.freeOnly && !isFreeTierModel(model)) {
    console.error(`${C.red('Error:')} --free-only is active but model "${model}" is not free.`);
    console.error('  Run anymodel models --free and select an explicit current :free model.');
    process.exit(1);
  }

  if (opts.token) {
    console.log(`${C.cyan('[AUTH]')} Token authentication enabled`);
  }

  if (providerName === 'openrouter') {
    const available = await preflightOpenRouterModel(model, { freeOnly: opts.freeOnly });
    console.log(`${C.green('[CATALOG]')} ${available.id} is listed (${available.checkedAt}). API availability is not native subscription entitlement.`);
  }

  createProxy(provider, { port, host: opts.host, model, freeOnly: opts.freeOnly, token: opts.token, rpm: opts.rpm });
}

function reportCommandError(error) {
  console.error(`${C.red('Error:')} ${error.message}`);
  process.exitCode = error.code === 'model_unavailable' || error.code === 'free_model_unverified' ? 2 : 1;
}

// ── Entry point ──────────────────────────────────────
const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];

// Detect mode
const isHelpFlag = rawArgs.includes('--help') || rawArgs.includes('-h');
const isProxyMode = firstArg === 'proxy' || PROVIDERS.includes(firstArg) || firstArg === 'remote';
const isClientMode = firstArg === 'claude';
const isPreset = firstArg && Object.hasOwn(MODEL_PRESETS, firstArg);
const isBare = rawArgs.length === 0;
const isConnectWithFlags = !isBare && firstArg && firstArg.startsWith('-') && !isHelpFlag;

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.mjs') ||
  process.argv[1].endsWith('\\cli.mjs') ||
  process.argv[1].endsWith('/anymodel')
);

if (isMain) {
  if (firstArg === '--version' || firstArg === '-v') {
    console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
  } else if (firstArg === 'models' || firstArg === 'check') {
    if (isHelpFlag) printHelp();
    else runCatalogCommand(firstArg, rawArgs.slice(1)).catch(reportCommandError);
  } else if (isBare || isConnectWithFlags) {
    // `anymodel` or `anymodel --port 9092` — connect to running proxy
    connectToProxy(rawArgs).catch(reportCommandError);
  } else if (isHelpFlag && !isProxyMode) {
    // `anymodel --help` — show full help (but let proxy mode handle its own --help)
    printHelp();
  } else if (isClientMode) {
    // `anymodel claude` — launch Claude Code directly (no proxy)
    try { launchClaude(); } catch (error) { reportCommandError(error); }
  } else if (isProxyMode) {
    // `anymodel proxy [preset|provider] ...` — start proxy (presets resolved in parseArgs)
    const proxyArgs = firstArg === 'proxy' ? rawArgs.slice(1) : rawArgs;
    startProxyOnly(proxyArgs).catch(reportCommandError);
  } else if (isPreset) {
    // `anymodel gpt` — treated as `anymodel proxy gpt` (start proxy with preset)
    startProxyOnly(rawArgs).catch(reportCommandError);
  } else {
    // Unknown command — show quick usage
    console.error(`${C.red('Error:')} Unknown command "${firstArg}"`);
    console.error('');
    printQuickUsage();
    process.exit(1);
  }
}
