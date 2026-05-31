// Live end-to-end baseline: Claude Code Anthropic protocol → AnyModel proxy →
// LM Studio (qwen/qwen3-coder-30b). NOT a node:test file (won't run under
// `npm test`) — it starts the real proxy and process.exit()s, per the documented
// event-loop trap. Run directly:  node test/live-baseline.mjs
//
// Requires LM Studio live on :1234 with qwen/qwen3-coder-30b loaded.
// Starts the proxy on :9099 and kills ONLY the PID it started.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.BASELINE_PORT) || 9099;
const MODEL = process.env.BASELINE_MODEL || 'qwen/qwen3-coder-30b';
const BASE = `http://localhost:${PORT}`;
const HEADERS = { 'content-type': 'application/json', 'x-api-key': 'anymodel-proxy', 'anthropic-version': '2023-06-01' };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function post(body) {
  const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  return res;
}

async function waitHealth(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) { const j = await r.json(); if (j.status === 'ok') return true; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

const RUN_BASH = {
  name: 'run_bash', description: 'Run a bash command and return stdout.',
  input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
};

async function main() {
  const env = { ...process.env, LMSTUDIO_BASE_URL: 'http://localhost:1234/v1' };
  delete env.OPENROUTER_API_KEY; delete env.OPENAI_API_KEY;

  const child = spawn('node', [join(ROOT, 'cli.mjs'), 'proxy', 'lmstudio', '--model', MODEL, '--port', String(PORT)],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let proxyLog = '';
  child.stdout.on('data', d => { proxyLog += d; });
  child.stderr.on('data', d => { proxyLog += d; });

  const cleanup = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('exit', cleanup);

  try {
    if (!await waitHealth()) {
      record('proxy starts + /health ok', false, 'health never became ok');
      console.log('--- proxy log ---\n' + proxyLog.slice(-800));
      cleanup(); process.exit(1);
    }
    record('proxy starts + /health ok', true, `:${PORT}`);

    // (a) Plain chat
    {
      const r = await post({ model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly: BASELINE_OK and nothing else.' }] });
      const j = await r.json();
      const text = j.content?.find(b => b.type === 'text')?.text ?? '';
      record('(a) plain chat', r.status === 200 && j.type === 'message' && text.length > 0 && !!j.stop_reason,
        `status=${r.status} stop=${j.stop_reason} text="${text.slice(0, 40)}"`);
    }

    // (b) Tool-call elicitation
    {
      const r = await post({ model: MODEL, max_tokens: 256, tools: [RUN_BASH],
        messages: [{ role: 'user', content: 'Use the run_bash tool to run: echo hello. Call the tool, do not answer in text.' }] });
      const j = await r.json();
      const tu = j.content?.find(b => b.type === 'tool_use');
      const ok = r.status === 200 && tu && tu.name === 'run_bash' && tu.input && typeof tu.input === 'object' && j.stop_reason === 'tool_use';
      record('(b) tool-call elicitation', !!ok, `stop=${j.stop_reason} tool=${tu?.name} input=${JSON.stringify(tu?.input)}`);
    }

    // (c) Streaming — assert EXACTLY ONE message_stop (P0.1 flush idempotency)
    {
      const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: HEADERS,
        body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Count to three, comma-separated. Be terse.' }] }) });
      const sse = await res.text();
      const stops = (sse.match(/event: message_stop/g) || []).length;
      const hasStart = sse.includes('event: message_start');
      const hasDelta = sse.includes('event: message_delta');
      const ok = res.status === 200 && hasStart && hasDelta && stops === 1;
      record('(c) streaming — exactly one message_stop', ok, `message_stop=${stops} start=${hasStart} delta=${hasDelta}`);
    }

    // (e) Streaming WITH tools — structured tool call must survive the local text
    // buffering path (0009) and still produce exactly one message_stop.
    {
      const res = await fetch(`${BASE}/v1/messages`, { method: 'POST', headers: HEADERS,
        body: JSON.stringify({ model: MODEL, max_tokens: 256, stream: true, tools: [RUN_BASH],
          messages: [{ role: 'user', content: 'Use the run_bash tool to run: echo hi. Call the tool, do not answer in text.' }] }) });
      const sse = await res.text();
      const stops = (sse.match(/event: message_stop/g) || []).length;
      const hasTool = sse.includes('"tool_use"') || sse.includes('input_json_delta');
      const ok = res.status === 200 && stops === 1 && hasTool;
      record('(e) streaming + tools — tool_use survives, one message_stop', ok, `message_stop=${stops} tool=${hasTool}`);
    }

    // (d) Multi-turn tool_result round-trip
    {
      const r1 = await post({ model: MODEL, max_tokens: 256, tools: [RUN_BASH],
        messages: [{ role: 'user', content: 'Use run_bash to run: echo 42. Call the tool.' }] });
      const j1 = await r1.json();
      const tu = j1.content?.find(b => b.type === 'tool_use');
      if (!tu) { record('(d) multi-turn tool_result', false, 'turn-1 produced no tool_use'); }
      else {
        const r2 = await post({ model: MODEL, max_tokens: 128, tools: [RUN_BASH], messages: [
          { role: 'user', content: 'Use run_bash to run: echo 42. Call the tool.' },
          { role: 'assistant', content: [tu] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '42' }] },
        ] });
        const j2 = await r2.json();
        const text = j2.content?.find(b => b.type === 'text')?.text ?? '';
        record('(d) multi-turn tool_result', r2.status === 200 && text.includes('42'),
          `status=${r2.status} text="${text.slice(0, 60)}"`);
      }
    }
  } catch (e) {
    record('baseline run', false, e.message);
  }

  cleanup();
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
}

main();
