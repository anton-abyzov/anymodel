#!/usr/bin/env node
// Verify a downloaded registry artifact. Never publishes or changes shared installs.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
if (process.argv.includes('--help')) {
  console.log('node scripts/verification/release-receipt.mjs --metadata registry.json --tarball anymodel.tgz --expected-version VERSION [--expected-git-head SHA] [--out DIR]');
  process.exit(0);
}
const metadataPath = arg('--metadata') || process.env.ANYMODEL_RELEASE_METADATA;
const tarballPath = arg('--tarball') || process.env.ANYMODEL_RELEASE_TARBALL;
const expectedVersion = arg('--expected-version') || process.env.ANYMODEL_RELEASE_VERSION;
if (!metadataPath || !tarballPath || !expectedVersion) throw new Error('Provide --metadata, --tarball and --expected-version (or ANYMODEL_RELEASE_* equivalents).');
const metadata = JSON.parse(readFileSync(resolve(metadataPath), 'utf8'));
const bytes = readFileSync(resolve(tarballPath));
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
if (metadata.name !== 'anymodel' || metadata.version !== expectedVersion) throw new Error('Unexpected registry name/version.');
if (metadata.dist?.integrity !== integrity) throw new Error('Registry SHA-512 integrity mismatch.');
const gitHead = arg('--expected-git-head');
if (gitHead && metadata.gitHead !== gitHead) throw new Error('Registry gitHead mismatch.');
const entries = execFileSync('tar', ['-tzf', resolve(tarballPath)], { encoding: 'utf8' }).trim().split('\n');
if (entries.some(p => !p.startsWith('package/') || p.split('/').some(part => part === '..') || p.includes('\\') || /(^|\/)\.env(?:\.|$)/.test(p))) throw new Error('Unexpected archive path.');
const verbose = execFileSync('tar', ['-tvzf', resolve(tarballPath)], { encoding: 'utf8' });
if (verbose.split('\n').some(line => /^[lh]/.test(line))) throw new Error('Release archives must not contain symlinks/hard links.');
if (entries.includes('package/cli.js')) throw new Error('Frozen legacy client must not ship in the new release.');
if (!entries.includes('package/catalog/openrouter.mjs')) throw new Error('Catalog module is missing from release.');
for (const required of ['package/cli.mjs', 'package/proxy.mjs', 'package/package.json', 'package/LICENSE', 'package/NOTICE.md']) {
  if (!entries.includes(required)) throw new Error(`Missing release file: ${required}`);
}
const out = resolve(arg('--out') || mkdtempSync(join(tmpdir(), 'anymodel-release-')));
mkdirSync(out, { recursive: true });
const extracted = join(out, 'isolated');
mkdirSync(extracted);
execFileSync('tar', ['-xzf', resolve(tarballPath), '-C', extracted]);
const packageDir = join(extracted, 'package');
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
if (pkg.name !== metadata.name || pkg.version !== expectedVersion) throw new Error('Extracted package name/version mismatch.');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BASE_URL|ENDPOINT)/i.test(key) || /^(OLLAMA|LOCAL_|LMSTUDIO|LLAMACPP|ANYMODEL_|PROXY_)/.test(key)) delete env[key];
delete env.NODE_OPTIONS;
const checks = [];
for (const args of [['--version'], ['--help']]) {
  const run = spawnSync(process.execPath, [join(packageDir, 'cli.mjs'), ...args], { cwd: extracted, env, encoding: 'utf8', timeout: 15000 });
  checks.push({ args, exitCode: run.status, stdout: run.stdout || '', stderr: run.stderr || '' });
  if (run.status !== 0) throw new Error(`Isolated CLI ${args[0]} failed.`);
  if (args[0] === '--version' && !run.stdout.includes(expectedVersion)) throw new Error('Isolated CLI version mismatch.');
}
// Import public exports without invoking catalog network calls or provider discovery.
const catalogUrl = pathToFileURL(join(packageDir, 'catalog/openrouter.mjs')).href;
const moduleCheck = spawnSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(catalogUrl)}); if(typeof m.fetchCatalog!=='function'||typeof m.checkModel!=='function') process.exit(1);`], { cwd: extracted, env, encoding: 'utf8', timeout: 15000 });
if (moduleCheck.status !== 0) throw new Error('Packaged catalog exports failed import.');
const report = { passed: true, at: new Date().toISOString(), node: process.version, name: pkg.name, version: pkg.version, gitHead: metadata.gitHead || null, integrity, tarballBytes: bytes.length, legacyBundleAbsent: !existsSync(join(packageDir, 'cli.js')), catalogPresent: true, isolatedPackageDir: packageDir, checks, limitations: ['Verified extracted registry artifact and isolated CLI behavior; public deployment and npm global installation are separate receipts.'] };
writeFileSync(join(out, 'release-receipt.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, report: join(out, 'release-receipt.json'), version: pkg.version, integrity }, null, 2));
