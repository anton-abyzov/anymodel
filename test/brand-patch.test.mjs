// Tests for the reproducible branding-patch layer (scripts/brand-patch.mjs).
// Manifest-driven: every entry added to BRAND_PATCHES is automatically exercised,
// so coverage grows with the manifest and never hardcodes individual strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_PATCHES, applyBrandPatches } from '../scripts/brand-patch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_BUNDLE = join(__dirname, '..', 'cli.js');

// A minimal valid-JS fixture that embeds every patch's `from` exactly `expect` times.
function makeFixture() {
  let body = 'const _ = [];\n';
  for (const p of BRAND_PATCHES) {
    for (let i = 0; i < p.expect; i++) body += `_.push(${p.from});\n`;
  }
  return body;
}

test('manifest entries are well-formed', () => {
  for (const p of BRAND_PATCHES) {
    assert.ok(p.id, 'patch needs an id');
    assert.ok(typeof p.from === 'string' && p.from.length, `${p.id}: from`);
    assert.ok(typeof p.to === 'string' && p.to.length, `${p.id}: to`);
    assert.ok(Number.isInteger(p.expect) && p.expect >= 1, `${p.id}: expect`);
    assert.notEqual(p.from, p.to, `${p.id}: from === to`);
  }
  const ids = BRAND_PATCHES.map(p => p.id);
  assert.equal(ids.length, new Set(ids).size, 'patch ids must be unique');
});

// Guard against a bad regen of brand-patches.json silently emptying the manifest,
// which would make every other test (incl. the live-bundle gate) pass vacuously.
test('manifest is non-trivially populated', () => {
  assert.ok(BRAND_PATCHES.length >= 40,
    `expected a substantial manifest, got ${BRAND_PATCHES.length} — empty/short manifest makes the suite vacuously green`);
});

test('applier removes every vendor string and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const f = join(dir, 'bundle.js');
  try {
    writeFileSync(f, makeFixture());

    // parseCheck:false — the fixture concatenates raw anchors and isn't valid
    // standalone JS; we're testing replacement logic, not bundle validity here.
    const r1 = applyBrandPatches(f, { parseCheck: false });
    assert.deepEqual(r1.drift, [], 'no drift on first apply');
    assert.equal(r1.applied.length, BRAND_PATCHES.length, 'all patches applied');

    const out = readFileSync(f, 'utf8');
    for (const p of BRAND_PATCHES) {
      assert.equal(out.includes(p.from), false, `${p.id}: vendor string still present`);
      assert.equal(out.includes(p.to), true, `${p.id}: replacement missing`);
    }

    // Second run is a pure no-op (idempotent).
    const r2 = applyBrandPatches(f, { parseCheck: false });
    assert.deepEqual(r2.drift, [], 'no drift on re-run');
    assert.equal(r2.applied.length, 0, 're-run applies nothing');
    assert.equal(r2.skipped.length, BRAND_PATCHES.length, 're-run skips all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check mode flags an unbranded bundle as drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const f = join(dir, 'bundle.js');
  try {
    writeFileSync(f, makeFixture());
    // parseCheck:false — fixture isn't valid standalone JS.
    const r = applyBrandPatches(f, { check: true, parseCheck: false });
    // Every unapplied patch is drift; the denylist sweep may add more on top.
    assert.ok(r.drift.length >= BRAND_PATCHES.length, 'every unapplied patch is drift');
    assert.equal(r.applied.length, 0, 'check mode never writes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The denylist is the backstop for the masking case: an upstream-version-bumped
// vendor string whose exact `from` no longer matches but whose `to` is a substring
// of the new text would otherwise skip silently. The sweep must still flag it.
test('vendor denylist catches a version-bumped string the exact anchor misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const f = join(dir, 'bundle.js');
  try {
    // Manifest anchor is "...Opus 4.6"; upstream shipped "...Opus 4.7".
    writeFileSync(f, 'x="Model updated to Opus 4.7";');
    const patches = [{ id: 'mu', from: 'Model updated to Opus 4.6', to: 'Model updated', expect: 1 }];
    const r = applyBrandPatches(f, { check: true, parseCheck: false, patches });
    assert.equal(r.skipped.includes('mu'), true, 'exact anchor mask-skips (the bug)');
    assert.ok(r.drift.some(d => d.includes('vendor-denylist')), 'denylist still catches the residual');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The parse-safety guarantee (apply mode runs node --check and throws on a broken
// result) must be covered by valid JS fixtures, since the manifest fixtures aren't.
test('apply mode keeps a valid bundle valid, and throws on an unparseable result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const ok = join(dir, 'ok.js'), bad = join(dir, 'bad.js');
  try {
    // Positive: valid replacement → parses, written.
    writeFileSync(ok, 'const a = "Claude";\n');
    const rOk = applyBrandPatches(ok, { patches: [{ id: 'p', from: '"Claude"', to: '"anymodel"', expect: 1 }] });
    assert.deepEqual(rOk.drift, []);
    assert.equal(readFileSync(ok, 'utf8').includes('"anymodel"'), true);

    // Negative: replacement that breaks JS → node --check fails → throws, nothing shipped silently.
    writeFileSync(bad, 'const a = "Claude";\n');
    assert.throws(
      () => applyBrandPatches(bad, { patches: [{ id: 'p', from: '"Claude"', to: '(unterminated', expect: 1 }] }),
      /unparseable bundle/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CI gate against the real shipped bundle: it must already be fully branded and
// free of any vendor string the manifest knows about.
test('live cli.js is fully branded (no vendor drift)', { skip: !existsSync(LIVE_BUNDLE) }, () => {
  const r = applyBrandPatches(LIVE_BUNDLE, { check: true });
  assert.deepEqual(r.drift, [], `live bundle has unbranded vendor strings: ${r.drift.join('; ')}`);
});
