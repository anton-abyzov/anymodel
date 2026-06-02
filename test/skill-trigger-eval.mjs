// Live capability eval for increment 0010 (AC-US6-01). NOT a unit test — it requires a
// running anymodel proxy in front of a real local model (e.g. LM Studio qwen3-coder-30b).
//
//   Terminal 1:  LOCAL_FIDELITY=balanced node cli.mjs proxy lmstudio --local-fidelity balanced --port 9099
//   Terminal 2:  PROXY_URL=http://127.0.0.1:9099 node test/skill-trigger-eval.mjs
//
// Sends a set of skill-matching prompts through the proxy (each carrying a realistic
// <system-reminder> skill catalog) and measures how often the model calls the Skill
// tool with a valid skill name. Gate: >= 60% (was ~0% before re-injection). Exit 1 if below.

import http from 'node:http';

const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:9099';
const HEADER = 'The following skills are available for use with the Skill tool:';

const CATALOG = [
  '- sw:do: Execute increment tasks following spec and plan - when implementing',
  '- sw:increment: Plan and create a new feature increment with specs - when starting new work',
  '- sw:done: Close an increment with validation gates - when finishing',
  '- verify: Verify that a code change actually works by running the app - when validating',
  '- simplify: Clean up changed code for reuse and readability - when refactoring',
  '- code-review: Review the current diff for correctness bugs - when reviewing changes',
  '- security-review: Audit code for security vulnerabilities - when checking security',
  '- deep-research: Fan-out web research with cited synthesis - when researching a topic',
  '- pptx: Create or edit PowerPoint slide decks - when building a presentation',
  '- nanobanana: Generate and edit images with Gemini - when creating images',
  '- tax-filing: Prepare corporate and personal tax returns - when filing taxes',
  '- resume-tuner: Tailor a resume for a specific job - when applying to a job',
  '- obsidian-brain: Ingest and organize an Obsidian vault - when managing notes',
].join('\n');

const CASES = [
  { q: "Let's start implementing the tasks for this increment.", want: 'sw:do' },
  { q: 'Plan a brand-new feature increment with full specs and acceptance criteria.', want: 'sw:increment' },
  { q: 'Verify that my change actually works by running the app end to end.', want: 'verify' },
  { q: 'Clean up and simplify the code I just changed.', want: 'simplify' },
  { q: 'Review this diff for correctness bugs before I merge.', want: 'code-review' },
  { q: 'Do a security review of this authentication code.', want: 'security-review' },
  { q: 'Research the current state of MLX vs GGUF inference with sources.', want: 'deep-research' },
  { q: 'Build me a slide deck / PowerPoint presentation about our launch.', want: 'pptx' },
  { q: 'Generate an image of a violet diamond logo on a dark background.', want: 'nanobanana' },
  { q: 'Help me prepare my corporate tax filing and P&L for this year.', want: 'tax-filing' },
  { q: 'Tailor my resume for this senior staff engineer job description.', want: 'resume-tuner' },
  { q: 'Ingest and organize the notes sitting in my Obsidian inbox.', want: 'obsidian-brain' },
];

const SKILL_TOOL = {
  name: 'Skill',
  description: 'Execute a skill within the conversation. When a request matches an available skill, calling Skill with that skill name is a BLOCKING REQUIREMENT — call it FIRST.',
  input_schema: { type: 'object', properties: { skill: { type: 'string' }, args: { type: 'string' } }, required: ['skill'] },
};
const OTHER_TOOLS = ['Read', 'Write', 'Bash'].map(name => ({
  name, description: `${name} tool`, input_schema: { type: 'object', properties: { x: { type: 'string' } } },
}));

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL('/v1/messages', PROXY_URL);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function skillCallName(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && b.name === 'Skill') {
      return (b.input && (b.input.skill || b.input.args)) || '(no-name)';
    }
  }
  return null;
}

// Extract the skill name up to the FIRST ": " so namespaced names (sw:do) survive.
const validNames = new Set(CATALOG.split('\n').map(l => (l.match(/^-\s+([\w:.-]+?):\s/) || [])[1]).filter(Boolean));

const main = async () => {
  let called = 0, matched = 0;
  for (const c of CASES) {
    const body = {
      model: 'qwen/qwen3-coder-30b', max_tokens: 300,
      system: 'You are Claude Code, an agentic coding assistant.',
      tools: [SKILL_TOOL, ...OTHER_TOOLS],
      messages: [
        { role: 'user', content: [{ type: 'text', text: `<system-reminder>\n${HEADER}\n\n${CATALOG}\n</system-reminder>` }] },
        { role: 'user', content: c.q },
      ],
    };
    let name = null;
    try { name = skillCallName(await post(body)); } catch (e) { name = `ERR:${e.message}`; }
    const valid = name && validNames.has(name);
    const exact = name === c.want;
    if (name && !name.startsWith('ERR')) called++;
    if (valid) matched++;
    console.log(`${valid ? '✓' : '✗'} want=${c.want.padEnd(16)} got=${String(name).padEnd(18)} ${exact ? '(exact)' : valid ? '(valid)' : ''}`);
  }
  const rate = Math.round((matched / CASES.length) * 100);
  console.log(`\nSkill called with a valid skill name on ${matched}/${CASES.length} (${rate}%). Any Skill call: ${called}/${CASES.length}.`);
  console.log(rate >= 60 ? 'PASS (AC-US6-01 >= 60%)' : 'FAIL (AC-US6-01 < 60%)');
  process.exit(rate >= 60 ? 0 : 1);
};

main();
