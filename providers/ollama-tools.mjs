// Ollama tool capability cache and mode detection.
// Controls whether tools are passed through to Ollama models or stripped.

const VALID_MODES = new Set(['auto', 'on', 'off']);

// Per-model capability cache: model name → supports tools (boolean)
export const toolCache = new Map();

// Read OLLAMA_TOOLS env var: 'auto' (default) | 'on' | 'off'
export function ollamaToolMode() {
  const raw = (process.env.OLLAMA_TOOLS || 'auto').toLowerCase();
  return VALID_MODES.has(raw) ? raw : 'auto';
}

// Should we send tools to this model?
// - off: never
// - on: always
// - auto: check cache, optimistic on miss (try with tools)
export function shouldSendTools(model) {
  const mode = ollamaToolMode();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  // auto: check cache, default to true (optimistic — try with tools)
  if (toolCache.has(model)) return toolCache.get(model);
  return true;
}

// Cache whether a model supports tools
export function cacheToolResult(model, supported) {
  toolCache.set(model, supported);
}

// Detect tool-unsupported error patterns in Ollama/provider error responses
export function isToolError(errBody) {
  if (!errBody) return false;
  const lower = errBody.toLowerCase();
  return lower.includes('does not support tools')
    || lower.includes('support tool use')
    || lower.includes('tools are not supported');
}
