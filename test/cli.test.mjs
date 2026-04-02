import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../cli.mjs';

describe('parseArgs', () => {
  it('detects openrouter as provider from positional arg', () => {
    const opts = parseArgs(['openrouter']);
    assert.equal(opts.provider, 'openrouter');
  });

  it('detects ollama as provider from positional arg', () => {
    const opts = parseArgs(['ollama']);
    assert.equal(opts.provider, 'ollama');
  });

  it('defaults provider to auto when no positional arg', () => {
    const opts = parseArgs([]);
    assert.equal(opts.provider, 'auto');
  });

  it('parses --model flag', () => {
    const opts = parseArgs(['--model', 'google/gemini-2.5-flash']);
    assert.equal(opts.model, 'google/gemini-2.5-flash');
  });

  it('parses --port flag', () => {
    const opts = parseArgs(['--port', '8080']);
    assert.equal(opts.port, 8080);
  });

  it('uses default port 9090', () => {
    const opts = parseArgs([]);
    assert.equal(opts.port, 9090);
  });

  it('parses provider with --model and --port', () => {
    const opts = parseArgs(['ollama', '--model', 'llama3', '--port', '3000']);
    assert.equal(opts.provider, 'ollama');
    assert.equal(opts.model, 'llama3');
    assert.equal(opts.port, 3000);
  });

  it('sets help flag with --help', () => {
    const opts = parseArgs(['--help']);
    assert.equal(opts.help, true);
  });

  it('ignores unknown flags', () => {
    const opts = parseArgs(['--unknown', 'value']);
    assert.equal(opts.provider, 'auto');
  });
});
