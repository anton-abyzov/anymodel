// Unit tests for providers/skill-catalog.mjs (increment 0010 — local skill-fidelity).
// Pure functions: harvest the Claude Code skill catalog from a request, compress it
// to a budgeted name+desc index, and build a curated behavioral core — all deterministic.
//
// Run: node --test test/skill-catalog.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  harvestSkillCatalog,
  selectSkills,
  buildBehavioralCore,
  buildFidelityAddition,
} from '../providers/skill-catalog.mjs';

const HEADER = 'The following skills are available for use with the Skill tool:';

// Realistic system-reminder: namespaced name (sw:do), plain name (verify),
// whenToUse tails introduced with " - ", and an em-dash inside a description.
function reminderMessages(body) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` },
        { type: 'text', text: 'Please refactor the auth module.' },
      ],
    },
  ];
}

const TWO_SKILLS = `${HEADER}

- sw:do: Execute increment tasks following spec and plan - when implementing or saying "start working"
- verify: Verify that a code change actually does what it's supposed to — run the app and observe - When asked to verify a PR`;

describe('harvestSkillCatalog', () => {
  it('captures name:desc lines and drops the whenToUse tail', () => {
    const { skills, rawCount } = harvestSkillCatalog(reminderMessages(TWO_SKILLS));
    assert.equal(rawCount, 2);
    assert.equal(skills.length, 2);
    const byName = Object.fromEntries(skills.map(s => [s.name, s.desc]));
    assert.ok(byName['sw:do'], 'namespaced name sw:do parsed');
    assert.ok(byName['verify'], 'plain name verify parsed');
    // whenToUse tail removed
    assert.ok(!byName['sw:do'].includes('when implementing'), 'whenToUse dropped');
    assert.ok(!byName['verify'].includes('When asked to verify'), 'whenToUse dropped');
    // description content retained up to the cut
    assert.ok(byName['sw:do'].startsWith('Execute increment tasks'));
  });

  it('clamps each description to descChars', () => {
    const { skills } = harvestSkillCatalog(reminderMessages(TWO_SKILLS), { descChars: 20 });
    for (const s of skills) assert.ok(s.desc.length <= 20, `desc "${s.desc}" <= 20`);
  });

  it('returns empty result and does not throw when no catalog present', () => {
    const res = harvestSkillCatalog([{ role: 'user', content: 'just a normal message' }]);
    assert.deepEqual(res, { skills: [], rawCount: 0 });
  });

  it('handles string message content as well as block arrays', () => {
    const { rawCount } = harvestSkillCatalog([
      { role: 'user', content: `<system-reminder>\n${TWO_SKILLS}\n</system-reminder>` },
    ]);
    assert.equal(rawCount, 2);
  });
});

describe('selectSkills', () => {
  const skills = [
    { name: 'verify', desc: 'Verify a change works' },
    { name: 'sw:do', desc: 'Execute increment tasks' },
    { name: 'simplify', desc: 'Clean up changed code' },
  ];

  it('emits a BLOCKING-REQUIREMENT header and name-sorted lines', () => {
    const { block } = selectSkills(skills, { budgetChars: 4000, query: '' });
    assert.ok(block.includes('Available skills (call the Skill tool when a request matches'));
    assert.ok(block.includes('BLOCKING REQUIREMENT'));
    const names = [...block.matchAll(/^- ([\w:-]+):/gm)].map(m => m[1]);
    assert.deepEqual(names, ['simplify', 'sw:do', 'verify'], 'lines sorted by name');
  });

  it('is deterministic — same input yields byte-identical block', () => {
    const a = selectSkills(skills, { budgetChars: 4000, query: 'auth refactor' }).block;
    const b = selectSkills(skills, { budgetChars: 4000, query: 'auth refactor' }).block;
    assert.equal(a, b);
  });

  it('caps to budget, keeps sw:* first, and drops the overflow', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: i === 100 ? 'sw:do' : `skill-${String(i).padStart(3, '0')}`,
      desc: 'A reasonably long description that consumes budget quickly when repeated many times',
    }));
    const { block, kept, dropped } = selectSkills(many, { budgetChars: 800, query: '' });
    assert.ok(block.length <= 800, `block respects budget, got ${block.length}`);
    assert.ok(block.includes('sw:do'), 'sw:* skill retained first under pressure');
    assert.ok(dropped > 0, 'overflow dropped');
    assert.equal(kept + dropped, 200);
  });

  it('degrades to names-only lines when full lines do not fit', () => {
    const longDesc = 'A very long skill description '.repeat(6).trim(); // ~170 chars
    const skillsLong = [
      { name: 'sw:do', desc: longDesc },
      { name: 'alpha', desc: longDesc },
      { name: 'bravo', desc: longDesc },
      { name: 'charlie', desc: longDesc },
    ];
    // Budget fits the header + a few short "- name" lines but not the long full lines.
    const { block } = selectSkills(skillsLong, { budgetChars: 220, query: '' });
    const namesOnly = block.split('\n').filter(l => /^- [\w:-]+$/.test(l));
    assert.ok(namesOnly.length >= 1, 'at least one names-only line present');
    assert.ok(block.includes('sw:do'), 'sw:* retained');
  });

  it('returns an empty block (no orphan header) when there are no skills', () => {
    const { block, kept } = selectSkills([], { budgetChars: 4000 });
    assert.equal(block, '');
    assert.equal(kept, 0);
  });
});

describe('buildBehavioralCore', () => {
  it('balanced includes the call-Skill-FIRST blocking rule and stays within token budget', () => {
    const core = buildBehavioralCore('balanced');
    assert.ok(core.length > 0);
    assert.ok(/Skill/i.test(core) && /BLOCKING|FIRST/i.test(core), 'blocking-Skill rule present');
    assert.ok(core.length <= 3600, `core <= ~900 tokens (~3600 chars), got ${core.length}`);
  });

  it('lean returns an empty string (zero re-injection)', () => {
    assert.equal(buildBehavioralCore('lean'), '');
  });
});

describe('buildFidelityAddition', () => {
  const msgs = reminderMessages(TWO_SKILLS);

  it('balanced returns core + skill index from the harvested catalog', () => {
    const { addition, injected, rawCount } = buildFidelityAddition(msgs, { fidelity: 'balanced' });
    assert.equal(rawCount, 2);
    assert.ok(injected >= 1);
    assert.ok(addition.includes('Available skills (call the Skill tool when a request matches'));
    assert.ok(/BLOCKING REQUIREMENT/.test(addition));
  });

  it('lean returns an empty addition (AC-US2-01)', () => {
    assert.deepEqual(buildFidelityAddition(msgs, { fidelity: 'lean' }), { addition: '', injected: 0, rawCount: 0 });
  });

  it('skillIndexMode=off skips harvest — core only, no skill block (AC-US2-02)', () => {
    const { addition, injected, rawCount } = buildFidelityAddition(msgs, { fidelity: 'balanced', skillIndexMode: 'off' });
    assert.equal(rawCount, 0, 'harvest not performed');
    assert.equal(injected, 0);
    assert.ok(!addition.includes('Available skills'), 'no skill block');
    assert.ok(addition.length > 0, 'behavioral core still present');
  });

  it('is deterministic across identical calls (AC-US3-01 building block)', () => {
    const a = buildFidelityAddition(msgs, { fidelity: 'balanced' }).addition;
    const b = buildFidelityAddition(msgs, { fidelity: 'balanced' }).addition;
    assert.equal(a, b);
  });

  it('full retains whenToUse tails (richer than balanced) (AC-US5-02)', () => {
    const balanced = buildFidelityAddition(msgs, { fidelity: 'balanced' }).addition;
    const full = buildFidelityAddition(msgs, { fidelity: 'full' }).addition;
    assert.ok(full.length >= balanced.length, 'full index is at least as large as balanced');
    assert.ok(full.includes('when implementing') || full.includes('When asked to verify'),
      'full keeps the whenToUse tail that balanced drops');
  });
});
