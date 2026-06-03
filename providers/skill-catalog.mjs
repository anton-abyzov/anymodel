// providers/skill-catalog.mjs — increment 0010 (local skill-fidelity).
//
// Claude Code injects its skill catalog as a <system-reminder> in the first user
// message. On local providers AnyModel strips that block for latency, which kills
// skill auto-trigger. These pure, dependency-free helpers let proxy.mjs re-inject a
// compact, budgeted, DETERMINISTIC (name-sorted, date-free) skill index + a curated
// behavioral core into the system prefix — so a tool-capable local model knows which
// skills exist and that matching one is a blocking precondition, while the block stays
// byte-stable for prefix-cache (KV) reuse.
//
// Increment 0016 adds project-SCOPING: on local providers the default index is
// restricted to the project's own .claude/skills + a workflow-core, keeping it small
// and query-independent (cacheable) instead of injecting ~30 irrelevant global skills.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CATALOG_HEADER = 'The following skills are available for use with the Skill tool:';

// "- name: rest" where name may be namespaced with a colon (e.g. sw:do). The name is
// non-greedy so it stops at the first colon FOLLOWED by whitespace, not the inner one.
const SKILL_LINE = /^-\s+([A-Za-z0-9_][\w:.-]*?):\s+(.+)$/;

const HEADER_LINE =
  'Available skills (call the Skill tool when a request matches — matching is a BLOCKING REQUIREMENT, call Skill FIRST):';

// Curated SpecWeave workflow essentials always kept in project scope (small + stable).
// Overridable via the caller's alwaysInclude (LOCAL_SKILL_ALWAYS). Keeps the local index
// relevant + cacheable instead of injecting ~30 irrelevant global skills every turn (0016).
export const WORKFLOW_CORE = [
  'sw:increment', 'sw:do', 'sw:done', 'sw:pm', 'sw:architect',
  'sw:grill', 'sw:validate', 'sw:progress', 'sw:brainstorm', 'sw:code-reviewer',
];

const _projectSkillMemo = new Map(); // dir -> string[]

/**
 * Names of project-local skills under `<dir>/.claude/skills/<name>/SKILL.md`. Memoized
 * per dir (one fs read per project dir, not per request). Best-effort: returns [] on a
 * missing/unreadable dir, never throws. (0016)
 */
export function readProjectSkillNames(dir) {
  if (!dir) return [];
  if (_projectSkillMemo.has(dir)) return _projectSkillMemo.get(dir);
  let names = [];
  try {
    const skillsDir = join(dir, '.claude', 'skills');
    if (existsSync(skillsDir)) {
      names = readdirSync(skillsDir).filter(n => {
        try { return statSync(join(skillsDir, n)).isDirectory() && existsSync(join(skillsDir, n, 'SKILL.md')); }
        catch { return false; }
      });
    }
  } catch { names = []; }
  _projectSkillMemo.set(dir, names);
  return names;
}

/** Test hook: clear the project-skill memo. */
export function _resetProjectSkillMemo() { _projectSkillMemo.clear(); }

// ── Per-session skill-catalog cache (0013 / US-001) ──
// Claude Code injects the catalog <system-reminder> on the FIRST turn; later turns can
// arrive without it. We cache the harvested catalog keyed by a stable session signature
// (opening user prompt with reminder-tags stripped + the tool-name set) and re-inject on
// turn 2+ so skills keep auto-triggering. Bounded by size + TTL.
const SESSION_CACHE = new Map(); // key -> { skills, ts }
const CACHE_MAX = 200;
const CACHE_TTL_MS = 30 * 60 * 1000;

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Earliest user prompt with catalog/xml reminder blocks stripped, so the key is stable
// whether or not THIS turn still carries the catalog.
function firstUserNormalized(messages) {
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    let t = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ') : '';
    if (!t) continue;
    t = t.replace(/<(?:system-reminder|functions|function)>[\s\S]*?<\/(?:system-reminder|functions|function)>/gi, '').trim();
    if (t) return t;
  }
  return '';
}

function sessionKey(messages, tools) {
  const first = firstUserNormalized(messages).slice(0, 2000);
  if (!first) return '';
  const toolNames = Array.isArray(tools) ? tools.map(t => t && t.name).filter(Boolean).sort().join(',') : '';
  return djb2(first + '|' + toolNames);
}

function cacheSet(key, skills) {
  if (!key || !skills || !skills.length) return;
  SESSION_CACHE.set(key, { skills, ts: Date.now() });
  while (SESSION_CACHE.size > CACHE_MAX) {
    SESSION_CACHE.delete(SESSION_CACHE.keys().next().value); // FIFO evict oldest
  }
}

function cacheGet(key) {
  const e = key && SESSION_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { SESSION_CACHE.delete(key); return null; }
  return e.skills;
}

/** Test hooks (not used by production paths). */
export function _resetSkillCatalogCache() { SESSION_CACHE.clear(); }
export function _skillCatalogCacheSize() { return SESSION_CACHE.size; }

// Cheap presence check: does the request still carry the Claude Code skill catalog?
export function hasSkillCatalog(messages) {
  return flattenText(messages).includes(CATALOG_HEADER);
}

// US-001 self-check: re-injection is OFF (LOCAL_FIDELITY=lean) yet the request carries a
// Skill tool + catalog → the proxy is about to strip skills without restoring them (the
// 1.14.1 trim-without-restore failure mode). Pure; the proxy adds the once-guard + log.
export function shouldWarnTrimWithoutRestore({ fidelity, hasSkillTool, catalogPresent } = {}) {
  return fidelity === 'lean' && Boolean(hasSkillTool) && Boolean(catalogPresent);
}

function flattenText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

// Drop the " - whenToUse" tail that Claude Code appends to skill descriptions, then
// clamp. Em-dashes (—) inside descriptions are not hyphens, so they don't match " - ".
function cleanDesc(rest, descChars, keepWhenToUse) {
  let desc = rest.trim();
  if (!keepWhenToUse) {
    const cut = desc.search(/\s-\s/);
    if (cut > 0) desc = desc.slice(0, cut).trim();
  }
  if (desc.length > descChars) desc = desc.slice(0, descChars).trimEnd();
  return desc;
}

/**
 * Harvest the skill catalog from a messages array (string content + text blocks).
 * @returns {{ skills: {name:string, desc:string}[], rawCount:number }}
 */
export function harvestSkillCatalog(messages, { descChars = 140, keepWhenToUse = false } = {}) {
  const text = flattenText(messages);
  const headerIdx = text.indexOf(CATALOG_HEADER);
  if (headerIdx === -1) return { skills: [], rawCount: 0 };

  const after = text.slice(headerIdx + CATALOG_HEADER.length);
  const skills = [];
  let started = false;
  for (const line of after.split('\n')) {
    if (line.includes('</system-reminder>')) break;
    const m = line.match(SKILL_LINE);
    if (m) {
      started = true;
      skills.push({ name: m[1], desc: cleanDesc(m[2], descChars, keepWhenToUse) });
    } else if (started && line.trim() === '') {
      break; // blank line after the bullet list ends the catalog
    }
  }
  return { skills, rawCount: skills.length };
}

function priority(name, projectSkills) {
  if (/^sw:/.test(name)) return 0;            // SpecWeave core workflow
  if (projectSkills.includes(name)) return 0; // project-local skills
  return 1;
}

function scoreRelevance(skill, queryWords) {
  if (!queryWords.length) return 0;
  const hay = (skill.name + ' ' + skill.desc).toLowerCase();
  let score = 0;
  for (const w of queryWords) if (w.length > 2 && hay.includes(w)) score++;
  return score;
}

/**
 * Compress a harvested catalog to a budgeted, name-sorted index block.
 * Keeps sw:* + project skills first, ranks the rest by query relevance, fills within
 * budgetChars, degrades to names-only when a full line won't fit, drops the overflow.
 * @returns {{ block:string, kept:number, dropped:number }}
 */
export function selectSkills(skills, { budgetChars = 4000, query = '', fidelity = 'balanced', projectSkills = [] } = {}) {
  if (!skills || skills.length === 0) return { block: '', kept: 0, dropped: 0 };

  const queryWords = (query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // Rank: priority tier, then relevance, then name (stable deterministic tiebreak).
  const ranked = [...skills].sort((a, b) => {
    const pa = priority(a.name, projectSkills), pb = priority(b.name, projectSkills);
    if (pa !== pb) return pa - pb;
    const ra = scoreRelevance(a, queryWords), rb = scoreRelevance(b, queryWords);
    if (ra !== rb) return rb - ra;
    return a.name.localeCompare(b.name);
  });

  let used = HEADER_LINE.length + 1;
  const chosen = [];
  for (const s of ranked) {
    const full = `- ${s.name}: ${s.desc}`;
    const nameOnly = `- ${s.name}`;
    if (used + full.length + 1 <= budgetChars) {
      chosen.push({ name: s.name, line: full });
      used += full.length + 1;
    } else if (used + nameOnly.length + 1 <= budgetChars) {
      chosen.push({ name: s.name, line: nameOnly });
      used += nameOnly.length + 1;
    }
  }

  if (chosen.length === 0) return { block: '', kept: 0, dropped: skills.length };

  // Display order is name-sorted (selection was relevance-based) → byte-stable prefix.
  chosen.sort((a, b) => a.name.localeCompare(b.name));
  const block = [HEADER_LINE, ...chosen.map(c => c.line)].join('\n');
  return { block, kept: chosen.length, dropped: skills.length - chosen.length };
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const t = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ') : '';
    if (t) return t;
  }
  return '';
}

/**
 * The full decision: given a request's messages, produce the deterministic string to
 * append to the system prefix (behavioral core + budgeted skill index), or '' for lean.
 * Pure — the proxy passes resolved env values in. Returns rawCount so the caller can
 * warn when the Skill tool is present but the catalog header drifted (harvest empty).
 * @returns {{ addition:string, injected:number, rawCount:number }}
 */
export function buildFidelityAddition(messages, {
  fidelity = 'balanced',
  skillIndexMode = 'auto',
  descChars = 140,
  numCtx = 32768,
  systemPct = 0.08,
  scope = null,          // 'project' | 'all'; null → derive (full→all, else→project) (0016)
  projectDir = null,     // where to read .claude/skills for project scope
  alwaysInclude = null,  // names always kept in project scope; null → WORKFLOW_CORE
  tools = null,          // tool defs — part of the session-cache key (0013/US-001)
} = {}) {
  if (fidelity === 'lean') return { addition: '', injected: 0, rawCount: 0 };
  const effScope = scope || (fidelity === 'full' ? 'all' : 'project');
  const always = alwaysInclude || WORKFLOW_CORE;

  let block = '';
  let injected = 0;
  let rawCount = 0;
  if (skillIndexMode !== 'off' && Array.isArray(messages)) {
    const dc = descChars * (fidelity === 'full' ? 2 : 1);
    const harvested = harvestSkillCatalog(messages, { descChars: dc, keepWhenToUse: fidelity === 'full' });
    rawCount = harvested.rawCount;

    // 0013/US-001: cache the RAW catalog on turn 1 (Claude Code sends it once); restore on
    // turn 2+ when this turn arrives without it, so skills survive the whole session. The
    // 0016 project-scoping filter below then applies identically to harvested or cached skills.
    const key = sessionKey(messages, tools);
    let skills = harvested.skills;
    if (skills.length) cacheSet(key, skills);
    else { const cached = cacheGet(key); if (cached) skills = cached; }

    const projectSkills = effScope === 'project' ? readProjectSkillNames(projectDir) : [];
    if (effScope === 'project') {
      // Restrict to project skills + workflow-core → small AND query-independent (cacheable),
      // instead of injecting the whole global catalog every turn.
      const allow = new Set([...projectSkills, ...always].map(s => s.toLowerCase()));
      skills = skills.filter(s => allow.has(s.name.toLowerCase()));
    }

    if (skills.length) {
      const ctxBudgetChars = Math.floor(numCtx * systemPct) * 4;
      const budgetChars = effScope === 'project'
        ? 1500                                                   // tight, stable
        : (fidelity === 'full'
            ? Math.min(Math.max(ctxBudgetChars, 4000), 16000)
            : Math.min(4000, Math.max(ctxBudgetChars, 2000)));
      const sel = selectSkills(skills, {
        budgetChars,
        // project scope is query-INDEPENDENT so the block stays in the cacheable prefix.
        query: effScope === 'project' ? '' : latestUserText(messages),
        fidelity,
        projectSkills,
      });
      if (sel.block) { block = sel.block; injected = sel.kept; }
    }
  }

  // Build the behavioral core AFTER we know whether a skill block exists, so US-001's
  // "available skills listed below" reference is not dangled when none is injected.
  const parts = [];
  const core = buildBehavioralCore(fidelity, { hasSkills: Boolean(block) });
  if (core) parts.push(core);
  if (block) parts.push(block);
  return { addition: parts.join('\n\n'), injected, rawCount };
}

/**
 * Curated, date-free Claude Code behavioral core. ~600-900 tokens; lean → ''.
 */
export function buildBehavioralCore(fidelity = 'balanced', { hasSkills = true } = {}) {
  if (fidelity === 'lean') return '';
  const core = [
    'You are an agentic coding assistant operating through the Claude Code tool protocol.',
    'Be terse and direct. Lead with the answer. Use the tools available to you rather than describing what you would do.',
    'Plan before acting on multi-step work; satisfy dependencies before dependent steps; verify changes before claiming success.',
  ];
  // US-001: only reference the skill index when one will actually follow.
  if (hasSkills) {
    core.push('SKILLS: When a user request matches one of the available skills listed below, calling the Skill tool with that skill name is a BLOCKING REQUIREMENT — call Skill FIRST, before any other response or tool use. "simple", "quick", and "basic" are NOT opt-out phrases.');
  }
  if (fidelity === 'full') {
    core.push('Prefer reusing existing functions and patterns over writing new code. Match the surrounding code style. Never invent file paths or APIs — verify they exist before referencing them.');
  }
  return core.join('\n');
}
