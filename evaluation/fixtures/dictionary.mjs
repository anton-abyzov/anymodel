export const INTERNAL_EFFORT_FIELD = '__anymodel_effort';

export function copyInternalEffort(source, target) {
  if (source?.[INTERNAL_EFFORT_FIELD] === undefined || !target) return target;
  Object.defineProperty(target, INTERNAL_EFFORT_FIELD, {
    value: source[INTERNAL_EFFORT_FIELD],
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

export function sanitizeBody(body, { keepCache = false } = {}) {
  const effort = body.output_config?.effort;
  if (effort !== undefined) {
    copyInternalEffort({ [INTERNAL_EFFORT_FIELD]: effort }, body);
  }
  delete body.betas;
  delete body.metadata;
  delete body.speed;
  delete body.output_config;
  delete body.context_management;
  // Keep body.thinking — OpenRouter passes it to reasoning models (DeepSeek R1, etc.)
  // to enable visible chain-of-thought. Only strip for providers that reject it.

  // Clamp max_tokens / max_output_tokens: OpenAI/GPT require >= 16
  // OpenRouter translates max_tokens → max_output_tokens for GPT models
  if (body.max_tokens != null && body.max_tokens < 16) {
    body.max_tokens = 16;
  }
  if (body.max_output_tokens != null && body.max_output_tokens < 16) {
    body.max_output_tokens = 16;
  }

  // Strip cache_control from system/message/tool blocks (only for providers that don't support it)
  if (!keepCache) {
    if (Array.isArray(body.system)) {
      body.system = body.system.map(block => {
        if (block && typeof block === 'object' && block.cache_control) {
          const { cache_control, ...rest } = block;
          return rest;
        }
        return block;
      });
    }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.map(block => {
            if (block && typeof block === 'object' && block.cache_control) {
              const { cache_control, ...rest } = block;
              return rest;
            }
            return block;
          });
        }
      }
    }
  }

  // Strip Anthropic-only tool fields and fix empty input_schema.properties
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
      const stripFields = keepCache
        ? { defer_loading: true, eager_input_streaming: true, strict: true }
        : { cache_control: true, defer_loading: true, eager_input_streaming: true, strict: true };
      const rest = { ...tool };
      for (const key of Object.keys(stripFields)) delete rest[key];

      // Fix schemas that OpenAI/strict-mode parsers reject:
      // 1. Missing input_schema entirely
      // 2. Missing or empty properties
      // Use the standard JSON-Schema "empty object" form — {type:"object", properties:{}, additionalProperties:false}
      // This is accepted by OpenAI, Groq, Together, vLLM, LMStudio, Ollama, and real
      // tool params named `_unused` are preserved end-to-end (US-004 fix, 1.12.0).
      const emptyObjectSchema = () => ({ type: 'object', properties: {}, additionalProperties: false });
      if (!rest.input_schema || typeof rest.input_schema !== 'object') {
        rest.input_schema = emptyObjectSchema();
      } else {
        if (!rest.input_schema.type) {
          rest.input_schema.type = 'object';
        }
        if (rest.input_schema.type === 'object') {
          const props = rest.input_schema.properties;
          if (!props || (typeof props === 'object' && Object.keys(props).length === 0)) {
            rest.input_schema.properties = {};
            rest.input_schema.additionalProperties = false;
            if (!Array.isArray(rest.input_schema.required)) rest.input_schema.required = [];
          }
        }
      }

      // Recursively fix nested schemas (anyOf, oneOf, allOf, items)
      const fixNested = (schema) => {
        if (!schema || typeof schema !== 'object') return;
        for (const key of ['anyOf', 'oneOf', 'allOf']) {
          if (Array.isArray(schema[key])) {
            schema[key].forEach(fixNested);
          }
        }
        if (schema.items) fixNested(schema.items);
        if (schema.type === 'object' && schema.properties) {
          if (Object.keys(schema.properties).length === 0) {
            schema.additionalProperties = false;
            if (!Array.isArray(schema.required)) schema.required = [];
          }
          for (const v of Object.values(schema.properties)) fixNested(v);
        }
      };
      fixNested(rest.input_schema);

      return rest;
    });
  }

  // Normalize tool_choice: providers expect object, clients may send string
  if (typeof body.tool_choice === 'string') {
    body.tool_choice = { type: body.tool_choice };
  }

  return body;
}
