// P1.6 (US-5) — canonical Anthropic error envelope via sendError.
// Tests the helper directly with a mock ServerResponse (no live server — per the
// node:test event-loop constraint documented in plan.md).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sendError } from '../proxy.mjs';

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; },
  };
}

describe('P1.6 sendError canonical envelope', () => {
  it('emits {type:"error", error:{type,message}} with the given status', () => {
    const res = mockRes();
    sendError(res, 429, 'rate_limit_error', 'too many');
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['content-type'], 'application/json');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.type, 'error');
    assert.deepEqual(parsed.error, { type: 'rate_limit_error', message: 'too many' });
  });

  it('uses canonical Anthropic error.type strings', () => {
    const canonical = new Set([
      'invalid_request_error', 'authentication_error', 'permission_error',
      'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error',
    ]);
    for (const type of ['authentication_error', 'api_error', 'invalid_request_error', 'permission_error']) {
      const res = mockRes();
      sendError(res, 400, type, 'x');
      assert.ok(canonical.has(JSON.parse(res.body).error.type), `${type} is canonical`);
    }
  });

  it('merges extra headers (e.g. retry-after) without clobbering content-type', () => {
    const res = mockRes();
    sendError(res, 429, 'rate_limit_error', 'slow down', { 'retry-after': '12' });
    assert.equal(res.headers['retry-after'], '12');
    assert.equal(res.headers['content-type'], 'application/json');
  });

  it('is a no-op when the response is already ended (no double-write throw)', () => {
    const res = mockRes();
    res.writableEnded = true;
    assert.doesNotThrow(() => sendError(res, 500, 'api_error', 'late'));
    assert.equal(res.statusCode, null, 'did not write to an ended response');
  });

  it('closes cleanly without writeHead when headers were already sent (streaming throw)', () => {
    const res = mockRes();
    res.headersSent = true; // streaming already flushed 200 headers
    res.writeHead = () => { throw new Error('ERR_HTTP_HEADERS_SENT'); };
    assert.doesNotThrow(() => sendError(res, 502, 'api_error', 'post-header throw'));
    assert.equal(res.writableEnded, true, 'response was ended');
  });
});
