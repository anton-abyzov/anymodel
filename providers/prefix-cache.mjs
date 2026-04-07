import crypto from 'crypto';

const MAX_ENTRIES = 5;
const store = new Map();           // hash -> { system, tools, tokenEstimate, lastUsed }
const lastHashByModel = new Map(); // model -> lastHash

function normalizeForHash(system, tools) {
  const sysNorm = (system || '')
    .replace(/Today: \d{4}-\d{2}-\d{2}/g, 'Today: __DATE__')
    .replace(/# currentDate\n.*?\d{4}-\d{2}-\d{2}/g, '# currentDate\n__DATE__');

  const sortedSigs = (tools || [])
    .map(t => ({ name: t.name, input_schema: t.input_schema }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return sysNorm + '\0' + JSON.stringify(sortedSigs);
}

export function computePrefixHash(system, tools) {
  const canonical = normalizeForHash(system, tools);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function getOrStore(model, system, tools) {
  const hash = computePrefixHash(system, tools);

  let entry = store.get(hash);
  if (entry) {
    entry.lastUsed = Date.now();
  } else {
    entry = {
      system,
      tools,
      tokenEstimate: Math.ceil(((system || '').length + JSON.stringify(tools || []).length) / 4),
      lastUsed: Date.now(),
    };
    store.set(hash, entry);
  }

  const hit = hash === lastHashByModel.get(model);
  lastHashByModel.set(model, hash);

  if (store.size > MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of store) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) store.delete(oldestKey);
  }

  return { system: entry.system, tools: entry.tools, hit, tokenEstimate: entry.tokenEstimate };
}

export function resetCache() {
  store.clear();
  lastHashByModel.clear();
}
