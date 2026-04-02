import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import shared sanitize logic from parent
import { sanitizeBody } from '../../proxy.mjs';

// Import worker functions
import { checkAuth, isFreeTierModel, checkRateLimit, buildOpenRouterRequest, FREE_MODELS } from '../handler.mjs';

describe('Worker Auth', () => {
  it('rejects requests without token when token is set', () => {
    assert.equal(checkAuth({}, 'mysecret'), false);
  });

  it('accepts Bearer token', () => {
    assert.equal(checkAuth({ authorization: 'Bearer mysecret' }, 'mysecret'), true);
  });

  it('accepts x-api-key token', () => {
    assert.equal(checkAuth({ 'x-api-key': 'mysecret' }, 'mysecret'), true);
  });

  it('allows all requests when no token configured', () => {
    assert.equal(checkAuth({}, null), true);
    assert.equal(checkAuth({}, ''), true);
  });

  it('rejects wrong token', () => {
    assert.equal(checkAuth({ authorization: 'Bearer wrong' }, 'mysecret'), false);
  });
});

describe('Free Model Enforcement', () => {
  it('allows :free suffix models', () => {
    assert.equal(isFreeTierModel('qwen/qwen3-coder:free', true), true);
  });

  it('allows known free models from list', () => {
    assert.equal(isFreeTierModel(FREE_MODELS[0], true), true);
  });

  it('blocks paid models when freeOnly is true', () => {
    assert.equal(isFreeTierModel('anthropic/claude-sonnet-4.6', true), false);
  });

  it('allows any model when freeOnly is false', () => {
    assert.equal(isFreeTierModel('anthropic/claude-sonnet-4.6', false), true);
  });

  it('blocks model without :free suffix', () => {
    assert.equal(isFreeTierModel('google/gemini-2.5-flash', true), false);
  });
});

describe('Rate Limiting', () => {
  let limiter;

  beforeEach(() => {
    limiter = checkRateLimit.create(5); // 5 req/min for testing
  });

  it('allows requests under limit', () => {
    assert.equal(limiter.check('1.2.3.4'), true);
    assert.equal(limiter.check('1.2.3.4'), true);
  });

  it('blocks after exceeding limit', () => {
    for (let i = 0; i < 5; i++) limiter.check('1.2.3.4');
    assert.equal(limiter.check('1.2.3.4'), false);
  });

  it('tracks different IPs separately', () => {
    for (let i = 0; i < 5; i++) limiter.check('1.2.3.4');
    assert.equal(limiter.check('5.6.7.8'), true); // different IP, not limited
  });
});

describe('OpenRouter Request Building', () => {
  it('builds correct request with model override', () => {
    const req = buildOpenRouterRequest('/v1/messages', 'sk-or-test', 'qwen/qwen3-coder:free');
    assert.equal(req.url, 'https://openrouter.ai/api/v1/messages');
    assert.equal(req.headers['authorization'], 'Bearer sk-or-test');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.ok(req.headers['anthropic-version']);
  });

  it('includes http-referer and x-title', () => {
    const req = buildOpenRouterRequest('/v1/messages', 'key', null);
    assert.equal(req.headers['http-referer'], 'https://anymodel.dev');
    assert.equal(req.headers['x-title'], 'anymodel');
  });
});

describe('Sanitize Body (shared)', () => {
  it('strips Anthropic-specific fields', () => {
    const body = { model: 'test', betas: ['x'], metadata: {}, thinking: {}, messages: [] };
    sanitizeBody(body);
    assert.equal(body.betas, undefined);
    assert.equal(body.metadata, undefined);
    assert.equal(body.thinking, undefined);
  });

  it('normalizes tool_choice string to object', () => {
    const body = { model: 'test', tool_choice: 'auto', messages: [] };
    sanitizeBody(body);
    assert.deepEqual(body.tool_choice, { type: 'auto' });
  });

  it('strips cache_control from tools', () => {
    const body = { model: 'test', messages: [], tools: [{ name: 'bash', cache_control: { type: 'ephemeral' }, input_schema: {} }] };
    sanitizeBody(body);
    assert.equal(body.tools[0].cache_control, undefined);
    assert.equal(body.tools[0].name, 'bash');
  });
});
