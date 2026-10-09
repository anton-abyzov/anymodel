// Preloaded into every test process. Only fixture HTTP listeners opened by that
// process may receive network traffic. Any blocked attempt fails the run even
// when application code catches the thrown exception.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const ports = new Set();
const violations = [];
function blocked(kind) {
  const event = { pid: process.pid, kind, at: new Date().toISOString() };
  violations.push(event);
  if (process.env.ANYMODEL_OFFLINE_GUARD_LOG) appendFileSync(process.env.ANYMODEL_OFFLINE_GUARD_LOG, JSON.stringify(event) + '\n');
  throw new Error(`OFFLINE_GUARD: blocked ${kind}; only this process's fixture HTTP servers are allowed`);
}
function address(first, extra) {
  if (typeof first === 'string' || first instanceof URL) return { ...Object.fromEntries(['hostname', 'port'].map(k => [k, new URL(first)[k]])), ...(extra && typeof extra === 'object' ? extra : {}) };
  return first || {};
}
function allowed(options) {
  const host = options.hostname || options.host || 'localhost';
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && ports.has(Number(options.port));
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  let port;
  this.once('listening', () => { const addr = this.address(); if (addr && typeof addr === 'object') { port = Number(addr.port); ports.add(port); } });
  this.once('close', () => { if (port) ports.delete(port); });
  return listen.apply(this, args);
};
const request = http.request;
http.request = function (first, ...rest) {
  if (!allowed(address(first, rest[0]))) return blocked('HTTP outside fixture');
  return request.call(this, first, ...rest);
};
http.get = function (...args) { const req = http.request(...args); req.end(); return req; };
https.request = https.get = function () { return blocked('HTTPS'); };
const fetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || !allowed(url)) return blocked('fetch outside fixture');
  return fetch(input, init);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node internally passes the normalized connect tuple as its first argument.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const opts = typeof first === 'object' ? first : { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' };
  if (!allowed(opts)) return blocked('TCP outside fixture');
  return connect.apply(this, args);
};
const nodeNames = new Set(['node', process.execPath]);
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, options, ...rest) {
    if (!nodeNames.has(file)) return blocked('non-Node subprocess');
    // Preserve the preload even if a test supplies a custom child environment.
    if (options && typeof options === 'object') options = { ...options, env: { ...process.env, ...options.env, NODE_OPTIONS: process.env.NODE_OPTIONS } };
    return original.call(this, file, args, options, ...rest);
  };
}
childProcess.exec = childProcess.execSync = function () { return blocked('shell subprocess'); };
syncBuiltinESMExports();
process.on('exit', () => { if (violations.length) process.exitCode = 1; });
