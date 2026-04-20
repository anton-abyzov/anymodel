// Smart tool optimization for local models (Ollama).
// Multi-layer pipeline: schema compression → description trimming → context budgeting.
//
// Instead of blindly stripping tools by count, this module:
// 1. Compresses JSON Schema param definitions (50-70% smaller)
// 2. Trims descriptions to first sentence or N chars
// 3. Measures actual compressed token sizes
// 4. Budget-allocates tools by priority tier to fit context window

const CORE = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']);
const IMPORTANT = new Set(['Agent', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'NotebookEdit']);

// Fields worth keeping in JSON Schema for tool calling.
// Everything else ($schema, additionalProperties, description on params,
// default, examples, title, format, pattern) is noise for local models.
const SCHEMA_KEEP = new Set([
  'type', 'properties', 'required', 'enum',
  'items', 'anyOf', 'oneOf', 'allOf',
  'maximum', 'minimum', 'exclusiveMinimum', 'exclusiveMaximum',
  'maxLength', 'minLength', 'maxItems', 'minItems',
]);

/**
 * Compress a JSON Schema by removing fields local models don't need.
 * Keeps: type, properties (name + type), required, enum, numeric bounds, items.
 * Removes: $schema, additionalProperties, description, default, examples, title, format, pattern.
 */
export function compressSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;

  const out = {};

  for (const [key, val] of Object.entries(schema)) {
    if (!SCHEMA_KEEP.has(key)) continue;

    if (key === 'properties' && typeof val === 'object') {
      out.properties = {};
      for (const [prop, propSchema] of Object.entries(val)) {
        out.properties[prop] = compressSchema(propSchema);
      }
    } else if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(val)) {
      if (val.length === 1) {
        // Flatten single-element composition wrapper
        Object.assign(out, compressSchema(val[0]));
      } else {
        out[key] = val.map(s => compressSchema(s));
      }
    } else if (key === 'items') {
      out.items = compressSchema(val);
    } else {
      out[key] = val;
    }
  }

  return out;
}

/**
 * Trim description to maxLen chars, preferring sentence boundary.
 */
export function trimDescription(desc, maxLen = 100) {
  if (!desc || desc.length <= maxLen) return desc || '';
  const sentence = desc.match(/^[^.!?\n]+[.!?]/);
  if (sentence && sentence[0].length <= maxLen) return sentence[0];
  return desc.slice(0, maxLen) + '…';
}

function toolTier(name) {
  if (CORE.has(name)) return 0;
  if (IMPORTANT.has(name)) return 1;
  return 2;
}

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/**
 * Full optimization pipeline.
 *
 * @param {Array} tools - Anthropic-format tools (name, description, input_schema)
 * @param {Object} opts
 * @param {number}  opts.numCtx      - Context window size in tokens (default 8192)
 * @param {number} [opts.maxTools]    - Hard cap on tool count; 0 = auto from budget (default 0)
 * @param {number} [opts.maxDescLen]  - Description trim length (default 100)
 * @param {number} [opts.budgetPct]   - Tool budget as fraction of context (default 0.30)
 * @returns {{ tools: Array, stats: Object }}
 */
export function optimizeTools(tools, opts = {}) {
  const {
    numCtx = 8192,
    maxTools = 0,
    maxDescLen = 100,
    budgetPct = 0.30,
  } = opts;

  if (!tools || tools.length === 0) {
    return { tools: tools || [], stats: null };
  }

  const originalCount = tools.length;
  const originalTokens = estimateTokens(tools);

  // Layer 1 + 2: compress schemas + trim descriptions
  const compressed = tools.map(t => ({
    ...t,
    description: trimDescription(t.description, maxDescLen),
    input_schema: t.input_schema ? compressSchema(t.input_schema) : t.input_schema,
  }));

  const compressedTokens = estimateTokens(compressed);
  const toolBudget = Math.floor(numCtx * budgetPct);
  const cap = maxTools || Infinity;

  // If everything fits, return compressed tools as-is
  if (compressedTokens <= toolBudget && compressed.length <= cap) {
    return {
      tools: compressed,
      stats: {
        original: { count: originalCount, tokens: originalTokens },
        compressed: { count: compressed.length, tokens: compressedTokens },
        final: { count: compressed.length, tokens: compressedTokens },
        budget: { tokens: toolBudget, pct: budgetPct, numCtx },
        trimmed: false,
      },
    };
  }

  // Layer 3: priority-based selection to fit budget
  // Sort: core (0) → important (1) → rest (2), preserving order within tier
  const sorted = [...compressed].sort((a, b) => toolTier(a.name) - toolTier(b.name));

  const selected = [];
  let usedTokens = 0;

  for (const tool of sorted) {
    if (selected.length >= cap) break;
    const tokens = estimateTokens(tool);
    // Always keep core tools; for others, check budget
    if (toolTier(tool.name) > 0 && usedTokens + tokens > toolBudget) break;
    selected.push(tool);
    usedTokens += tokens;
  }

  return {
    tools: selected,
    stats: {
      original: { count: originalCount, tokens: originalTokens },
      compressed: { count: compressed.length, tokens: compressedTokens },
      final: { count: selected.length, tokens: usedTokens },
      budget: { tokens: toolBudget, pct: budgetPct, numCtx },
      trimmed: true,
    },
  };
}
