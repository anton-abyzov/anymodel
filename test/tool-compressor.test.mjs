import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compressSchema, trimDescription, optimizeTools } from '../providers/tool-compressor.mjs';

// ── compressSchema ──────────────────────────────────────────────────

describe('compressSchema', () => {
  it('removes $schema and additionalProperties', () => {
    const result = compressSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('removes description, default, examples from properties', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The user name to look up',
          default: 'anonymous',
          examples: ['alice', 'bob'],
        },
      },
      required: ['name'],
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('preserves enum values', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow'], description: 'Speed mode' },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
    });
  });

  it('preserves numeric bounds', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Timeout in ms',
          maximum: 600000,
          minimum: 0,
          exclusiveMinimum: 0,
          default: 120000,
        },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: {
        timeout: { type: 'number', maximum: 600000, minimum: 0, exclusiveMinimum: 0 },
      },
    });
  });

  it('flattens single-element anyOf', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string', description: 'A string value' }],
        },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { value: { type: 'string' } },
    });
  });

  it('keeps multi-element oneOf', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'string', description: 'text' },
            { type: 'number', description: 'numeric' },
          ],
        },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: {
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    });
  });

  it('compresses array items recursively', () => {
    const result = compressSchema({
      type: 'array',
      items: {
        type: 'object',
        description: 'An item',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Unique ID' },
        },
      },
    });
    assert.deepEqual(result, {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    });
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(compressSchema(null), null);
    assert.equal(compressSchema(undefined), undefined);
  });

  it('handles empty schema', () => {
    assert.deepEqual(compressSchema({}), {});
  });

  it('removes title, format, pattern fields', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', title: 'Email Address', pattern: '^.+@.+$' },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { email: { type: 'string' } },
    });
  });

  it('preserves string length bounds', () => {
    const result = compressSchema({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 255, description: 'Username' },
      },
    });
    assert.deepEqual(result, {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
    });
  });
});

// ── trimDescription ─────────────────────────────────────────────────

describe('trimDescription', () => {
  it('returns short descriptions unchanged', () => {
    assert.equal(trimDescription('Hello world', 100), 'Hello world');
  });

  it('trims to first sentence if it fits', () => {
    const desc = 'Execute commands. This tool runs bash commands in the shell environment with full access.';
    assert.equal(trimDescription(desc, 50), 'Execute commands.');
  });

  it('hard truncates when first sentence is too long', () => {
    const desc = 'This is a very long first sentence that goes on and on without any punctuation for quite a while';
    const result = trimDescription(desc, 30);
    assert.equal(result.length, 31); // 30 + '…'
    assert.ok(result.endsWith('…'));
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(trimDescription(null), '');
    assert.equal(trimDescription(undefined), '');
  });

  it('respects custom maxLen', () => {
    const desc = 'Short. But has multiple sentences.';
    assert.equal(trimDescription(desc, 200), desc);
  });
});

// ── optimizeTools ───────────────────────────────────────────────────

describe('optimizeTools', () => {
  // Helper: create a tool with a given schema size
  function makeTool(name, descLen = 200, propCount = 3) {
    const props = {};
    for (let i = 0; i < propCount; i++) {
      props[`param${i}`] = {
        type: 'string',
        description: 'x'.repeat(100),
        default: 'default_value',
        examples: ['example1', 'example2'],
      };
    }
    return {
      name,
      description: 'd'.repeat(descLen),
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        type: 'object',
        properties: props,
        required: ['param0'],
      },
    };
  }

  it('compresses schemas and descriptions even when all tools fit', () => {
    const tools = [makeTool('Bash'), makeTool('Read')];
    const { tools: result, stats } = optimizeTools(tools, { numCtx: 100000 });

    assert.equal(result.length, 2);
    assert.ok(stats.compressed.tokens < stats.original.tokens, 'compressed should be smaller');
    assert.equal(stats.trimmed, false);
    // Verify schema was compressed (no $schema, no additionalProperties)
    assert.equal(result[0].input_schema.$schema, undefined);
    assert.equal(result[0].input_schema.additionalProperties, undefined);
    // Verify descriptions trimmed
    assert.ok(result[0].description.length <= 101); // 100 + '…'
  });

  it('trims tools by priority when over budget', () => {
    // 6 core + 7 important + 50 extras = 63 tools with big schemas
    const tools = [
      ...['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'].map(n => makeTool(n, 200, 8)),
      ...['Agent', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'NotebookEdit'].map(n => makeTool(n, 200, 8)),
      ...Array.from({ length: 50 }, (_, i) => makeTool(`Extra${i}`, 200, 8)),
    ];

    const { tools: result, stats } = optimizeTools(tools, { numCtx: 4096, budgetPct: 0.20 });

    assert.ok(result.length < tools.length, 'should trim some tools');
    assert.ok(stats.trimmed, 'stats should indicate trimming');
    // Core tools always kept
    const names = new Set(result.map(t => t.name));
    for (const core of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']) {
      assert.ok(names.has(core), `core tool ${core} should be kept`);
    }
    // Important tools should come before extras
    const firstExtra = result.findIndex(t => t.name.startsWith('Extra'));
    const lastImportant = result.findLastIndex(t =>
      ['Agent', 'TodoWrite', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'NotebookEdit'].includes(t.name)
    );
    if (firstExtra >= 0 && lastImportant >= 0) {
      assert.ok(lastImportant < firstExtra, 'important tools before extras');
    }
  });

  it('respects explicit maxTools cap', () => {
    const tools = Array.from({ length: 20 }, (_, i) => makeTool(`Tool${i}`, 50, 1));
    const { tools: result } = optimizeTools(tools, { numCtx: 100000, maxTools: 5 });
    assert.equal(result.length, 5);
  });

  it('returns empty tools unchanged', () => {
    const { tools: result, stats } = optimizeTools([]);
    assert.deepEqual(result, []);
    assert.equal(stats, null);
  });

  it('handles null tools', () => {
    const { tools: result, stats } = optimizeTools(null);
    assert.deepEqual(result, []);
    assert.equal(stats, null);
  });

  it('stats report correct budget info', () => {
    const tools = [makeTool('Bash')];
    const { stats } = optimizeTools(tools, { numCtx: 32768, budgetPct: 0.25 });
    assert.equal(stats.budget.numCtx, 32768);
    assert.equal(stats.budget.pct, 0.25);
    assert.equal(stats.budget.tokens, Math.floor(32768 * 0.25));
  });

  it('compression ratio is significant for verbose schemas', () => {
    // Simulate a Claude Code-style tool with huge param descriptions
    const tool = {
      name: 'Bash',
      description: 'Executes a given bash command and returns its output.\n\n' + 'x'.repeat(500),
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute. ' + 'y'.repeat(200) },
          description: { type: 'string', description: 'Clear, concise description. ' + 'z'.repeat(300) },
          timeout: { type: 'number', description: 'Optional timeout in ms.', maximum: 600000 },
          run_in_background: { type: 'boolean', description: 'Set to true to run in background. ' + 'w'.repeat(150) },
          dangerouslyDisableSandbox: { type: 'boolean', description: 'Override sandbox mode. ' + 'v'.repeat(100) },
        },
        required: ['command'],
      },
    };

    const { stats } = optimizeTools([tool], { numCtx: 100000 });
    const ratio = stats.compressed.tokens / stats.original.tokens;
    assert.ok(ratio < 0.40, `compression ratio ${ratio.toFixed(2)} should be < 0.40 (60%+ reduction)`);
  });

  it('large context models keep all tools after compression', () => {
    // 30 tools with moderate schemas on a 128K model = should all fit
    const tools = Array.from({ length: 30 }, (_, i) => makeTool(`Tool${i}`, 150, 2));
    const { tools: result, stats } = optimizeTools(tools, { numCtx: 131072, budgetPct: 0.30 });
    assert.equal(result.length, 30);
    assert.equal(stats.trimmed, false);
  });
});
