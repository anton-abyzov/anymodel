#!/usr/bin/env node
// Local test server for the anymodel Cloudflare Worker
// Simulates the Workers runtime using Node.js http server + fetch()

import http from 'http';
import { handleRequest } from './handler.mjs';

// Load .env from parent dir
import { loadEnv } from '../proxy.mjs';
loadEnv(new URL('..', import.meta.url).pathname);

const PORT = parseInt(process.env.WORKER_PORT || '9091', 10);

const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  ANYMODEL_TOKEN: process.env.ANYMODEL_TOKEN || '',
  FREE_ONLY: process.env.FREE_ONLY || 'true',
  RPM: process.env.RPM || '60',
  MODEL: process.env.MODEL || '',
};

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
    });
    res.end();
    return;
  }

  // Collect body
  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));
  const bodyBuffer = Buffer.concat(chunks);

  // Build a fetch-compatible Request object
  const url = `http://localhost:${PORT}${req.url}`;
  const headers = new Headers(req.headers);
  const request = new Request(url, {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
  });

  try {
    const response = await handleRequest(request, env);

    // Write status + headers
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);

    // Stream body
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(e => { console.error(e); res.end(); });
    } else {
      res.end(await response.text());
    }
  } catch (e) {
    console.error('Worker error:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'internal', message: e.message } }));
  }
});

server.listen(PORT, () => {
  console.log(`\n\x1b[35m  anymodel worker (local)\x1b[0m`);
  console.log(`\n  \x1b[36m\u2194\x1b[0m  http://localhost:${PORT}`);
  console.log(`     /v1/messages \u2192 OpenRouter`);
  console.log(`     /health      \u2192 status`);
  console.log(`     Free-only: ${env.FREE_ONLY}`);
  console.log(`     Token: ${env.ANYMODEL_TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`     Rate limit: ${env.RPM} req/min`);
  console.log(`\n  \x1b[32mTest:\x1b[0m curl http://localhost:${PORT}/health`);
  console.log(`  \x1b[32mUse:\x1b[0m  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude\n`);
});
