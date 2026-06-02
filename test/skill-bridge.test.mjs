// Tests for the universal skill loader (providers/skill-bridge.mjs, increment 0013).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREIGN_SKILL_DIRS,
  resolveForeignSkillRoots,
  discoverForeignSkills,
  planSkillBridge,
  materializeSkillBridge,
  readProjectSkillNames,
  buildSkillBridge,
} from '../providers/skill-bridge.mjs';

// ── A tiny in-memory fs for the pure-logic tests ────────────────────────────
// Models a set of existing paths; directories are paths ending without SKILL.md,
// files are explicit. statSync(dir).isDirectory() is derived from the dir set.
function fakeFs({ dirs = [], files = [], entries = {}, symlinks = {} }) {
  const dirSet = new Set(dirs);
  const fileSet = new Set(files);
  const symSet = new Set(Object.keys(symlinks)); // path -> realpath target
  return {
    existsSync: p => dirSet.has(p) || fileSet.has(p) || symSet.has(p),
    readdirSync: p => entries[p] || [],
    statSync: p => ({ isDirectory: () => dirSet.has(p) }),
    lstatSync: p => ({ isSymbolicLink: () => symSet.has(p), isDirectory: () => dirSet.has(p) && !symSet.has(p) }),
    realpathSync: p => symlinks[p] || p,
    // I/O methods unused in pure tests:
    mkdtempSync: () => { throw new Error('not used'); },
    mkdirSync: () => {},
    symlinkSync: () => {},
    rmSync: () => {},
  };
}

test('resolveForeignSkillRoots: cwd + home + ANYMODEL_SKILL_ROOTS, de-duped, ordered', () => {
  const roots = resolveForeignSkillRoots({
    cwd: '/proj', homeDir: '/home/u', env: { ANYMODEL_SKILL_ROOTS: '/extra/one:/extra/two' },
  });
  // cwd roots first, in FOREIGN_SKILL_DIRS order
  assert.equal(roots[0], join('/proj', FOREIGN_SKILL_DIRS[0]));
  assert.ok(roots.includes(join('/home/u', '.codex/skills')));
  assert.ok(roots.includes('/extra/one') && roots.includes('/extra/two'));
  assert.equal(roots.length, new Set(roots).size, 'no duplicates');
});

test('discoverForeignSkills: finds <root>/<name>/SKILL.md, notes Codex sidecar, skips non-skills', () => {
  const root = '/proj/.agents/skills';
  // 'empty' is a dir without SKILL.md; 'README.md' is not a dir.
  const fs = fakeFs({
    dirs: [root, `${root}/foo`, `${root}/bar`, `${root}/empty`],
    files: [`${root}/foo/SKILL.md`, `${root}/bar/SKILL.md`, `${root}/bar/agents/openai.yaml`],
    entries: { [root]: ['foo', 'bar', 'empty', 'README.md'] },
  });
  const found = discoverForeignSkills([root], fs);
  const names = found.map(f => f.name).sort();
  assert.deepEqual(names, ['bar', 'foo']);
  const bar = found.find(f => f.name === 'bar');
  assert.equal(bar.sidecarPath, `${root}/bar/agents/openai.yaml`);
  assert.equal(found.find(f => f.name === 'foo').sidecarPath, null);
});

test('discoverForeignSkills: skips a symlinked entry that escapes the scanned root (containment)', () => {
  const root = '/proj/.codex/skills';
  const fs = fakeFs({
    dirs: [root, `${root}/safe`, '/etc/secrets'],
    files: [`${root}/safe/SKILL.md`, '/etc/secrets/SKILL.md'],
    entries: { [root]: ['safe', 'escape'] },
    // `escape` is a symlink resolving OUTSIDE the root.
    symlinks: { [`${root}/escape`]: '/etc/secrets', [root]: root },
  });
  const found = discoverForeignSkills([root], fs).map(f => f.name);
  assert.deepEqual(found, ['safe'], 'escaping symlink is skipped');
});

test('planSkillBridge: case-only-different names collide and the loser is a LOGGED shadow', () => {
  const { link, shadowed } = planSkillBridge(
    [{ name: 'Foo', root: 'r1', dir: 'r1/Foo' }, { name: 'foo', root: 'r2', dir: 'r2/foo' }],
    [],
  );
  assert.equal(link.length, 1, 'only one of Foo/foo is linked');
  assert.equal(shadowed.length, 1, 'the case-variant is shadowed (not silently dropped)');
});

test('resolveForeignSkillRoots: relative ANYMODEL_SKILL_ROOTS entries are resolved to absolute', () => {
  const roots = resolveForeignSkillRoots({ cwd: '/proj', env: { ANYMODEL_SKILL_ROOTS: 'rel/skills:/abs/skills' } });
  assert.ok(roots.includes(join('/proj', 'rel/skills')), 'relative resolved against cwd');
  assert.ok(roots.includes('/abs/skills'), 'absolute kept');
});

test('materializeSkillBridge: all-symlinks-fail → reports skipped, removes the temp dir, no orphan', () => {
  let made = null, removed = null;
  const fs = {
    mkdtempSync: () => { made = '/tmp/bridge-X'; return made; },
    mkdirSync: () => {},
    symlinkSync: () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; },
    rmSync: p => { removed = p; },
  };
  const r = materializeSkillBridge({ link: [{ name: 'a', dir: '/x/a' }] }, { tmpBase: '/tmp', fs });
  assert.equal(r.bridgeDir, null, 'no bridge dir handed back');
  assert.deepEqual(r.linked, []);
  assert.equal(r.skipped[0].code, 'EPERM', 'errno surfaced');
  assert.equal(removed, made, 'orphan temp dir removed');
});

test('planSkillBridge: project wins, first foreign root wins, shadows are logged', () => {
  const discovered = [
    { name: 'foo', root: 'r1', dir: 'r1/foo' },   // shadowed by project
    { name: 'bar', root: 'r1', dir: 'r1/bar' },   // linked
    { name: 'bar', root: 'r2', dir: 'r2/bar' },   // shadowed (dup name)
    { name: 'baz', root: 'r2', dir: 'r2/baz' },   // linked
  ];
  const { link, shadowed } = planSkillBridge(discovered, ['foo']);
  assert.deepEqual(link.map(l => `${l.name}@${l.root}`), ['bar@r1', 'baz@r2']);
  assert.equal(shadowed.length, 2);
  assert.match(shadowed.find(s => s.name === 'foo').reason, /project/);
  assert.match(shadowed.find(s => s.name === 'bar').reason, /duplicate/);
});

test('materializeSkillBridge: null when nothing to link', () => {
  assert.equal(materializeSkillBridge({ link: [] }), null);
  assert.equal(materializeSkillBridge(null), null);
});

// ── Integration: real symlinks on disk ──────────────────────────────────────
test('integration: foreign .agents skill becomes discoverable under the bridge', () => {
  const base = mkdtempSync(join(tmpdir(), 'skbridge-'));
  try {
    // A project with a foreign skill and a colliding project skill.
    const cwd = join(base, 'proj');
    const agentsSkill = join(cwd, '.agents', 'skills', 'demo');
    mkdirSync(agentsSkill, { recursive: true });
    writeFileSync(join(agentsSkill, 'SKILL.md'), '---\nname: demo\ndescription: A demo skill.\n---\nBody.\n');
    // Codex sidecar
    mkdirSync(join(agentsSkill, 'agents'), { recursive: true });
    writeFileSync(join(agentsSkill, 'agents', 'openai.yaml'), 'interface:\n  display_name: Demo\n');
    // A project skill that should win over a same-named foreign one.
    const projSkill = join(cwd, '.claude', 'skills', 'mine');
    mkdirSync(projSkill, { recursive: true });
    writeFileSync(join(projSkill, 'SKILL.md'), '---\nname: mine\ndescription: Mine.\n---\n');
    const codexMine = join(cwd, '.codex', 'skills', 'mine');
    mkdirSync(codexMine, { recursive: true });
    writeFileSync(join(codexMine, 'SKILL.md'), '---\nname: mine\ndescription: Foreign mine (should be shadowed).\n---\n');

    const { discovered, plan, bridge } = buildSkillBridge({ cwd, homeDir: '', env: {} }, undefined, { tmpBase: base });

    assert.ok(discovered.some(d => d.name === 'demo'), 'demo discovered');
    assert.equal(bridge.linked.includes('demo'), true, 'demo linked');
    assert.equal(bridge.linked.includes('mine'), false, 'foreign mine NOT linked (project wins)');
    assert.ok(plan.shadowed.some(s => s.name === 'mine'), 'foreign mine shadowed');

    // The bridged SKILL.md must be readable through the symlink — i.e. the client,
    // scanning <bridge>/.claude/skills, would find it.
    const bridged = join(bridge.bridgeDir, '.claude', 'skills', 'demo', 'SKILL.md');
    assert.equal(existsSync(bridged), true, 'SKILL.md resolvable through the bridge symlink');
    assert.match(readFileSync(bridged, 'utf8'), /name: demo/);
    // Sidecar carried through the whole-dir symlink.
    assert.equal(existsSync(join(bridge.bridgeDir, '.claude', 'skills', 'demo', 'agents', 'openai.yaml')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('integration: ANYMODEL_SKILL_ROOTS adds an arbitrary root', () => {
  const base = mkdtempSync(join(tmpdir(), 'skbridge-'));
  try {
    const custom = join(base, 'custom');
    const skill = join(custom, 'extra');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: extra\ndescription: Extra.\n---\n');
    const { bridge } = buildSkillBridge(
      { cwd: join(base, 'empty-proj'), homeDir: '', env: { ANYMODEL_SKILL_ROOTS: custom } },
      undefined, { tmpBase: base },
    );
    assert.equal(bridge.linked.includes('extra'), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('discovery is non-fatal on a missing root', () => {
  const found = discoverForeignSkills(['/does/not/exist']);
  assert.deepEqual(found, []);
});

// cli.mjs glue: setupSkillBridge() shapes the spawn args + cleanup from the real cwd.
test('setupSkillBridge: returns --add-dir + working cleanup, [] when nothing found', async () => {
  const { setupSkillBridge } = await import('../cli.mjs');
  const base = mkdtempSync(join(tmpdir(), 'skbridge-cli-'));
  const orig = process.cwd();
  const origHome = process.env.HOME;
  try {
    // Control HOME so user-scope foreign skills on the real machine don't perturb the test.
    const fakeHome = join(base, 'home');
    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    const proj = join(base, 'proj');
    const skill = join(proj, '.gemini', 'skills', 'g1');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: g1\ndescription: G.\n---\n');

    process.chdir(proj);
    const r = setupSkillBridge();
    assert.equal(r.args[0], '--add-dir', 'passes --add-dir');
    const dir = r.args[1];
    assert.equal(existsSync(join(dir, '.claude', 'skills', 'g1', 'SKILL.md')), true, 'bridged skill present');
    r.cleanup();
    assert.equal(existsSync(dir), false, 'cleanup removes the bridge dir');

    // Empty project → no args, no-op cleanup.
    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    process.chdir(empty);
    const r2 = setupSkillBridge();
    assert.deepEqual(r2.args, []);
    r2.cleanup(); // must not throw
  } finally {
    process.chdir(orig);
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    rmSync(base, { recursive: true, force: true });
  }
});
