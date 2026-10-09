#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
const root = resolve(arg('--root') || fileURLToPath(new URL('../..', import.meta.url)));
const out = arg('--out') ? resolve(arg('--out')) : mkdtempSync(join(tmpdir(), 'anymodel-offline-'));
if (out === root || !relative(root, out).startsWith('..')) throw new Error('Test artifacts must be outside the source checkout.');
mkdirSync(out, { recursive: true });
const walk = dir => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const directories = ['test', 'worker/test', 'catalog-test', 'evaluation/test'];
const files = directories.flatMap(dir => walk(join(root, dir))).filter(p => /\.test\.mjs$/.test(p)).sort();
if (!files.length) throw new Error('No tests found.');
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Run the complete suite with Node 22.');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BASE_URL|ENDPOINT)/i.test(key) || /^(?:OLLAMA|LOCAL_|LMSTUDIO|LLAMACPP|ANYMODEL_|PROXY_)/.test(key)) delete env[key];
}
const guard = fileURLToPath(new URL('./offline-guard.mjs', import.meta.url));
env.NODE_OPTIONS = `--import=${JSON.stringify(guard)}`;
env.NODE_V8_COVERAGE = join(out, 'v8');
env.ANYMODEL_OFFLINE_GUARD_LOG = join(out, 'network-violations.jsonl');
env.PWDEBUG = '0'; env.PLAYWRIGHT_HTML_OPEN = 'never';
const lcov = join(out, 'coverage.lcov');
const flags = ['--test', '--experimental-test-coverage', '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
  '--test-coverage-exclude=**/test/**', '--test-coverage-exclude=**/catalog-test/**', '--test-coverage-exclude=**/evaluation/**', '--test-coverage-exclude=**/scripts/verification/**'];
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, [...flags, ...files], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', c => { stdout += c; });
child.stderr.on('data', c => { stderr += c; });
const exitCode = await new Promise(resolveExit => child.on('close', (code, signal) => resolveExit(code ?? (signal ? 1 : 0))));
writeFileSync(join(out, 'tests.tap'), stdout); writeFileSync(join(out, 'stderr.log'), stderr);
const records = existsSync(lcov) ? readFileSync(lcov, 'utf8').split('end_of_record').filter(s => s.includes('SF:')).map(record => {
  const metric = key => Number(record.match(new RegExp(`^${key}:(\\d+)$`, 'm'))?.[1] || 0);
  return { file: record.match(/^SF:(.*)$/m)?.[1], lines: metric('LF'), linesHit: metric('LH'), branches: metric('BRF'), branchesHit: metric('BRH'), functions: metric('FNF'), functionsHit: metric('FNH') };
}) : [];
const totals = records.reduce((sum, r) => { for (const key of ['lines', 'linesHit', 'branches', 'branchesHit', 'functions', 'functionsHit']) sum[key] = (sum[key] || 0) + r[key]; return sum; }, {});
const pct = (hit, all) => all ? Number((100 * hit / all).toFixed(2)) : null;
const coverage = { lines: pct(totals.linesHit, totals.lines), branches: pct(totals.branchesHit, totals.branches), functions: pct(totals.functionsHit, totals.functions), totals, files: records };
const runtimeFiles = ['cli.mjs', 'proxy.mjs', ...['providers', 'worker', 'catalog'].flatMap(dir => walk(join(root, dir)).filter(p => p.endsWith('.mjs') && !p.includes('/test/')).map(p => relative(root, p)))];
const covered = new Set(records.map(r => relative(root, resolve(root, r.file))));
const unobservedSourceFiles = runtimeFiles.filter(p => !covered.has(p));
const violations = existsSync(env.ANYMODEL_OFFLINE_GUARD_LOG) ? readFileSync(env.ANYMODEL_OFFLINE_GUARD_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const minimumLines = Number(arg('--min-lines') || '80');
const coveragePassed = coverage.lines !== null && coverage.lines >= minimumLines && unobservedSourceFiles.length === 0;
const report = { startedAt, finishedAt: new Date().toISOString(), node: process.version, command: [process.execPath, ...flags, ...files], testFiles: files.map(p => relative(root, p)), testsExitCode: exitCode, networkViolations: violations, coverage, coverageGate: { metric: 'aggregate executed runtime line coverage', minimum: minimumLines, passed: coveragePassed, unobservedSourceFiles }, limitations: ['Native coverage combines unit and fixture-integration tests; it does not separately prove integration or E2E coverage targets.', 'Legacy cli.js bundle and non-runtime build/verification scripts are outside application coverage.'], passed: exitCode === 0 && violations.length === 0 && coveragePassed };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: join(out, 'report.json'), testsExitCode: exitCode, testFiles: files.length, networkViolations: violations.length, coverage: { lines: coverage.lines, branches: coverage.branches, functions: coverage.functions }, unobservedSourceFiles, passed: report.passed }, null, 2));
process.exitCode = report.passed ? 0 : 1;
