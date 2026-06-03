// US-001 (0013): the skill catalog must survive a whole multi-turn session.
// Claude Code sends the catalog <system-reminder> only on turn 1; the proxy caches it
// per-session and re-injects on turn 2+. Plus the trim-without-restore self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFidelityAddition, buildBehavioralCore, hasSkillCatalog, shouldWarnTrimWithoutRestore,
  _resetSkillCatalogCache, _skillCatalogCacheSize,
} from '../providers/skill-catalog.mjs';

const HEADER = 'The following skills are available for use with the Skill tool:';
const CATALOG = `${HEADER}

- sw:do: Execute increment tasks
- verify: Verify a change works`;

const turn1 = (prompt = 'Refactor the auth module please.') => [
  { role: 'user', content: [
    { type: 'text', text: `<system-reminder>\n${CATALOG}\n</system-reminder>` },
    { type: 'text', text: prompt },
  ] },
];
const turn2 = (prompt = 'Refactor the auth module please.') => [
  { role: 'user', content: [{ type: 'text', text: prompt }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: 'continue' },
];

test('US-001 — turn-2+ re-injects the cached catalog when this turn has none', () => {
  _resetSkillCatalogCache();
  const a = buildFidelityAddition(turn1(), { fidelity: 'balanced', scope: 'all' });
  assert.ok(a.rawCount >= 2 && a.addition.includes('Available skills'), 'turn 1 injects from harvest');
  const b = buildFidelityAddition(turn2(), { fidelity: 'balanced', scope: 'all' });
  assert.equal(b.rawCount, 0, 'no catalog harvested this turn');
  assert.ok(b.addition.includes('Available skills'), 're-injected from session cache');
  assert.ok(b.addition.includes('sw:do'), 'cached skills present');
});

test('US-001 — no cross-session cache bleed (different opening prompt → no borrow)', () => {
  _resetSkillCatalogCache();
  buildFidelityAddition(turn1('Session A opening'), { fidelity: 'balanced', scope: 'all' });
  const b = buildFidelityAddition(turn2('Session B opening — totally different'), { fidelity: 'balanced', scope: 'all' });
  assert.equal(b.rawCount, 0);
  assert.ok(!b.addition.includes('Available skills'), 'a different session does not inherit the cache');
});

test('US-001 (AC-US1-02) — no dangling "listed below" when no catalog and no cache', () => {
  _resetSkillCatalogCache();
  const { addition } = buildFidelityAddition(turn2('brand new prompt, no catalog ever'), { fidelity: 'balanced', scope: 'all' });
  assert.ok(!addition.includes('Available skills'), 'no skill block');
  assert.ok(!/listed below/i.test(addition), 'no dangling skills-listed-below reference');
  assert.ok(addition.length > 0, 'behavioral core still present');
});

test('US-001 — session cache is bounded (no unbounded growth)', () => {
  _resetSkillCatalogCache();
  for (let i = 0; i < 500; i++) {
    buildFidelityAddition(turn1(`unique opening prompt number ${i}`), { fidelity: 'balanced', scope: 'all' });
  }
  assert.ok(_skillCatalogCacheSize() <= 200, `cache bounded, got ${_skillCatalogCacheSize()}`);
});

test('US-001 — buildBehavioralCore omits the SKILLS line when hasSkills=false', () => {
  assert.ok(/listed below/i.test(buildBehavioralCore('balanced', { hasSkills: true })));
  const without = buildBehavioralCore('balanced', { hasSkills: false });
  assert.ok(!/listed below/i.test(without) && without.length > 0);
  assert.ok(/listed below/i.test(buildBehavioralCore('balanced')), 'default preserves legacy behavior');
});

test('US-001 — hasSkillCatalog detects the catalog header', () => {
  assert.equal(hasSkillCatalog(turn1()), true);
  assert.equal(hasSkillCatalog(turn2()), false);
});

test('US-001 (AC-US1-03) — shouldWarnTrimWithoutRestore fires only on lean + Skill tool + catalog', () => {
  assert.equal(shouldWarnTrimWithoutRestore({ fidelity: 'lean', hasSkillTool: true, catalogPresent: true }), true);
  assert.equal(shouldWarnTrimWithoutRestore({ fidelity: 'lean', hasSkillTool: false, catalogPresent: true }), false);
  assert.equal(shouldWarnTrimWithoutRestore({ fidelity: 'lean', hasSkillTool: true, catalogPresent: false }), false);
  assert.equal(shouldWarnTrimWithoutRestore({ fidelity: 'balanced', hasSkillTool: true, catalogPresent: true }), false);
});
