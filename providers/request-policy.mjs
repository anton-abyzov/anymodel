// Pure request policy shared by the Node proxy and Cloudflare Worker.
// A :free suffix alone cannot constrain presets, alternate models or server tools.
// OpenRouter's documented provider ceiling covers prompt/completion/request/image:
// https://openrouter.ai/docs/guides/routing/provider-selection#max-price
// Additional billable plugins/server tools are intentionally unsupported here.
const REQUEST_FIELDS = new Set(`model messages input instructions system max_tokens
  max_completion_tokens max_output_tokens stream stream_options temperature top_p top_k
  min_p top_a frequency_penalty presence_penalty repetition_penalty seed stop stop_sequences
  tools tool_choice parallel_tool_calls functions function_call response_format text
  reasoning reasoning_effort reasoningEffort thinking output_config verbosity logprobs top_logprobs usage
  logit_bias n user metadata session_id trace cache_control prompt_cache_key
  prompt_cache_retention safety_identifier store truncation include service_tier
  provider modalities betas context_management speed`.split(/\s+/));
const PROVIDER_FIELDS = new Set(`order only ignore quantizations sort require_parameters
  data_collection zdr enforce_distillable_text preferred_min_throughput
  preferred_max_latency allow_fallbacks max_price`.split(/\s+/));
const PRICE_FIELDS = ['prompt', 'completion', 'request', 'image'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const deny = reason => `Free-only policy: ${reason}. No upstream request was sent. Disable free-only mode to use this option.`;

export function isExplicitFreeModel(model) {
  // Reject preset references and composed variants such as :online:free. Both
  // can add paid services despite ending in the canonical free suffix.
  return model === 'openrouter/free' || (typeof model === 'string' && /^[\w.-]+\/[\w.-]+:free$/.test(model));
}

function isClientTool(tool) {
  if (!isObject(tool)) return false;
  if (tool.type === 'function') return typeof (tool.function?.name ?? tool.name) === 'string';
  return (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string';
}

function hasFileInput(body) {
  // Files/documents can trigger chargeable parsing without an explicit plugin.
  // Only inspect input content, never custom-tool schemas or JSON arguments.
  const contentHasFile = content => Array.isArray(content) && content.some(block =>
    isObject(block) && (['file', 'input_file', 'document'].includes(block.type) ||
      (block.type === 'tool_result' && contentHasFile(block.content))));
  return [body.messages, body.input].some(items => Array.isArray(items) && items.some(item =>
    isObject(item) && (['file', 'input_file', 'document'].includes(item.type) || contentHasFile(item.content))));
}

// Returns an explicit error without mutating rejected requests. In paid mode this
// is a no-op, preserving the provider's complete request semantics.
export function applyFreeRequestPolicy(body, { freeOnly = false, provider = 'openrouter' } = {}) {
  if (!freeOnly) return null;
  if (provider !== 'openrouter') return deny('hosted cost enforcement requires the OpenRouter provider');
  if (!isObject(body) || !isExplicitFreeModel(body.model)) return deny('an explicit :free model or openrouter/free is required');
  for (const key of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(key)) return deny(`request option "${key}" is not supported`);
  }
  // OpenCode's OpenRouter adapter sends these harmless extension fields.
  if (body.reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoningEffort)) return deny('unsupported reasoning effort');
  if (body.usage !== undefined && (!isObject(body.usage) || Object.keys(body.usage).some(key => key !== 'include') || typeof body.usage.include !== 'boolean')) return deny('unsupported usage options');
  if (body.service_tier != null && body.service_tier !== 'default') return deny('non-default service tiers are not supported');
  if (body.modalities != null && (!Array.isArray(body.modalities) || body.modalities.some(m => m !== 'text'))) return deny('only text output is supported');
  if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(isClientTool))) return deny('only caller-executed custom/function tools are supported');
  if (body.functions != null && (!Array.isArray(body.functions) || body.functions.some(f => !isObject(f) || typeof f.name !== 'string'))) return deny('only caller-executed functions are supported');
  if (body.tool_choice != null) {
    const choice = body.tool_choice;
    if (typeof choice === 'string' ? !['auto', 'none', 'any', 'required'].includes(choice) :
      !isObject(choice) || !['auto', 'none', 'any', 'required', 'tool', 'function', 'custom'].includes(choice.type)) return deny('server tool choices are not supported');
  }
  if (hasFileInput(body)) return deny('file/document processing may incur separate charges');
  const preference = body.provider ?? {};
  if (!isObject(preference)) return deny('provider preferences must be an object');
  for (const key of Object.keys(preference)) {
    if (!PROVIDER_FIELDS.has(key)) return deny(`provider option "${key}" is not supported`);
  }
  if (preference.allow_fallbacks !== undefined && preference.allow_fallbacks !== false) return deny('provider fallback must be disabled');
  if (preference.max_price !== undefined && (!isObject(preference.max_price) ||
      Object.entries(preference.max_price).some(([key, value]) => !PRICE_FIELDS.includes(key) || value !== 0))) return deny('provider price limits must be zero');
  // Do not silently drop caller settings: conflicting settings were rejected;
  // safe provider restrictions remain intact under these additional constraints.
  body.provider = { ...preference, allow_fallbacks: false, max_price: Object.fromEntries(PRICE_FIELDS.map(key => [key, 0])) };
  return null;
}
