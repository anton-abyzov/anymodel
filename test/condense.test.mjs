// US-005 (0013): plan-state-aware message-history condensing + the multi-turn
// regression gate (skill re-injection >=60% on turn-2+, plan-mode re-entry <=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { condenseMessages, isPlanTurn } from '../providers/condense.mjs';
import { buildFidelityAddition, _resetSkillCatalogCache } from '../providers/skill-catalog.mjs';

const planTurn = () => ({ role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'step 1; step 2' } }] });
const filler = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${i} ` + 'x'.repeat(400) }] });

test('US-005 (AC-US5-01) — a plan-mode turn in the droppable middle is preserved', () => {
  const msgs = [filler(0), filler(1), filler(2), filler(3), planTurn(), filler(5), filler(6), filler(7), filler(8), filler(9)];
  const { messages: out, dropped } = condenseMessages(msgs, { maxChars: 1500 });
  assert.ok(dropped > 0, 'something was dropped');
  assert.ok(out.some(isPlanTurn), 'the ExitPlanMode turn survived condensing');
});

test('US-005 (AC-US5-02) — dropped runs become a structured summary, not empty filler', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => filler(i));
  const { messages: out } = condenseMessages(msgs, { maxChars: 1500 });
  assert.ok(out.some(m => typeof m.content === 'string' && /\[Condensed \d+ earlier turns?(; tools used: [^\]]+)?\]/.test(m.content)),
    'a structured summary message is present');
  assert.ok(!out.some(m => m.content === '[Earlier conversation condensed]'), 'no empty filler');
});

test('US-005 — summary lists the tools used in dropped turns', () => {
  const toolTurn = (name) => ({ role: 'assistant', content: [{ type: 'tool_use', name, input: { x: 'y'.repeat(300) } }] });
  const msgs = [filler(0), filler(1), toolTurn('Bash'), toolTurn('Grep'), toolTurn('Read'), filler(5), filler(6), filler(7), filler(8), filler(9)];
  const { messages: out } = condenseMessages(msgs, { maxChars: 1200 });
  const summary = out.find(m => typeof m.content === 'string' && /Condensed/.test(m.content));
  assert.ok(summary, 'summary present');
  assert.ok(/Bash|Grep|Read/.test(summary.content), 'tool names captured in summary');
});

test('US-005 — under budget: messages returned unchanged', () => {
  const msgs = [filler(0), filler(1), filler(2), filler(3), filler(4)];
  const { messages: out, dropped } = condenseMessages(msgs, { maxChars: 1_000_000 });
  assert.equal(dropped, 0);
  assert.equal(out, msgs, 'same reference, untouched');
});

// ── AC-US5-03: the multi-turn regression gate ──
const HEADER = 'The following skills are available for use with the Skill tool:';
const CATALOG = `${HEADER}\n\n- sw:do: Execute increment tasks\n- verify: Verify a change works`;

// Scripted history of the first t turns. Turn 1's opening message carries the catalog
// + establishes plan mode; later turns (Claude Code drops the catalog) do not.
function scripted(t) {
  const msgs = [];
  const head = (t === 1 ? `<system-reminder>\n${CATALOG}\n</system-reminder>\n` : '') + 'Investigate the repo and fix the build.';
  msgs.push({ role: 'user', content: [{ type: 'text', text: head }] });
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'Exploring the codebase first.' }] });
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'files: ' + 'x'.repeat(200) }] });
  msgs.push(planTurn()); // plan mode established at index 3
  for (let i = 4; i <= 2 * t; i++) {
    msgs.push(i % 2
      ? { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls ' + 'y'.repeat(150) } }] }
      : { role: 'user', content: [{ type: 'tool_result', tool_use_id: String(i), content: 'out ' + 'z'.repeat(150) }] });
  }
  return msgs;
}

test('US-005 (AC-US5-03) — 10-turn gate: skill re-injection >=60% on turn-2+, plan-mode re-entry <=1', () => {
  _resetSkillCatalogCache();
  let reinjected = 0;
  let planLost = 0;
  for (let t = 1; t <= 10; t++) {
    const msgs = scripted(t);
    const { addition } = buildFidelityAddition(msgs, { fidelity: 'balanced', scope: 'all', tools: [{ name: 'Skill' }] });
    if (t >= 2 && addition.includes('Available skills')) reinjected++;
    // condense as the proxy would, then check the model can still see plan state
    const { messages: condensed } = condenseMessages(msgs, { maxChars: 1500 });
    if (!condensed.some(isPlanTurn)) planLost++;
  }
  assert.ok(reinjected / 9 >= 0.6, `turn-2+ skill re-injection ${reinjected}/9 must be >=60%`);
  assert.ok(planLost <= 1, `plan-mode state lost on ${planLost} turns (re-entry proxy) must be <=1`);
});
