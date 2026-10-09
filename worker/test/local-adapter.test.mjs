import { it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLocalWorkerServer } from '../serve-local.mjs';
import { handleRequest } from '../handler.mjs';

function post(port, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('fixture request timeout')));
    // Force chunked request handling to exercise the actual streamed byte cap.
    req.write(payload.slice(0, 64));
    req.end(payload.slice(64));
  });
}
async function fixture(t, env) {
  handleRequest._rateState = {};
  t.mock.method(globalThis, 'fetch', async () => new Response('{"fixture":true}', { status: 200 }));
  const server = createLocalWorkerServer(env);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
it('local adapter streams through the body cap and returns HTTP 413', async t => {
  const port = await fixture(t, { ANYMODEL_MAX_BODY_BYTES: '128' });
  const response = await post(port, 'x'.repeat(129), { 'x-api-key': 'sk-or-fixture-caller' });
  assert.equal(response.status, 413);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
it('local adapter uses socket identity instead of forged Cloudflare or forwarded headers', async t => {
  const port = await fixture(t, { RPM: '1' });
  const payload = JSON.stringify({ model: 'fixture/model:free', messages: [] });
  const first = await post(port, payload, { 'x-api-key': 'sk-or-fixture-caller', 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': 'one' });
  const next = await post(port, payload, { 'x-api-key': 'sk-or-fixture-caller', 'cf-connecting-ip': '192.0.2.2', 'x-forwarded-for': 'two' });
  assert.equal(first.status, 200);
  assert.equal(next.status, 429);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});
