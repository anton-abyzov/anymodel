import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { RETIRED_MESSAGE } from '../index.mjs';

for (const [method, path] of [['POST', '/v1/messages'], ['GET', '/health'], ['GET', '/v1/models'], ['OPTIONS', '/v1/messages']]) {
  test(`retired worker answers 410 for ${method} ${path}`, async () => {
    const response = await worker.fetch(new Request(`https://api.anymodel.dev${path}`, { method }), { RETIRED: 'true', OPENROUTER_API_KEY: 'never-read' });
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.error.type, 'gone');
    assert.equal(body.error.message, RETIRED_MESSAGE);
    assert.match(body.error.message, /own API key or a local model/);
  });
}

test('without RETIRED the original handler still answers', async () => {
  const response = await worker.fetch(new Request('https://api.anymodel.dev/health'), {});
  assert.notEqual(response.status, 410);
});
