import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs, shouldAutoSuppressMcp, resolveProjectMcpPath, formatLocalProviderBanner } from '../cli.mjs';

// Helper to strip ANSI color codes for plain-text assertions
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('parseArgs', () => {
  it('detects openrouter as provider from positional arg', () => {
    const opts = parseArgs(['openrouter']);
    assert.equal(opts.provider, 'openrouter');
  });

  it('detects ollama as provider from positional arg', () => {
    const opts = parseArgs(['ollama']);
    assert.equal(opts.provider, 'ollama');
  });

  it('defaults provider to auto when no positional arg', () => {
    const opts = parseArgs([]);
    assert.equal(opts.provider, 'auto');
  });

  it('parses --model flag', () => {
    const opts = parseArgs(['--model', 'google/gemini-2.5-flash']);
    assert.equal(opts.model, 'google/gemini-2.5-flash');
  });

  it('parses --port flag', () => {
    const opts = parseArgs(['--port', '8080']);
    assert.equal(opts.port, 8080);
  });

  it('uses default port 9090', () => {
    const opts = parseArgs([]);
    assert.equal(opts.port, 9090);
  });

  it('parses provider with --model and --port', () => {
    const opts = parseArgs(['ollama', '--model', 'llama3', '--port', '3000']);
    assert.equal(opts.provider, 'ollama');
    assert.equal(opts.model, 'llama3');
    assert.equal(opts.port, 3000);
  });

  it('sets help flag with --help', () => {
    const opts = parseArgs(['--help']);
    assert.equal(opts.help, true);
  });

  it('ignores unknown flags', () => {
    const opts = parseArgs(['--unknown', 'value']);
    assert.equal(opts.provider, 'auto');
  });

  it('detects lmstudio as provider from positional arg', () => {
    const opts = parseArgs(['lmstudio']);
    assert.equal(opts.provider, 'lmstudio');
  });

  it('detects llamacpp as provider from positional arg', () => {
    const opts = parseArgs(['llamacpp']);
    assert.equal(opts.provider, 'llamacpp');
  });

  it('sets provider to lmstudio with --lmstudio flag', () => {
    const opts = parseArgs(['--lmstudio']);
    assert.equal(opts.provider, 'lmstudio');
  });

  it('sets provider to llamacpp with --llamacpp flag', () => {
    const opts = parseArgs(['--llamacpp']);
    assert.equal(opts.provider, 'llamacpp');
  });

  it('parses lmstudio with --model and --port', () => {
    const opts = parseArgs(['lmstudio', '--model', 'qwen2.5-coder-7b', '--port', '9100']);
    assert.equal(opts.provider, 'lmstudio');
    assert.equal(opts.model, 'qwen2.5-coder-7b');
    assert.equal(opts.port, 9100);
  });

  it('captures everything after `--` as passthrough args', () => {
    const opts = parseArgs(['lmstudio', '--', '--bare', '--mcp-config', './empty.json']);
    assert.equal(opts.provider, 'lmstudio');
    assert.deepEqual(opts.passthrough, ['--bare', '--mcp-config', './empty.json']);
  });

  it('passthrough is empty when no `--` separator', () => {
    const opts = parseArgs(['lmstudio']);
    assert.deepEqual(opts.passthrough, []);
  });

  it('stops parsing AnyModel flags after `--`', () => {
    const opts = parseArgs(['--port', '8080', '--', '--port', '9999']);
    assert.equal(opts.port, 8080);
    assert.deepEqual(opts.passthrough, ['--port', '9999']);
  });

  it('parses --full-mcp opt-out flag', () => {
    const opts = parseArgs(['--full-mcp']);
    assert.equal(opts.fullMcp, true);
  });

  it('fullMcp defaults to false', () => {
    const opts = parseArgs([]);
    assert.equal(opts.fullMcp, false);
  });
});

describe('shouldAutoSuppressMcp', () => {
  const baseOpts = () => ({ fullMcp: false, passthrough: [] });
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.ANYMODEL_FULL_MCP; delete process.env.ANYMODEL_FULL_MCP; });
  afterEach(() => { if (savedEnv !== undefined) process.env.ANYMODEL_FULL_MCP = savedEnv; });

  it('returns true for local providers without opt-out', () => {
    assert.equal(shouldAutoSuppressMcp('lmstudio', baseOpts()), true);
    assert.equal(shouldAutoSuppressMcp('llamacpp', baseOpts()), true);
    assert.equal(shouldAutoSuppressMcp('ollama', baseOpts()), true);
  });

  it('returns false for remote providers (openrouter, openai)', () => {
    assert.equal(shouldAutoSuppressMcp('openrouter', baseOpts()), false);
    assert.equal(shouldAutoSuppressMcp('openai', baseOpts()), false);
  });

  it('returns false when --full-mcp passed', () => {
    assert.equal(shouldAutoSuppressMcp('lmstudio', { ...baseOpts(), fullMcp: true }), false);
  });

  it('returns false when ANYMODEL_FULL_MCP=1 env set', () => {
    process.env.ANYMODEL_FULL_MCP = '1';
    assert.equal(shouldAutoSuppressMcp('lmstudio', baseOpts()), false);
  });

  it('returns false when user explicitly passed --mcp-config', () => {
    const opts = { ...baseOpts(), passthrough: ['--mcp-config', './my.json'] };
    assert.equal(shouldAutoSuppressMcp('lmstudio', opts), false);
  });

  it('returns false when user explicitly passed --strict-mcp-config', () => {
    const opts = { ...baseOpts(), passthrough: ['--strict-mcp-config'] };
    assert.equal(shouldAutoSuppressMcp('lmstudio', opts), false);
  });

  it('returns false for unknown / missing provider', () => {
    assert.equal(shouldAutoSuppressMcp('', baseOpts()), false);
    assert.equal(shouldAutoSuppressMcp(undefined, baseOpts()), false);
  });
});

describe('resolveProjectMcpPath', () => {
  it('returns a valid file path that exists', () => {
    const p = resolveProjectMcpPath();
    assert.ok(p && typeof p === 'string');
    assert.ok(existsSync(p), `path should exist: ${p}`);
  });

  it('returned file contains valid JSON with mcpServers key', () => {
    const p = resolveProjectMcpPath();
    const content = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(content.mcpServers !== undefined, 'must have mcpServers key');
    if (p.includes('empty-mcp')) {
      assert.deepEqual(content, { mcpServers: {} });
    }
  });
});

describe('formatLocalProviderBanner', () => {
  const base = { providerName: 'lmstudio', mcpPath: '/tmp/anymodel/empty-mcp.json' };

  it('fresh project (no .claude dir) prints the full onboarding guide', () => {
    const lines = formatLocalProviderBanner({
      ...base,
      hasProjectMcp: false,
      hasProjectClaudeDir: false,
      hasProjectSkills: false,
      hasProjectAgents: false,
    });
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('No project config detected'), 'must tell user to create project config');
    assert.ok(plain.includes('./.claude/.mcp.json'), 'must mention MCP path');
    assert.ok(plain.includes('./.claude/skills/'), 'must mention skills path');
    assert.ok(plain.includes('./.claude/agents/'), 'must mention agents path');
    assert.ok(plain.includes('./CLAUDE.md'), 'must mention CLAUDE.md');
    assert.ok(plain.includes('--full-mcp'), 'must mention opt-out flag');
    assert.ok(plain.includes('LOCAL_SETUP.md'), 'must link to docs');
  });

  it('project with MCP + skills + agents prints compact banner', () => {
    const lines = formatLocalProviderBanner({
      providerName: 'lmstudio',
      mcpPath: '/Users/foo/myproject/.claude/.mcp.json',
      hasProjectMcp: true,
      hasProjectClaudeDir: true,
      hasProjectSkills: true,
      hasProjectAgents: true,
    });
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('global MCP suppressed'), 'must say global MCP is off');
    assert.ok(plain.includes('using project MCP'), 'must say project MCP is on');
    assert.ok(plain.includes('skills + agents'), 'must mention both skills and agents load');
    assert.ok(plain.includes('--full-mcp'), 'must mention opt-out');
    // No verbose guidance since user already has config
    assert.ok(!plain.includes('No project config detected'), 'should not show fresh-project guidance');
  });

  it('project with .claude/ but no .mcp.json shows a tip', () => {
    const lines = formatLocalProviderBanner({
      ...base,
      hasProjectMcp: false,
      hasProjectClaudeDir: true,
      hasProjectSkills: true,
      hasProjectAgents: false,
    });
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('no MCP servers this session'), 'must say no MCP');
    assert.ok(plain.includes('Project skills from'), 'must mention skills load');
    assert.ok(plain.includes('Tip:'), 'must show MCP tip');
    assert.ok(plain.includes('.mcp.json'), 'tip must suggest creating MCP file');
    assert.ok(plain.includes('server-filesystem'), 'tip must give a copy-paste example');
  });

  it('project with .claude/ and only agents (no skills, no .mcp.json)', () => {
    const lines = formatLocalProviderBanner({
      ...base,
      hasProjectMcp: false,
      hasProjectClaudeDir: true,
      hasProjectSkills: false,
      hasProjectAgents: true,
    });
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('Project agents from'), 'should mention agents, not skills');
    assert.ok(!plain.includes('Project skills from'), 'should not mention skills');
  });

  it('banner lines are all strings (no undefined/null leaking)', () => {
    const lines = formatLocalProviderBanner({
      ...base,
      hasProjectMcp: false,
      hasProjectClaudeDir: false,
      hasProjectSkills: false,
      hasProjectAgents: false,
    });
    for (const line of lines) {
      assert.equal(typeof line, 'string', 'each banner line must be a string');
    }
    assert.ok(lines.length > 0, 'banner must have at least one line');
  });

  it('integration: fresh project with ollama provider still shows guidance', () => {
    const lines = formatLocalProviderBanner({
      providerName: 'ollama',
      mcpPath: '/tmp/anymodel/empty-mcp.json',
      hasProjectMcp: false,
      hasProjectClaudeDir: false,
      hasProjectSkills: false,
      hasProjectAgents: false,
    });
    const plain = lines.map(stripAnsi).join('\n');
    assert.ok(plain.includes('ollama'), 'must include the provider name');
    assert.ok(plain.includes('No project config detected'), 'same guidance regardless of local provider');
  });
});
