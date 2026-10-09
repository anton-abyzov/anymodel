#!/usr/bin/env node
// Local adapter for the Worker handler. Imports are side-effect free for tests.
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { handleRequest } from './handler.mjs';

// Do not buffer the entire incoming request before the Worker's byte limit runs.
// Cancellation drains the incoming body instead of destroying its response socket,
// so a size rejection can still return HTTP 413 to a local client.
function streamingBody(req) {
  let finished = false;
  let onData;
  let onEnd;
  return new ReadableStream({
    start(controller) {
      req.pause();
      onData = chunk => { req.pause(); controller.enqueue(chunk); };
      onEnd = () => { if (!finished) { finished = true; controller.close(); } };
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', error => { if (!finished) { finished = true; controller.error(error); } });
    },
    pull() { req.resume(); },
    cancel() {
      finished = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.resume();
    },
  }, { highWaterMark: 0 });
}

export function createLocalWorkerServer(env = {}) {
  return http.createServer(async (req, res) => {
    let request;
    try {
      const headers = new Headers(req.headers);
      // Clients of this direct adapter cannot impersonate a Cloudflare edge.
      headers.delete('cf-connecting-ip');
      headers.delete('x-forwarded-for');
      request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: streamingBody(req), duplex: 'half' } : {}),
      });
      const response = await handleRequest(request, env, { clientIp: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const stream = Readable.fromWeb(response.body);
        res.once('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Local worker request failed.' } }));
    } finally {
      if (request?.body && !request.body.locked) await request.body.cancel().catch(() => {});
      req.resume();
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { loadEnv } = await import('../proxy.mjs');
  loadEnv(fileURLToPath(new URL('..', import.meta.url)));
  const port = Number(process.env.WORKER_PORT) || 9091;
  const env = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    ANYMODEL_TOKEN: process.env.ANYMODEL_TOKEN || '',
    FREE_ONLY: process.env.FREE_ONLY || 'true',
    RPM: process.env.RPM || '60',
    MODEL: process.env.MODEL || '',
    ANYMODEL_MAX_BODY_BYTES: process.env.ANYMODEL_MAX_BODY_BYTES || '',
  };
  createLocalWorkerServer(env).listen(port, '127.0.0.1', () => {
    console.log(`AnyModel Worker adapter: http://127.0.0.1:${port}`);
    console.log(`Funding: ${env.ANYMODEL_TOKEN ? 'gateway token required' : 'caller BYOK only; server key disabled'}`);
    console.log(`Free-only: ${env.FREE_ONLY !== 'false'}`);
  });
}
