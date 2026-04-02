import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcDelay, MAX_RETRIES } from '../proxy.mjs';

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

// Import after tests are defined so the describe blocks register
import { isProviderRoute } from '../proxy.mjs';
