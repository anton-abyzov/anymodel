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

  // Normalize tool_choice: providers expect object, clients may send string
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

async function handleMessages(req, res, provider, model, isFreeTierModel) {
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

  // Free-only enforcement: block paid models
  if (isFreeTierModel && !isFreeTierModel(parsed.model)) {
    console.log(`${C.red('[FREE-ONLY]')} Blocked paid model: ${parsed.model}`);
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { type: 'model_blocked', message: `Model "${parsed.model}" is not free. Use --model with a :free model or disable --free-only.` }
    }));
    return;
  }

  sanitizeBody(parsed);

  const payload = JSON.stringify(parsed);
  const modelDisplay = model ? `${originalModel} \u2192 ${model}` : originalModel;
  console.log(`${C.cyan(`[${provider.name.toUpperCase()}]`)} ${req.method} ${req.url} model=${modelDisplay}${parsed.stream ? ' stream=true' : ''}`);

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

export function createProxy(provider, { port = 9090, model, maxPortRetries = 10, freeOnly = false, freeModels = [], token = null, rpm = 60 } = {}) {
  // Rate limiting state
  const rateWindow = {};

  function checkRateLimit(ip) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `${ip}:${minute}`;
    rateWindow[key] = (rateWindow[key] || 0) + 1;
    // Clean old entries
    for (const k of Object.keys(rateWindow)) {
      if (!k.endsWith(`:${minute}`)) delete rateWindow[k];
    }
    return rateWindow[key] <= rpm;
  }

  function checkAuth(req) {
    if (!token) return true;
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
    return authHeader === `Bearer ${token}` || authHeader === token;
  }

  function isFreeTierModel(modelId) {
    if (!freeOnly) return true;
    if (!modelId) return !!model; // using default model which was already validated
    return modelId.endsWith(':free') || freeModels.includes(modelId);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0].replace(/\/+$/, '') === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: pkg.version,
        provider: provider.name,
        model: model || null,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (isProviderRoute(req.url)) {
      // Auth check
      if (!checkAuth(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'auth_error', message: 'Invalid or missing token. Set Authorization: Bearer <token>' } }));
        return;
      }
      // Rate limit check
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
      if (!checkRateLimit(clientIp)) {
        console.log(`${C.red('[RATE]')} Limit exceeded for ${clientIp}`);
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: `Rate limit: ${rpm} requests/minute exceeded` } }));
        return;
      }
      handleMessages(req, res, provider, model, isFreeTierModel);
    } else {
      console.log(`${C.yellow('[PASSTHROUGH]')} ${req.method} ${req.url}`);
      proxyToAnthropic(req, res);
    }
  });

  function printBanner(actualPort) {
    console.log('');
    console.log(C.magenta(`  anymodel v${pkg.version}`));
    console.log('');
    console.log(`  ${C.cyan('\u2194')}  Proxy on :${actualPort}`);
    console.log(`     /v1/messages \u2192 ${C.bold(provider.name)} ${provider.displayInfo(model)}`);
    console.log(`     everything else \u2192 passthrough`);
    console.log(`     Retries: ${MAX_RETRIES} with exponential backoff`);
    if (model) {
      console.log(`     Model override: ${C.cyan(model)}`);
    }
    if (freeOnly) {
      console.log(`     ${C.green('\u2713')} Free models only (no charges)`);
    }
    if (token) {
      console.log(`     ${C.green('\u2713')} Token auth enabled`);
    }
    if (rpm < 9999) {
      console.log(`     ${C.green('\u2713')} Rate limit: ${rpm} req/min`);
    }
    console.log('');
    console.log(`  ${C.green('Run in another terminal:')}`);
    const modelEnv = model ? `ANYMODEL_MODEL="${model}" ` : '';
    console.log(`  ${C.bold(`${modelEnv}ANTHROPIC_BASE_URL=http://localhost:${actualPort} node cli.js`)}`);
    console.log('');
  }

  // Smart port finding: try port, port+1, port+2, ... up to maxPortRetries
  let attempt = 0;
  function tryListen() {
    const tryPort = port + attempt;
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxPortRetries) {
        console.log(`${C.yellow('[PORT]')} :${tryPort} in use, trying :${tryPort + 1}`);
        attempt++;
        tryListen();
      } else {
        throw err;
      }
    });
    server.listen(tryPort, () => {
      if (attempt > 0) {
        console.log(`${C.green('[PORT]')} Found free port :${tryPort}`);
      }
      // Notify parent process of actual port (IPC)
      if (process.send) process.send({ type: 'port', port: tryPort });
      printBanner(tryPort);
    });
  }
  tryListen();

  return server;
}
