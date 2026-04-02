import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../proxy.mjs';

const mockProvider = {
  name: 'test-provider',
  buildRequest: () => ({}),
  displayInfo: () => 'test',
};

function fetch(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      });
    }).on('error', reject);
  });
}

describe('GET /health', () => {
  let server;
  let port;

  before(async () => {
    server = createProxy(mockProvider, { port: 0, model: 'test-model' });
    await new Promise(resolve => {
      if (server.listening) {
        port = server.address().port;
        resolve();
      } else {
        server.on('listening', () => {
          port = server.address().port;
          resolve();
        });
      }
    });
  });

  after(() => server.close());

  it('returns status 200', async () => {
    const res = await fetch(port, '/health');
    assert.equal(res.status, 200);
  });

  it('returns content-type application/json', async () => {
    const res = await fetch(port, '/health');
    assert.equal(res.headers['content-type'], 'application/json');
  });

  it('response body contains all required fields', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    for (const field of ['status', 'version', 'provider', 'model', 'uptime', 'timestamp']) {
      assert.ok(field in body, `missing field: ${field}`);
    }
  });

  it('status field is "ok"', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
  });

  it('provider field matches mock provider name', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    assert.equal(body.provider, 'test-provider');
  });

  it('uptime is a number', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    assert.equal(typeof body.uptime, 'number');
  });

  it('timestamp is a valid ISO string', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    const parsed = new Date(body.timestamp);
    assert.ok(!isNaN(parsed.getTime()), 'timestamp is not a valid date');
    assert.equal(body.timestamp, parsed.toISOString());
  });

  it('matches /health with query string', async () => {
    const res = await fetch(port, '/health?verbose=true');
    assert.equal(res.status, 200);
  });

  it('matches /health with trailing slash', async () => {
    const res = await fetch(port, '/health/');
    assert.equal(res.status, 200);
  });
});

describe('GET /health without model', () => {
  let server;
  let port;

  before(async () => {
    server = createProxy(mockProvider, { port: 0 });
    await new Promise(resolve => {
      if (server.listening) {
        port = server.address().port;
        resolve();
      } else {
        server.on('listening', () => {
          port = server.address().port;
          resolve();
        });
      }
    });
  });

  after(() => server.close());

  it('model field is null when no model configured', async () => {
    const res = await fetch(port, '/health');
    const body = JSON.parse(res.body);
    assert.equal(body.model, null);
  });
});
