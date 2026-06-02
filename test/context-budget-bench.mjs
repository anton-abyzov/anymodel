// Investigation harness (increment 0011 prep): where do the tokens go, and how slow is
// it, on a REALISTIC local request (100+ skills, 90 tools, big system) vs a small one?
// Measures TTFT (prefill cost) end-to-end against a running proxy/model.
//
//   node cli.mjs proxy lmstudio --local-fidelity lean     --port 9098   (terminal A)
//   node cli.mjs proxy lmstudio --local-fidelity balanced --port 9099   (terminal B)
//   node test/context-budget-bench.mjs
//
// Reads PORTS from argv or defaults to 9098 (lean) and 9099 (balanced).

import http from 'node:http';

const HEADER = 'The following skills are available for use with the Skill tool:';

// 100 realistic-ish skills (names + ~180-char descriptions like the real catalog).
const SKILLS = Array.from({ length: 100 }, (_, i) => {
  const ns = i % 3 === 0 ? 'sw:' : i % 5 === 0 ? 'anthropic-skills:' : '';
  const name = `${ns}skill-${String(i).padStart(3, '0')}`;
  return `- ${name}: A reasonably detailed skill description number ${i} that explains what it does and roughly when to use it, padded to look like a real catalog entry with extra clauses and qualifiers - Use this when the user mentions topic ${i}, asks about subject ${i}, or wants to do task ${i} in their project.`;
}).join('\n');

// 90 tools with realistic schemas (~150-250 tokens raw each).
const TOOLS = Array.from({ length: 90 }, (_, i) => ({
  name: i < 6 ? ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'][i] : `Tool${i}`,
  description: `Tool number ${i}. ${'This does a thing and has a fairly verbose description. '.repeat(3)}`,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(Array.from({ length: 8 }, (_, j) => [
      `param_${j}`, { type: 'string', description: `Parameter ${j}: ${'detail '.repeat(6)}` },
    ])),
    required: ['param_0'],
  },
}));

// ~12 KB system prompt (CC behavioral boilerplate + a CLAUDE.md-style block).
const SYSTEM = 'You are Claude Code, Anthropic\'s CLI. ' + 'You help with software engineering tasks. '.repeat(40) +
  '\nContents of CLAUDE.md:\n' + '## Project rule. Do the thing carefully and follow conventions. '.repeat(80);

function bigRequest() {
  return {
    model: 'qwen/qwen3-coder-30b', max_tokens: 1, stream: true,
    system: SYSTEM,
    tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${HEADER}\n\n${SKILLS}\n</system-reminder>` }] },
      { role: 'user', content: 'Refactor the auth module and add tests.' },
    ],
  };
}

function ttft(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const t0 = process.hrtime.bigint();
    let first = null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      res.on('data', () => { if (first === null) first = process.hrtime.bigint(); });
      res.on('end', () => {
        const total = Number(process.hrtime.bigint() - t0) / 1e6;
        const ttftMs = first ? Number(first - t0) / 1e6 : total;
        resolve({ status: res.statusCode, ttftMs, totalMs: total, reqBytes: payload.length });
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

const main = async () => {
  const leanPort = parseInt(process.argv[2], 10) || 9098;
  const balPort = parseInt(process.argv[3], 10) || 9099;
  const body = bigRequest();
  console.log(`Request payload: ${(JSON.stringify(body).length / 1024).toFixed(1)} KB  (100 skills, ${TOOLS.length} tools, ${(SYSTEM.length / 1024).toFixed(1)} KB system)\n`);

  for (const [label, port] of [['lean    ', leanPort], ['balanced', balPort]]) {
    // warm once (model + prefix cache), then measure twice
    await ttft(port, body).catch(() => {});
    const runs = [];
    for (let i = 0; i < 2; i++) runs.push(await ttft(port, body));
    const ttftAvg = (runs.reduce((s, r) => s + r.ttftMs, 0) / runs.length).toFixed(0);
    console.log(`${label}  port=${port}  status=${runs[0].status}  reqSent=${(runs[0].reqBytes / 1024).toFixed(1)}KB  TTFT(warm avg)=${ttftAvg}ms`);
  }
  console.log('\nNow inspect each proxy log for the token breakdown:');
  console.log('  grep -aE "FIDELITY|Tool optimization|Condensed system|Condensed messages|PREFIX" /tmp/anymodel-*.log');
};

main();
