// Integration tests for the local skill-fidelity re-injection (increment 0010).
// Spins up the real proxy in front of stub upstreams and asserts the forwarded request
// carries the re-injected skill catalog (balanced), reverts cleanly (lean), keeps the
// Skill tool under budget pressure, and stays deterministic across turns.
//
// Run: node --test test/proxy-fidelity.test.mjs

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../proxy.mjs';
import ollamaProvider from '../providers/ollama.mjs';
import lmstudioProvider from '../providers/lmstudio.mjs';
import { optimizeTools } from '../providers/tool-compressor.mjs';
import { getOrStore, computePrefixHash, resetCache } from '../providers/prefix-cache.mjs';
import { toolCache } from '../providers/ollama-tools.mjs';

const HEADER = 'The following skills are available for use with the Skill tool:';

function postJSON(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function startStub(kind) {
  return new Promise(resolve => {
    const captured = { lastBody: null };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { captured.lastBody = JSON.parse(Buffer.concat(chunks).toString()); } catch { captured.lastBody = null; }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (kind === 'ollama') {
          res.end(JSON.stringify({ model: 'stub', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }));
        } else {
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'stub', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

function pointAt(provider, stubPort, path) {
  return {
    ...provider,
    buildRequest: (_url, payload) => ({
      hostname: '127.0.0.1', port: stubPort, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }),
  };
}

const TOOLS = ['Skill', 'ToolSearch', 'Read', 'Write'].map(name => ({
  name, description: `${name} tool`,
  input_schema: { type: 'object', properties: { x: { type: 'string' } } },
}));

// A short system prompt (< 4000 chars) so we exercise the ≤cap else-branch (AC-US5-01),
// plus a first user message carrying the skill catalog and a second "real" query.
function request(model) {
  return {
    model, max_tokens: 50, system: 'You are Claude Code.',
    tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${HEADER}\n\n- sw:do: Execute increment tasks - when implementing\n- verify: Verify that a change works - When validating\n</system-reminder>` }] },
      { role: 'user', content: 'Please verify my change works' },
    ],
  };
}

describe('local skill-fidelity (proxy integration)', () => {
  const saved = {};
  let ollama, lmstudio, proxyO, proxyL, portO, portL;

  before(async () => {
    for (const k of ['LOCAL_FIDELITY', 'LOCAL_SKILL_INDEX', 'OLLAMA_TOOLS', 'LOCAL_MAX_SYSTEM_PCT']) saved[k] = process.env[k];
    process.env.OLLAMA_TOOLS = 'auto';
    ollama = await startStub('ollama');
    lmstudio = await startStub('lmstudio');
    proxyO = createProxy(pointAt(ollamaProvider, ollama.port, '/api/chat'), { port: 0, model: 'qwen3-coder:stub' });
    proxyL = createProxy(pointAt(lmstudioProvider, lmstudio.port, '/v1/chat/completions'), { port: 0, model: 'qwen/qwen3-coder-30b' });
    await Promise.all([proxyO, proxyL].map(p => new Promise(r => p.listening ? r() : p.on('listening', r))));
    portO = proxyO.address().port;
    portL = proxyL.address().port;
  });

  after(() => {
    proxyO?.close(); proxyL?.close(); ollama?.server.close(); lmstudio?.server.close();
    for (const k of Object.keys(saved)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });

  beforeEach(() => { toolCache.clear(); resetCache(); ollama.captured.lastBody = null; lmstudio.captured.lastBody = null; });

  it('balanced re-injects the skill catalog into the forwarded request (AC-US1-01) and strips the raw reminder (AC-US1-04)', async () => {
    process.env.LOCAL_FIDELITY = 'balanced';
    const res = await postJSON(portO, '/v1/messages', request('qwen3-coder:stub'));
    assert.equal(res.status, 200);
    const fwd = JSON.stringify(ollama.captured.lastBody);
    assert.ok(fwd.includes('Available skills (call the Skill tool when a request matches'), 'skill index injected');
    assert.ok(fwd.includes('BLOCKING REQUIREMENT'), 'blocking rule present');
    assert.ok(!fwd.includes('<system-reminder>'), 'raw system-reminder stripped from messages');
    const skill = (ollama.captured.lastBody.tools || []).find(t => t?.function?.name === 'Skill');
    assert.ok(skill, 'Skill tool retained in forwarded tools (AC-US1-03)');
  });

  it('lean is a no-op — no skill block injected (AC-US2-01)', async () => {
    process.env.LOCAL_FIDELITY = 'lean';
    const res = await postJSON(portO, '/v1/messages', request('qwen3-coder:stub'));
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(ollama.captured.lastBody).includes('Available skills'), 'no skill block in lean');
  });

  it('LOCAL_SKILL_INDEX=off skips the skill index entirely (AC-US2-02)', async () => {
    process.env.LOCAL_FIDELITY = 'balanced';
    process.env.LOCAL_SKILL_INDEX = 'off';
    const res = await postJSON(portO, '/v1/messages', request('qwen3-coder:stub'));
    delete process.env.LOCAL_SKILL_INDEX;
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(ollama.captured.lastBody).includes('Available skills'), 'no skill index when off');
  });

  it('forwarded request is deterministic across two identical balanced turns (AC-US3-01)', async () => {
    process.env.LOCAL_FIDELITY = 'balanced';
    resetCache();
    await postJSON(portO, '/v1/messages', request('qwen3-coder:stub'));
    const first = JSON.stringify(ollama.captured.lastBody);
    ollama.captured.lastBody = null;
    await postJSON(portO, '/v1/messages', request('qwen3-coder:stub'));
    const second = JSON.stringify(ollama.captured.lastBody);
    assert.equal(first, second, 'identical inputs → byte-identical forwarded request');
  });

  it('prefix-cache now covers the LM Studio (MLX) path without breaking it (AC-US3-02, T-007 parity)', async () => {
    process.env.LOCAL_FIDELITY = 'balanced';
    const r1 = await postJSON(portL, '/v1/messages', request('qwen/qwen3-coder-30b'));
    assert.equal(r1.status, 200, 'lmstudio request succeeds with widened prefix-cache gate');
    const fwd = JSON.stringify(lmstudio.captured.lastBody);
    assert.ok(fwd.includes('Available skills'), 'skill index injected on the lmstudio path too');
  });
});

describe('never-evict guard + prefix-cache hit (units for 0010)', () => {
  it('Skill and ToolSearch survive a tiny tool budget (AC-US1-03)', () => {
    const tools = [
      { name: 'Skill', description: 'Skill', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'ToolSearch', description: 'ToolSearch', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
      ...Array.from({ length: 90 }, (_, i) => ({
        name: `Extra${i}`, description: 'x'.repeat(200),
        input_schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`p${j}`, { type: 'string', description: 'y'.repeat(40) }])) },
      })),
    ];
    const { tools: out } = optimizeTools(tools, { numCtx: 2048, budgetPct: 0.05 });
    const names = new Set(out.map(t => t.name));
    assert.ok(names.has('Skill'), 'Skill never evicted');
    assert.ok(names.has('ToolSearch'), 'ToolSearch never evicted');
    assert.ok(out.length < tools.length, 'budget still trimmed the extras');
  });

  it('getOrStore reports hit=true on the 2nd identical request (AC-US3-02)', () => {
    resetCache();
    const sys = 'SYS\n' + 'Available skills (call the Skill tool when a request matches';
    const first = getOrStore('qwen/qwen3-coder-30b', sys, null);
    const second = getOrStore('qwen/qwen3-coder-30b', sys, null);
    assert.equal(first.hit, false, 'first store is a miss');
    assert.equal(second.hit, true, 'second identical lookup is a hit');
    assert.equal(computePrefixHash(sys, null), computePrefixHash(sys, null), 'hash stable');
  });
});
