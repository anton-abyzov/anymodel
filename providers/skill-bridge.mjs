// providers/skill-bridge.mjs — increment 0013 (universal skill loader).
//
// SKILL.md is ONE shared open standard (agentskills.io): Claude Code, OpenAI/Codex,
// Google Gemini/Antigravity, Cursor, Copilot and Goose all write the SAME format —
// a directory `<name>/SKILL.md` (YAML frontmatter + Markdown body, optional
// scripts/references/assets). Only the DISCOVERY PATH differs.
//
// The bundled Claude Code client only scans `.claude/skills`. Rather than patch its
// (minified) loader, AnyModel bridges at LAUNCH time: discover foreign-ecosystem
// skills, symlink each into a per-session temp `.claude/skills` shadow, and pass
// `--add-dir <shadow>` — the client already scans the `.claude/skills` of every
// added directory, so its native SKILL.md reader + progressive disclosure handle
// everything. Zero format translation. Works for the bundled client and stock `claude`.

import {
  existsSync, readdirSync, statSync, lstatSync, realpathSync,
  mkdtempSync, mkdirSync, symlinkSync, rmSync,
} from 'fs';
import { join, isAbsolute, resolve, sep } from 'path';
import { tmpdir } from 'os';

// Directory-symlink type: 'junction' on Windows (needs no privilege), else 'dir'.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// Conventional foreign skill roots (relative to a base dir), in precedence order.
export const FOREIGN_SKILL_DIRS = [
  '.agents/skills', // cross-tool interop convention (Codex, Cursor, Copilot, Goose, Gemini CLI)
  '.codex/skills',  // OpenAI Codex
  '.gemini/skills', // Gemini CLI
  '.agent/skills',  // Google Antigravity (singular)
];

// Default fs surface — injectable so the pure logic is testable without touching disk.
const realFs = {
  existsSync, readdirSync, statSync, lstatSync, realpathSync,
  mkdtempSync, mkdirSync, symlinkSync, rmSync,
};

/**
 * Resolve absolute roots to scan: FOREIGN_SKILL_DIRS under cwd then $HOME, plus any
 * colon-separated ANYMODEL_SKILL_ROOTS resolved to absolute (relative entries against
 * cwd — a relative root would otherwise produce a broken symlink). De-duped, order
 * preserved. Pure (no fs).
 */
export function resolveForeignSkillRoots({ cwd, homeDir = '', env = {} } = {}) {
  const roots = [];
  if (cwd) for (const d of FOREIGN_SKILL_DIRS) roots.push(join(cwd, d));
  if (homeDir) for (const d of FOREIGN_SKILL_DIRS) roots.push(join(homeDir, d));
  const extra = env.ANYMODEL_SKILL_ROOTS;
  if (extra) {
    for (const r of String(extra).split(':').map(s => s.trim()).filter(Boolean)) {
      roots.push(isAbsolute(r) ? r : resolve(cwd || '.', r));
    }
  }
  return [...new Set(roots)];
}

/**
 * Discover skills under the given roots. Each entry: a directory `<root>/<name>` that
 * contains a `SKILL.md`. Optional Codex sidecar `<dir>/agents/openai.yaml` is noted.
 * fs is injectable for testing. Order: roots in order, names in directory order.
 * @returns {{name, root, dir, skillMdPath, sidecarPath: string|null}[]}
 */
export function discoverForeignSkills(roots, fs = realFs) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // Canonicalize for dedup so an aliased/symlinked root (e.g. cwd === a symlink to
    // $HOME) doesn't double-discover and produce misleading "duplicate name" shadows.
    let canonRoot = root;
    try { canonRoot = fs.realpathSync(root); } catch { /* keep raw on failure */ }
    if (seen.has(canonRoot)) continue;
    seen.add(canonRoot);
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = join(root, name);
      let lst;
      try { lst = fs.lstatSync(dir); } catch { continue; }
      if (lst.isSymbolicLink()) {
        // Containment: a symlinked entry must resolve INSIDE the scanned root.
        // Otherwise a `.codex/skills/x -> /Users/me/.ssh` link in an untrusted repo
        // would be --add-dir'd and exposed to the driven model. Skip escapers.
        let target;
        try { target = fs.realpathSync(dir); } catch { continue; }
        if (target !== canonRoot && !target.startsWith(canonRoot + sep)) continue;
      } else if (!lst.isDirectory()) {
        continue;
      }
      const skillMdPath = join(dir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const sidecarPath = join(dir, 'agents', 'openai.yaml');
      found.push({
        name, root, dir, skillMdPath,
        sidecarPath: fs.existsSync(sidecarPath) ? sidecarPath : null,
      });
    }
  }
  return found;
}

/**
 * Plan which discovered skills to link. A project-local `.claude/skills/<name>` wins
 * (foreign same-name shadowed). Among foreign skills, the first occurrence of a `name`
 * wins; later duplicates are shadowed. Both shadow reasons are recorded. Pure.
 * @returns {{link: object[], shadowed: object[]}}
 */
export function planSkillBridge(discovered, projectSkillNames = []) {
  // Keys are lower-cased: the symlink shadow lives on a possibly case-INSENSITIVE FS
  // (macOS APFS, Windows NTFS), where 'Foo' and 'foo' collide. Normalizing here turns
  // that collision into a LOGGED shadow instead of a swallowed EEXIST at symlink time.
  const project = new Set(projectSkillNames.map(n => n.toLowerCase()));
  const claimed = new Set();
  const link = [], shadowed = [];
  for (const s of discovered) {
    const key = s.name.toLowerCase();
    if (project.has(key)) { shadowed.push({ ...s, reason: 'shadowed by project .claude/skills' }); continue; }
    if (claimed.has(key)) { shadowed.push({ ...s, reason: 'shadowed by earlier root (duplicate name)' }); continue; }
    claimed.add(key);
    link.push(s);
  }
  return { link, shadowed };
}

/**
 * Materialize the bridge: a temp dir with `.claude/skills/<name>` symlinks → skill dirs.
 * Unlinkable entries are recorded in `skipped` (with the errno) rather than silently
 * dropped — so callers can surface e.g. Windows-without-symlink-privilege. Returns null
 * if there was nothing to link; if links were planned but ALL failed, the temp dir is
 * removed and `bridgeDir` is null (no orphan). I/O (fs + tmpBase injectable).
 * @returns {{bridgeDir: string|null, linked: string[], skipped: {name,code}[]}|null}
 */
export function materializeSkillBridge(plan, { tmpBase = tmpdir(), fs = realFs } = {}) {
  if (!plan || !plan.link || !plan.link.length) return null;
  const bridgeDir = fs.mkdtempSync(join(tmpBase, 'anymodel-skills-'));
  const skillsDir = join(bridgeDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const linked = [], skipped = [];
  for (const s of plan.link) {
    try {
      fs.symlinkSync(s.dir, join(skillsDir, s.name), LINK_TYPE);
      linked.push(s.name);
    } catch (e) {
      skipped.push({ name: s.name, code: (e && e.code) || 'ELINK' });
    }
  }
  if (!linked.length) {
    // Everything failed — don't leak the temp dir we just created.
    try { fs.rmSync(bridgeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { bridgeDir: null, linked, skipped };
  }
  return { bridgeDir, linked, skipped };
}

/**
 * Read the names of project-local skills (`<cwd>/.claude/skills/<name>/SKILL.md`) so
 * the bridge can let them win on a name collision. Best-effort. fs injectable.
 */
export function readProjectSkillNames(cwd, fs = realFs) {
  const dir = join(cwd, '.claude', 'skills');
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(name => {
    try {
      return fs.statSync(join(dir, name)).isDirectory() && fs.existsSync(join(dir, name, 'SKILL.md'));
    } catch { return false; }
  });
}

/**
 * End-to-end: resolve roots → discover → plan (with project precedence) → materialize.
 * Returns the full picture so callers can log discovery + shadowing. fs injectable.
 */
export function buildSkillBridge({ cwd, homeDir = '', env = {} } = {}, fs = realFs, { tmpBase } = {}) {
  const roots = resolveForeignSkillRoots({ cwd, homeDir, env });
  const discovered = discoverForeignSkills(roots, fs);
  const projectSkillNames = cwd ? readProjectSkillNames(cwd, fs) : [];
  const plan = planSkillBridge(discovered, projectSkillNames);
  const bridge = materializeSkillBridge(plan, { tmpBase, fs });
  return { roots, discovered, plan, bridge };
}
