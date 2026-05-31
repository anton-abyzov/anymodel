// P1.7 (loopback bind) + P1.8 (no key leak on local passthrough) + P1.9 (body cap
// + upstream parse guards). Helpers are pure/unit-testable; readCappedBody is
// exercised against a synthetic stream (no live proxy — node:test event-loop trap).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import {
  resolveBindHost, isLoopbackHost, stripAuthHeaders,
  maxBodyBytes, readCappedBody, safeJsonParse,
} from '../proxy.mjs';

describe('P1.7 loopback bind defaults', () => {
  it('defaults to 127.0.0.1 when nothing is set', () => {
    const saved = process.env.ANYMODEL_HOST;
    delete process.env.ANYMODEL_HOST;
    assert.equal(resolveBindHost(null), '127.0.0.1');
    if (saved !== undefined) process.env.ANYMODEL_HOST = saved;
  });

  it('honors an explicit --host arg over the env', () => {
    process.env.ANYMODEL_HOST = '10.0.0.5';
    assert.equal(resolveBindHost('0.0.0.0'), '0.0.0.0');
    delete process.env.ANYMODEL_HOST;
  });

  it('classifies loopback vs exposed hosts', () => {
    assert.ok(isLoopbackHost('127.0.0.1'));
    assert.ok(isLoopbackHost('::1'));
    assert.ok(isLoopbackHost('localhost'));
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.10'), false);
  });
});

describe('P1.8 strip Anthropic credentials on local passthrough', () => {
  it('removes x-api-key and authorization, keeps other headers', () => {
    const out = stripAuthHeaders({
      'x-api-key': 'sk-ant-real', authorization: 'Bearer sk-ant-real',
      'content-type': 'application/json', 'user-agent': 'cc',
    });
    assert.equal('x-api-key' in out, false);
    assert.equal('authorization' in out, false);
    assert.equal(out['content-type'], 'application/json');
    assert.equal(out['user-agent'], 'cc');
  });

  it('does not mutate the input headers object', () => {
    const input = { 'x-api-key': 'sk' };
    stripAuthHeaders(input);
    assert.equal(input['x-api-key'], 'sk');
  });
});

describe('P1.9 body cap + parse guards', () => {
  it('defaults the cap to 64MB and honors the env override', () => {
    assert.equal(maxBodyBytes(), 64 * 1024 * 1024);
    process.env.ANYMODEL_MAX_BODY_BYTES = '1024';
    assert.equal(maxBodyBytes(), 1024);
    delete process.env.ANYMODEL_MAX_BODY_BYTES;
  });

  it('resolves a small body under the cap', async () => {
    const s = Readable.from([Buffer.from('hello')]);
    s.headers = {};
    const buf = await readCappedBody(s, 1024);
    assert.equal(buf.toString(), 'hello');
  });

  it('rejects with BODY_TOO_LARGE when the stream exceeds the cap', async () => {
    const s = Readable.from([Buffer.alloc(10), Buffer.alloc(10)]);
    s.headers = {};
    await assert.rejects(readCappedBody(s, 15), (e) => e.code === 'BODY_TOO_LARGE');
  });

  it('fails fast on a Content-Length already over the cap', async () => {
    const s = Readable.from([Buffer.alloc(4)]);
    s.headers = { 'content-length': '99999' };
    await assert.rejects(readCappedBody(s, 1024), (e) => e.code === 'BODY_TOO_LARGE');
  });

  it('safeJsonParse returns ok:false instead of throwing on non-JSON', () => {
    const r = safeJsonParse('<html>500</html>');
    assert.equal(r.ok, false);
    const r2 = safeJsonParse('{"a":1}');
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.value, { a: 1 });
  });
});
