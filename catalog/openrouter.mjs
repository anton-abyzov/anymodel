// Public API discovery only. No credentials, inference requests or local probes.
export const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
export const MODEL_PRESETS = Object.freeze({
  gpt: 'openai/gpt-5.4',
  codex: 'openai/gpt-5.3-codex',
  gemini: 'google/gemini-3.1-flash-lite-preview',
  deepseek: 'deepseek/deepseek-r1-0528',
  mistral: 'mistralai/devstral-2512',
  gemma: 'google/gemma-4-31b-it',
  qwen: 'qwen/qwen3-coder:free',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b:free',
  llama: 'meta-llama/llama-3.3-70b-instruct:free',
});
export const CATALOG_SCOPE = 'Public OpenRouter API catalog; not account access, live inference availability, coding quality or native subscription entitlement.';

export class CatalogError extends Error {
  constructor(message, code = 'catalog_unavailable') { super(message); this.name = 'CatalogError'; this.code = code; }
}

export function resolveModelSelection(value) {
  return Object.hasOwn(MODEL_PRESETS, value) ? MODEL_PRESETS[value] : value;
}

function nonNegativePrice(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function modelIsFree(model) {
  const pricing = model?.pricing;
  if (!pricing || nonNegativePrice(pricing.prompt) !== 0 || nonNegativePrice(pricing.completion) !== 0) return false;
  return Object.values(pricing).every(value => nonNegativePrice(value) === 0);
}

export function normalizeCatalog(data, checkedAt = new Date().toISOString()) {
  if (!data || !Array.isArray(data.data) || data.data.length === 0) throw new CatalogError('OpenRouter returned an empty or invalid model catalog; availability is unknown.');
  const models = data.data.filter(row => row && typeof row.id === 'string' && row.id.trim()).map(row => ({
    id: row.id,
    name: typeof row.name === 'string' ? row.name : row.id,
    contextLength: Number.isSafeInteger(row.context_length) && row.context_length > 0 ? row.context_length : null,
    supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters.filter(x => typeof x === 'string') : [],
    pricing: row.pricing && typeof row.pricing === 'object' && !Array.isArray(row.pricing) ? row.pricing : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) throw new CatalogError('OpenRouter returned no valid model IDs; availability is unknown.');
  return { source: CATALOG_URL, checkedAt, scope: CATALOG_SCOPE, models };
}

export async function fetchCatalog({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  try {
    const response = await fetchImpl(CATALOG_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw new CatalogError(`OpenRouter catalog returned HTTP ${response.status}; no model was substituted.`);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new CatalogError('OpenRouter catalog exceeded the 8 MiB limit.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return normalizeCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError('Could not verify the public OpenRouter catalog. Retry `anymodel models`; no model was substituted.');
  }
}

export function checkModel(catalog, selection, { freeOnly = false } = {}) {
  const id = resolveModelSelection(selection);
  const model = catalog.models.find(row => row.id === id);
  if (!model) throw new CatalogError(`Model "${id}"${selection !== id ? ` (preset "${selection}")` : ''} is absent from the current OpenRouter catalog. Run \`anymodel models${freeOnly || id?.endsWith(':free') ? ' --free' : ''}\`, then choose an explicit --model ID. No replacement was selected.`, 'model_unavailable');
  const freeAlias = id.endsWith(':free') || id === 'openrouter/free';
  if ((freeOnly || freeAlias) && !modelIsFree(model)) throw new CatalogError(`Model "${id}" is not verified as zero-priced in the current catalog. Choose a currently listed free model explicitly; no paid replacement was selected.`, 'free_model_unverified');
  return { ...model, available: true, checkedAt: catalog.checkedAt, scope: catalog.scope };
}

export function filterModels(catalog, { search = '', freeOnly = false, tools = false } = {}) {
  const term = search.toLowerCase();
  return catalog.models.filter(model => (!term || `${model.id} ${model.name}`.toLowerCase().includes(term)) && (!freeOnly || modelIsFree(model)) && (!tools || model.supportedParameters.includes('tools')));
}

export async function preflightOpenRouterModel(selection, options = {}) {
  return checkModel(await fetchCatalog(options), selection, options);
}

export async function runCatalogCommand(command, args, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  let selection, search = '', json = false, freeOnly = false, tools = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--free' || arg === '--free-only') freeOnly = true;
    else if (arg === '--tools') tools = true;
    else if (arg === '--search' && args[i + 1] && !args[i + 1].startsWith('-')) search = args[++i];
    else if (command === 'check' && !arg.startsWith('-') && selection === undefined) selection = arg;
    else throw new CatalogError(`Unknown or incomplete catalog argument "${arg}". Use anymodel ${command} ${command === 'check' ? '<model-id|preset> ' : ''}[--json] [--free] [--tools] [--search text].`, 'invalid_arguments');
  }
  if (command === 'check' && !selection) throw new CatalogError('Usage: anymodel check <model-id|preset> [--json] [--free]', 'invalid_arguments');
  const catalog = await fetchCatalog({ fetchImpl });
  if (command === 'check') {
    const result = checkModel(catalog, selection, { freeOnly });
    if (tools && !result.supportedParameters.includes('tools')) throw new CatalogError(`Model "${result.id}" does not advertise tools in the public catalog.`, 'tools_unavailable');
    log(json ? JSON.stringify(result, null, 2) : `${result.id}\tlisted\t${modelIsFree(result) ? 'zero-priced' : 'pricing applies or unknown'}\nChecked ${result.checkedAt}. ${result.scope}`);
  } else {
    const models = filterModels(catalog, { search, freeOnly, tools });
    log(json ? JSON.stringify({ ...catalog, models }, null, 2) : `${models.map(model => `${model.id}\t${modelIsFree(model) ? 'zero-priced' : 'priced/unknown'}\t${model.supportedParameters.includes('tools') ? 'tools advertised' : 'tools unknown'}`).join('\n')}\n${models.length} models. Checked ${catalog.checkedAt}. ${catalog.scope}`);
  }
}
