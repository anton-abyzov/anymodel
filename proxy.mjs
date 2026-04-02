// Core proxy server for anymodel
// Routes /v1/messages → provider, everything else → api.anthropic.com

import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));

export const MAX_RETRIES = 3;

// ANSI colors
const C = {
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

// Strip Anthropic-specific fields that break non-Anthropic providers
export function sanitizeBody(body) {
  delete body.betas;
  delete body.metadata;
  delete body.speed;
  delete body.output_config;
  delete body.context_management;
  delete body.thinking;

  // Strip cache_control from system blocks
  if (Array.isArray(body.system)) {
    body.system = body.system.map(block => {
      if (block && typeof block === 'object' && block.cache_control) {
        const { cache_control, ...rest } = block;
        return rest;
      }
      return block;
    });
  }

  // Strip cache_control from message content blocks
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        msg.content = msg.content.map(block => {
          if (block && typeof block === 'object' && block.cache_control) {
            const { cache_control, ...rest } = block;
            return rest;
          }
          return block;
        });
      }
    }
  }

  // Strip Anthropic-only tool fields
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map(tool => {
      const { cache_control, defer_loading, eager_input_streaming, strict, ...rest } = tool;
      return rest;
    });
  }

  // Normalize tool_choice: providers expect object, Claude Code may send string
  if (typeof body.tool_choice === 'string') {
    body.tool_choice = { type: body.tool_choice };
  }

  return body;
}

// Calculate exponential backoff delay, capped at 8s
export function calcDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000);
}

// Check if a URL path should be routed to the provider
export function isProviderRoute(url) {
  return url.startsWith('/v1/messages');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Load .env file if present (from given dir, or cwd)
export function loadEnv(dir) {
  try {
    const envPath = dir ? `${dir}/.env` : `${process.cwd()}/.env`;
    const envFile = readFileSync(envPath, 'utf8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

function sendRequest(provider, url, payload) {
  const opts = provider.buildRequest(url, payload, process.env.OPENROUTER_API_KEY);

  return new Promise((resolve, reject) => {
    const transport = opts.port === 443 || opts.protocol === 'https:' ? https : http;
    const req = transport.request(opts, upstream => resolve(upstream));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleMessages(req, res, provider, model) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  await new Promise(r => req.on('end', r));
  const raw = Buffer.concat(chunks);

  let parsed;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'Invalid JSON' } }));
    return;
  }

  const originalModel = parsed.model;
  if (model) parsed.model = model;

  sanitizeBody(parsed);

  const payload = JSON.stringify(parsed);
  const modelDisplay = model ? `${originalModel} \u2192 ${model}` : originalModel;
  console.log(`${C.cyan(`[${provider.name.toUpperCase()}]`)} ${req.method} ${req.url} model=${modelDisplay} stream=${parsed.stream}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await sendRequest(provider, req.url, payload);

      if (upstream.statusCode === 429 || upstream.statusCode >= 500) {
        const errChunks = [];
        upstream.on('data', c => errChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        const errBody = Buffer.concat(errChunks).toString();

        const delay = calcDelay(attempt);
        console.log(`${C.red(`[${provider.name.toUpperCase()}]`)} ${upstream.statusCode} on attempt ${attempt}/${MAX_RETRIES}, retrying in ${delay}ms`);
        console.log(`${C.red(`[${provider.name.toUpperCase()}]`)} ${errBody.slice(0, 200)}`);

        if (attempt === MAX_RETRIES) {
          res.writeHead(upstream.statusCode, upstream.headers);
          res.end(errBody);
          return;
        }
        await sleep(delay);
        continue;
      }

      if (upstream.statusCode !== 200) {
        const errChunks = [];
        upstream.on('data', c => errChunks.push(c));
        await new Promise(r => upstream.on('end', r));
        const errBody = Buffer.concat(errChunks).toString();
        console.log(`${C.red(`[${provider.name.toUpperCase()}]`)} ${upstream.statusCode}: ${errBody.slice(0, 300)}`);
        res.writeHead(upstream.statusCode, upstream.headers);
        res.end(errBody);
        return;
      }

      console.log(`${C.green(`[${provider.name.toUpperCase()}]`)} 200 \u2190 streaming response (attempt ${attempt})`);
      res.writeHead(200, upstream.headers);
      upstream.pipe(res);
      return;

    } catch (e) {
      console.error(`${C.red(`[${provider.name.toUpperCase()}]`)} Connection error on attempt ${attempt}: ${e.message}`);
      if (attempt === MAX_RETRIES) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }));
        return;
      }
      await sleep(calcDelay(attempt));
    }
  }
}

function proxyToAnthropic(req, res) {
  const body = [];
  req.on('data', c => body.push(c));
  req.on('end', () => {
    const opts = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'api.anthropic.com' },
    };
    const pr = https.request(opts, upstream => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    pr.on('error', e => { res.writeHead(502); res.end(e.message); });
    if (body.length) pr.write(Buffer.concat(body));
    pr.end();
  });
}

export function createProxy(provider, { port = 9090, model } = {}) {
  const server = http.createServer((req, res) => {
    if (isProviderRoute(req.url)) {
      handleMessages(req, res, provider, model);
    } else {
      console.log(`${C.yellow('[ANTHROPIC]')} ${req.method} ${req.url}`);
      proxyToAnthropic(req, res);
    }
  });

  server.listen(port, () => {
    console.log('');
    console.log(C.magenta(`  anymodel v${pkg.version}`));
    console.log('');
    console.log(`  ${C.cyan('\u2194')}  Proxy on :${port}`);
    console.log(`     /v1/messages \u2192 ${C.bold(provider.name)} ${provider.displayInfo(model)}`);
    console.log(`     everything else \u2192 api.anthropic.com`);
    console.log(`     Retries: ${MAX_RETRIES} with exponential backoff`);
    if (model) {
      console.log(`     Model override: ${C.cyan(model)}`);
    }
    console.log('');
    console.log(`  ${C.green('Run in another terminal:')}`);
    console.log(`  ${C.bold(`ANTHROPIC_BASE_URL=http://localhost:${port} claude`)}`);
    console.log('');
  });

  return server;
}
