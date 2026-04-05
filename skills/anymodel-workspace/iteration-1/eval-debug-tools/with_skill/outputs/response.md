# Diagnosis: 400 Errors with GPT-5.4 and MCP Tools — Empty Properties in Tool Schema

## Root Cause

The 400 error about "empty properties in the tool schema" is caused by OpenAI (or OpenRouter proxying to OpenAI) rejecting tool definitions that have `properties: {}` in their `input_schema`. Claude Code sends 86+ tool definitions with every request (including MCP tools from Slack, Figma, Gmail, etc.), and many of these tools have empty properties objects because they take no parameters. OpenAI's API strictly rejects `{ "type": "object", "properties": {} }` as an invalid JSON schema.

The AnyModel proxy already has sanitization logic to handle this, so the question is: why is it not working for your case?

## The Full Request Flow for GPT-5.4

When you run `npx anymodel proxy gpt` (or `npx anymodel gpt`):

1. **Preset resolution** (`cli.mjs`, line 23): `gpt` resolves to model `openai/gpt-5.4`
2. **Provider detection** (`cli.mjs`, line 91-92): Because the model contains `/`, `detectProvider()` returns `'openrouter'`
3. **Provider loaded**: `providers/openrouter.mjs` — this is a passthrough Anthropic-format provider, it does NOT have `transformRequest`
4. **Sanitization** (`proxy.mjs`, line 207): `sanitizeBody(parsed, { keepCache: true })` is called because `provider.name === 'openrouter'`

So your request goes: Claude Code -> AnyModel proxy (sanitize) -> OpenRouter -> OpenAI GPT-5.4

## The Sanitization Logic (proxy.mjs, lines 69-117)

The `sanitizeBody()` function handles tool schema fixing in two stages:

### Stage 1: Top-level input_schema fix (lines 81-94)

```javascript
if (!rest.input_schema || typeof rest.input_schema !== 'object') {
  rest.input_schema = { type: 'object', properties: { _unused: { type: 'string' } }, required: [] };
} else {
  if (!rest.input_schema.type) {
    rest.input_schema.type = 'object';
  }
  if (rest.input_schema.type === 'object') {
    const props = rest.input_schema.properties;
    if (!props || (typeof props === 'object' && Object.keys(props).length === 0)) {
      rest.input_schema.properties = { _unused: { type: 'string' } };
      rest.input_schema.required = [];
    }
  }
}
```

This covers:
- Missing `input_schema` entirely -> adds minimal valid schema with `_unused` placeholder
- Empty `properties: {}` at the top level -> adds `_unused` placeholder
- Missing `type` field -> adds `"type": "object"`

### Stage 2: Recursive nested schema fix (lines 97-113)

```javascript
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
      schema.properties = { _unused: { type: 'string' } };
      schema.required = [];
    }
    for (const v of Object.values(schema.properties)) fixNested(v);
  }
};
fixNested(rest.input_schema);
```

This recursively fixes empty `properties: {}` inside nested schemas (`anyOf`, `oneOf`, `allOf`, `items`, and nested object properties).

### Stage 3: Response cleanup (proxy.mjs, lines 379-404)

When the model responds with a tool call, the proxy strips `_unused` from the tool input so the client never sees the placeholder:
- Non-streaming: `delete block.input._unused` (line 385)
- Streaming: regex replacement `/"_unused"\s*:\s*"[^"]*"\s*,?\s*/g` (line 400)

## Why You Are Still Getting 400 Errors

There are several possible scenarios:

### Scenario A: Nested object schema without `type: 'object'` (MOST LIKELY)

The recursive `fixNested` function at line 105 only fixes properties when `schema.type === 'object'`. If an MCP tool has a nested schema like:

```json
{
  "input_schema": {
    "type": "object",
    "properties": {
      "config": {
        "properties": {}
      }
    }
  }
}
```

The nested `config` has `properties: {}` but NO `type` field. The `fixNested` function checks `schema.type === 'object' && schema.properties` (line 105), so it will skip this because `schema.type` is `undefined`. The empty properties pass through to OpenAI/OpenRouter, which rejects them with a 400.

Note: The top-level fix (line 84) does add `type: 'object'` when missing, but the `fixNested` recursive function does NOT add a missing `type` to nested schemas. This is the gap.

**Relevant code**: `proxy.mjs`, lines 105-106:
```javascript
if (schema.type === 'object' && schema.properties) {
  if (Object.keys(schema.properties).length === 0) {
```

The fix would be to also add `type: 'object'` in `fixNested` when a schema has `properties` but no `type`:

```javascript
const fixNested = (schema) => {
  if (!schema || typeof schema !== 'object') return;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach(fixNested);
    }
  }
  if (schema.items) fixNested(schema.items);
  // Add missing type when properties exist (nested schemas)
  if (schema.properties && !schema.type) {
    schema.type = 'object';
  }
  if (schema.type === 'object' && schema.properties) {
    if (Object.keys(schema.properties).length === 0) {
      schema.properties = { _unused: { type: 'string' } };
      schema.required = [];
    }
    for (const v of Object.values(schema.properties)) fixNested(v);
  }
};
```

### Scenario B: Double translation adding empty properties (SECOND MOST LIKELY)

For the `openrouter` provider, the request is sent in Anthropic format (no `transformRequest`). OpenRouter then internally translates for GPT-5.4. If OpenRouter's own translation introduces empty properties, the proxy cannot fix it because the translation happens after the request leaves the proxy.

To rule this out: check the proxy logs for `tools=N` to confirm tools are being sent, and inspect the upstream 400 error body for details about which specific tool schema is invalid.

### Scenario C: OpenAI provider path with secondary empty-properties gap

If you are using `providers/openai.mjs` directly (via `OPENAI_API_KEY` + `OPENAI_BASE_URL`), there is a second layer of tool schema translation in `translateRequest()` at `providers/openai.mjs`, lines 70-96. That code has its own empty-properties fix using `_placeholder` (not `_unused`):

```javascript
if (
  params.type === 'object' &&
  params.properties &&
  typeof params.properties === 'object' &&
  Object.keys(params.properties).length === 0
) {
  params.properties = {
    _placeholder: { type: 'string', description: 'No parameters needed' },
  };
}
```

But this only fixes the top level of the tool parameters, not nested schemas. If `sanitizeBody()` already ran, this should be redundant. But if a tool has a deeply nested empty properties that `sanitizeBody` missed (Scenario A), this second pass also misses it.

## How to Debug Right Now

### Step 1: Check the proxy logs

When the 400 happens, the proxy logs the error body (line 335):
```
[OPENROUTER] 400: <error body excerpt>
```

Look at what the error body says. It will likely name the specific tool or schema path that is invalid.

### Step 2: Capture the full request

Add temporary logging in `proxy.mjs` after `sanitizeBody()` runs (around line 207) to dump the tool schemas:

```javascript
sanitizeBody(parsed, { keepCache });
// Temporary debug: dump tools to see what is being sent
if (parsed.tools) {
  for (const t of parsed.tools) {
    const json = JSON.stringify(t.input_schema);
    if (json.includes('"properties":{}')) {
      console.log(`[DEBUG] Tool "${t.name}" still has empty properties: ${json.slice(0, 200)}`);
    }
  }
}
```

### Step 3: Run existing tests

```bash
node --test test/sanitize.test.mjs
```

The current test suite (`test/sanitize.test.mjs`) does NOT test the nested schema fix for schemas missing the `type` field. The test at line 71 only checks top-level `input_schema: { type: 'object' }` and the recursive fix for `anyOf`/`oneOf`/`allOf` is not tested with missing `type` fields.

## Summary

| Component | File | Lines | What It Does |
|-----------|------|-------|--------------|
| Top-level schema fix | `proxy.mjs` | 81-94 | Adds `_unused` for missing/empty `input_schema` |
| Missing `type` addition | `proxy.mjs` | 84 | Adds `type: 'object'` to top-level only |
| Recursive nested fix | `proxy.mjs` | 97-113 | Fixes nested `anyOf`/`oneOf`/`allOf`/`items` empty properties |
| **Gap**: nested missing `type` | `proxy.mjs` | 105 | `fixNested` requires `type === 'object'`, skips schemas with `properties` but no `type` |
| OpenAI provider fix | `providers/openai.mjs` | 76-86 | Second pass uses `_placeholder`, top-level only |
| Response stripping | `proxy.mjs` | 379-404 | Removes `_unused`/`_placeholder` from tool_use responses |
| Streaming stripping | `proxy.mjs` | 399-401 | Regex removal of placeholders in SSE deltas |
| Anthropic field stripping | `proxy.mjs` | 71-75 | Removes `cache_control`, `defer_loading`, `eager_input_streaming`, `strict` |
| Tool count logging | `proxy.mjs` | 224 | Shows `tools=N` in proxy output for debugging |

The most likely fix is adding `if (schema.properties && !schema.type) schema.type = 'object';` inside the `fixNested` function at `proxy.mjs` line 105, which would close the gap for nested schemas that have `properties` but no explicit `type` field. A corresponding test case should be added to `test/sanitize.test.mjs`.
