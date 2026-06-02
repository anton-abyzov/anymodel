#!/usr/bin/env node
// brand-patch.mjs — reproducible, idempotent, verifiable branding layer for the
// bundled Claude Code TUI that anymodel ships as `cli.js`.
//
// WHY THIS EXISTS
// ---------------
// `cli.js` is a 13MB MINIFIED bundle (a re-branded Claude Code TUI). Branding used
// to be applied by hand-editing that minified blob. That is unmaintainable:
//   1. Every upstream bundle refresh silently wipes all hand edits.
//   2. Coverage drifts — vendor strings get missed (e.g. the "Opus now defaults to
//      1M context" promo and the "Claude is now exploring…" plan-mode line both
//      survived ~10 earlier hand patches and shipped to users running qwen).
//
// This module replaces ad-hoc editing with a DECLARATIVE manifest of patches plus an
// applier that:
//   • asserts each `from` appears exactly `expect` times before touching anything
//     (a mismatch means upstream changed — fail loudly instead of corrupting the file),
//   • applies every replacement,
//   • re-parses the result with the Node parser so a broken patch can never ship,
//   • is IDEMPOTENT: re-running is a no-op once `from` is gone and `to` is present.
//
// MODEL-ADAPTIVE PATCHES
// ----------------------
// The launcher (cli.mjs) injects `ANYMODEL_MODEL` (the real backend model id) and
// overrides `ANTHROPIC_MODEL` into the spawned TUI's env. Patches marked `adaptive`
// replace a static string LITERAL with a JS EXPRESSION that reads
// `process.env.ANYMODEL_MODEL` at render time, so the UI reflects whatever model the
// user actually loaded (default: qwen) instead of an Anthropic-specific constant.
//
// USAGE
// -----
//   node scripts/brand-patch.mjs                 # apply to ./cli.js
//   node scripts/brand-patch.mjs --check         # verify-only (CI gate); non-zero exit if drift
//   node scripts/brand-patch.mjs path/to/cli.js  # target an explicit bundle

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Declarative patch manifest ───────────────────────────────────────────────
// Loaded from scripts/brand-patches.json (data/code separation — the manifest is
// regenerated/extended without touching applier logic). Each entry:
//   { id, category, adaptive, from, to, expect }
//   from   — exact substring as it appears in the minified bundle. For `adaptive`
//            patches this is the full quoted string LITERAL; `to` is a JS EXPRESSION
//            (template literal) that slots into the same argument position and reads
//            process.env.ANYMODEL_MODEL at render time.
//   to     — replacement. Static brand string for non-adaptive; JS expression for adaptive.
//   expect — required occurrence count of `from` in a pristine (pre-patch) bundle.
//            The applier asserts the live count matches before replacing.
export const BRAND_PATCHES = JSON.parse(
  readFileSync(join(__dirname, 'brand-patches.json'), 'utf8'),
);

// ── Vendor denylist (anti-regression net) ────────────────────────────────────
// High-signal, USER-VISIBLE vendor phrases that must be 0 in a fully-branded
// bundle. This is deliberately version-TOLERANT where the manifest's exact `from`
// is not: e.g. an upstream bump from "Model updated to Opus 4.6" to "...4.7" no
// longer matches the manifest anchor, so that patch would silently mask-skip
// (its `to`, "Model updated", is a substring of the new vendor string). The sweep
// catches the residual regardless of the version number and forces a manifest update.
// Every pattern here is verified to match ZERO times in the branded bundle, so it
// never fires on internal/kept strings (model IDs, system prompts, `claude-code`,
// Claude Desktop, etc.).
export const VENDOR_DENYLIST = [
  { label: 'opus-1m-promo', re: /Opus now defaults/ },
  { label: 'model-remap-notice', re: /Model updated to (Opus|Sonnet|Haiku)/ },
  { label: 'welcome-banner', re: /Welcome to Claude Code/ },
  { label: 'login-title', re: /Log in to Claude\b/ },
  { label: 'signin-anthropic', re: /Sign (in with|out from) your Anthropic account/ },
  { label: 'plan-mode-claude', re: /Claude is now exploring/ },
  { label: 'high-demand-opus', re: /high demand for Opus/ },
  { label: 'high-load-sonnet', re: /switch to Sonnet/ },
  { label: 'version-suffix', re: / \(Claude Code\)/ },
];

function sweepVendorDenylist(src) {
  const hits = [];
  for (const { label, re } of VENDOR_DENYLIST) {
    const m = src.match(re);
    if (m) hits.push({ label, snippet: m[0] });
  }
  return hits;
}

// ── Applier ──────────────────────────────────────────────────────────────────
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let n = 0, i = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

/**
 * @param {string} bundlePath
 * @param {{check?: boolean, parseCheck?: boolean, patches?: object[]}} [opts]
 *        check       — verify-only, never write (CI gate). Also runs the denylist
 *                      sweep and (when parseCheck) `node --check` on the bundle.
 *        parseCheck  — run `node --check` on the bundle (default true). Disable only
 *                      for unit fixtures that aren't valid standalone JS.
 *        patches     — override the manifest (testing). Defaults to BRAND_PATCHES.
 * @returns {{applied: string[], skipped: string[], drift: string[]}}
 */
export function applyBrandPatches(bundlePath, opts = {}) {
  const check = !!opts.check;
  const parseCheck = opts.parseCheck !== false;
  const patches = opts.patches || BRAND_PATCHES;
  let src = readFileSync(bundlePath, 'utf8');
  const applied = [], skipped = [], drift = [];

  for (const p of patches) {
    const fromCount = countOccurrences(src, p.from);
    const toPresent = countOccurrences(src, p.to) > 0;

    if (fromCount === 0 && toPresent) {
      // Already branded — idempotent no-op. (The VENDOR_DENYLIST sweep below is the
      // backstop for the case where `to` is a substring of an upstream-mutated `from`
      // and this branch would otherwise mask the drift.)
      skipped.push(p.id);
      continue;
    }
    if (fromCount !== p.expect) {
      // Upstream changed (or partial state) — refuse to guess.
      drift.push(`${p.id}: expected ${p.expect} occurrence(s) of \`from\`, found ${fromCount}${toPresent ? ' (and `to` already present)' : ''}`);
      continue;
    }
    if (check) {
      // In check mode an un-applied patch is itself drift the CI gate must catch.
      drift.push(`${p.id}: vendor string still present (${fromCount}×) — brand patch not applied`);
      continue;
    }
    src = src.split(p.from).join(p.to);
    applied.push(p.id);
  }

  // Anti-regression: residual user-visible vendor phrases the exact `from` anchors
  // can miss (e.g. version-bumped model names). Runs in BOTH modes on the result.
  for (const hit of sweepVendorDenylist(src)) {
    drift.push(`vendor-denylist[${hit.label}]: residual vendor string "${hit.snippet}"`);
  }

  if (check) {
    // Verify-only: also confirm the existing bundle actually parses.
    if (parseCheck) {
      try {
        execFileSync(process.execPath, ['--check', bundlePath], { stdio: 'pipe' });
      } catch (e) {
        drift.push(`parse: bundle failed node --check\n${e.stderr || e.message}`);
      }
    }
    return { applied, skipped, drift };
  }

  // Apply mode is ATOMIC: any drift (patch mismatch OR denylist residual) → refuse
  // to write, leaving the bundle untouched. Never persist a half-branded bundle.
  if (drift.length) return { applied, skipped, drift };

  if (applied.length) {
    writeFileSync(bundlePath, src);
    // Never ship a syntactically broken bundle.
    if (parseCheck) try {
      execFileSync(process.execPath, ['--check', bundlePath], { stdio: 'pipe' });
    } catch (e) {
      throw new Error(`brand-patch produced an unparseable bundle (node --check failed):\n${e.stderr || e.message}`);
    }
  }

  return { applied, skipped, drift };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const pathArg = args.find(a => !a.startsWith('--'));
  const bundlePath = pathArg || join(__dirname, '..', 'cli.js');

  const { applied, skipped, drift } = applyBrandPatches(bundlePath, { check });

  for (const id of applied) console.log(`  ✓ applied  ${id}`);
  for (const id of skipped) console.log(`  • skipped  ${id} (already branded)`);
  for (const d of drift) console.error(`  ✗ DRIFT    ${d}`);

  if (drift.length) {
    console.error(`\nbrand-patch: ${drift.length} patch(es) drifted. ` +
      (check ? 'Bundle is missing required branding.' : 'Refusing to corrupt the bundle.'));
    process.exit(1);
  }
  console.log(`\nbrand-patch: ${applied.length} applied, ${skipped.length} already in place. Bundle OK.`);
}
