// P0.3: a stalled upstream (model hangs / silent socket) must NOT hang the proxy
// forever. Two layers of coverage:
//   1. upstreamTimeoutMs() reads ANYMODEL_UPSTREAM_TIMEOUT_MS at call time.
//   2. The request timeout MECHANISM sendRequest relies on (http.request({timeout})
//      → 'timeout' event → destroy → error) actually fires against a black-hole
//      upstream within the configured window.
//
// The full end-to-end "proxy returns 502 instead of hanging" path is verified
// live in anymodel-baseline-test.md (it returns 502 in ~8s = 600ms × 3 retries +
// backoff). We do NOT run that here because the proxy's keep-alive agent holds the
// event loop open, which would wedge `node --test` on exit — a CI-reliability trap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { upstreamTimeoutMs } from '../proxy.mjs';

test('P0.3 — upstreamTimeoutMs reads env at call time', async (t) => {
  const prev = process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS;
  t.after(() => { if (prev === undefined) delete process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS; else process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS = prev; });

  await t.test('defaults to 300000ms when unset', () => {
    delete process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS;
    assert.equal(upstreamTimeoutMs(), 300000);
  });
  await t.test('honors the override', () => {
    process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS = '1234';
    assert.equal(upstreamTimeoutMs(), 1234);
  });
  await t.test('falls back to default on garbage', () => {
    process.env.ANYMODEL_UPSTREAM_TIMEOUT_MS = 'not-a-number';
    assert.equal(upstreamTimeoutMs(), 300000);
  });
});

test('P0.3 — request timeout fires against a black-hole upstream', { timeout: 10000 }, async (t) => {
  // Black-hole: accepts the connection, never sends a response.
  const sink = http.createServer(() => { /* never respond */ });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const port = sink.address().port;
  t.after(async () => {
    sink.closeAllConnections?.();           // kill any lingering sockets (Node ≥18.2)
    await new Promise(r => sink.close(r));
  });

  await t.test('http.request({timeout}) emits timeout → destroy → error (the sendRequest mechanism)', async () => {
    const TIMEOUT = 500;
    const start = Date.now();
    const err = await new Promise((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', timeout: TIMEOUT },
        upstream => { upstream.resume(); /* would resolve a response — should never happen */ }
      );
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      req.on('error', resolve);
      req.end('{}');
    });
    const elapsed = Date.now() - start;
    assert.ok(err instanceof Error, 'must reject with an Error, not hang');
    assert.match(err.message, /timeout/i);
    assert.ok(elapsed >= TIMEOUT - 50 && elapsed < 5000, `should fire near ${TIMEOUT}ms, got ${elapsed}ms`);
  });
});
