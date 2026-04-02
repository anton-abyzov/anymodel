import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { calcDelay, isProviderRoute, loadEnv, MAX_RETRIES } from '../proxy.mjs';

describe('retry logic', () => {
  it('exports MAX_RETRIES as 3', () => {
    assert.equal(MAX_RETRIES, 3);
  });

  it('calculates exponential backoff delay for attempt 1', () => {
    assert.equal(calcDelay(1), 1000);
  });

  it('calculates exponential backoff delay for attempt 2', () => {
    assert.equal(calcDelay(2), 2000);
  });

  it('calculates exponential backoff delay for attempt 3', () => {
    assert.equal(calcDelay(3), 4000);
  });

  it('caps delay at 8000ms', () => {
    assert.equal(calcDelay(5), 8000);
    assert.equal(calcDelay(10), 8000);
  });
});

describe('request routing', () => {
  it('identifies /v1/messages as provider route', () => {
    assert.equal(isProviderRoute('/v1/messages'), true);
    assert.equal(isProviderRoute('/v1/messages?beta=true'), true);
  });

  it('identifies other paths as anthropic passthrough', () => {
    assert.equal(isProviderRoute('/v1/complete'), false);
    assert.equal(isProviderRoute('/v1/models'), false);
    assert.equal(isProviderRoute('/'), false);
  });
});

describe('loadEnv', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `anymodel-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ANYMODEL_TEST_PLAIN;
    delete process.env.ANYMODEL_TEST_DQ;
    delete process.env.ANYMODEL_TEST_SQ;
  });

  it('strips double quotes from .env values', () => {
    writeFileSync(join(tmpDir, '.env'), 'ANYMODEL_TEST_DQ="hello-world"\n');
    loadEnv(tmpDir);
    assert.equal(process.env.ANYMODEL_TEST_DQ, 'hello-world');
  });

  it('strips single quotes from .env values', () => {
    writeFileSync(join(tmpDir, '.env'), "ANYMODEL_TEST_SQ='hello-world'\n");
    loadEnv(tmpDir);
    assert.equal(process.env.ANYMODEL_TEST_SQ, 'hello-world');
  });

  it('loads unquoted values as-is', () => {
    writeFileSync(join(tmpDir, '.env'), 'ANYMODEL_TEST_PLAIN=hello-world\n');
    loadEnv(tmpDir);
    assert.equal(process.env.ANYMODEL_TEST_PLAIN, 'hello-world');
  });

  it('skips comments and blank lines', () => {
    writeFileSync(join(tmpDir, '.env'), '# comment\n\nANYMODEL_TEST_PLAIN=ok\n');
    loadEnv(tmpDir);
    assert.equal(process.env.ANYMODEL_TEST_PLAIN, 'ok');
  });

  it('does not override existing env vars', () => {
    process.env.ANYMODEL_TEST_PLAIN = 'original';
    writeFileSync(join(tmpDir, '.env'), 'ANYMODEL_TEST_PLAIN=overridden\n');
    loadEnv(tmpDir);
    assert.equal(process.env.ANYMODEL_TEST_PLAIN, 'original');
  });
});
