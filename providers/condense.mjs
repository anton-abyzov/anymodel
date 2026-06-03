// providers/condense.mjs — increment 0013 (US-005).
// Plan-state-aware message-history condensing for local providers. The old proxy logic
// kept head+tail and replaced the dropped middle with a semantically-empty
// "[Earlier conversation condensed]" filler. That could drop the turn where plan mode
// was established, so a weak local model loses the plan and re-enters plan mode in a
// loop. This version (a) never drops a plan-mode turn (or the assistant turn that
// follows it), and (b) replaces each dropped run with a short STRUCTURED summary
// (turn count + tool names) instead of empty filler. Pure + dependency-free.

const PLAN_RE = /(?:enter|exit)_?plan_?mode/i;

function msgChars(m) {
  if (!m) return 0;
  if (typeof m.content === 'string') return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((s, b) => s + ((b && b.text) || (b && b.input ? JSON.stringify(b.input) : '')).length, 0);
  }
  return 0;
}

// A turn establishes/uses plan mode if it carries an Enter/ExitPlanMode tool_use block.
export function isPlanTurn(m) {
  if (!m || !Array.isArray(m.content)) return false;
  return m.content.some(b => b && b.type === 'tool_use' && PLAN_RE.test(b.name || ''));
}

function toolNamesIn(m) {
  if (!m || !Array.isArray(m.content)) return [];
  return m.content.filter(b => b && b.type === 'tool_use' && b.name).map(b => b.name);
}

/**
 * Condense a messages array to fit ~maxChars, preserving plan-mode turns.
 * @returns {{ messages: any[], dropped: number }} — new array (input is not mutated).
 */
export function condenseMessages(messages, { maxChars = 16000 } = {}) {
  if (!Array.isArray(messages) || messages.length <= 4) return { messages, dropped: 0 };
  const n = messages.length;
  const total = messages.reduce((s, m) => s + msgChars(m), 0);
  if (total <= maxChars) return { messages, dropped: 0 };

  const keep = Math.max(4, Math.min(n, Math.floor(maxChars / (total / n))));
  if (keep >= n) return { messages, dropped: 0 };

  // Must-keep indices: head (first 2), tail (last keep-2), and every plan-mode turn plus
  // the assistant turn that immediately follows it (carries the plan / its tool_result).
  const mustKeep = new Set([0, 1]);
  for (let i = Math.max(2, n - (keep - 2)); i < n; i++) mustKeep.add(i);
  for (let i = 0; i < n; i++) {
    if (isPlanTurn(messages[i])) { mustKeep.add(i); if (i + 1 < n) mustKeep.add(i + 1); }
  }

  const out = [];
  let dropped = 0;
  let runCount = 0;
  let runTools = [];
  const flushRun = () => {
    if (!runCount) return;
    const toolsStr = [...new Set(runTools)].slice(0, 8).join(', ');
    out.push({
      role: 'user',
      content: `[Condensed ${runCount} earlier turn${runCount > 1 ? 's' : ''}${toolsStr ? `; tools used: ${toolsStr}` : ''}]`,
    });
    dropped += runCount;
    runCount = 0;
    runTools = [];
  };
  for (let i = 0; i < n; i++) {
    if (mustKeep.has(i)) { flushRun(); out.push(messages[i]); }
    else { runCount++; runTools.push(...toolNamesIn(messages[i])); }
  }
  flushRun();
  return { messages: out, dropped };
}
