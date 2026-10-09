import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CATALOG_URL, MODEL_PRESETS, normalizeCatalog, fetchCatalog, checkModel, filterModels, preflightOpenRouterModel, runCatalogCommand } from '../catalog/openrouter.mjs';
import { findClient, parseArgs, proxyClientEnvironment } from '../cli.mjs';

const data = { data: [
  { id: 'example/paid', name: 'Paid', supported_parameters: ['tools'], pricing: { prompt: '0.0001', completion: '0.0002' } },
  { id: 'example/model:free', name: 'Free', context_length: 8192, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0', request: '0' } },
  { id: 'example/unknown', name: 'Unknown', pricing: { prompt: '0' } },
] };
const mockFetch = async () => new Response(JSON.stringify(data));
const catalog = normalizeCatalog(data, '2026-10-09T00:00:00.000Z');

test('public discovery sends no credentials, local probes or model requests', async () => {
  const seen = [];
  const result = await fetchCatalog({ fetchImpl: async (url, init) => { seen.push({url, init}); return mockFetch(); } });
  assert.equal(seen.length, 1); assert.equal(seen[0].url, CATALOG_URL);
  assert.deepEqual(seen[0].init.headers, { accept: 'application/json' });
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(result.models.length, 3); assert.match(result.scope, /not account access/);
});

test('legacy free aliases retain exact IDs and fail when unavailable', () => {
  for (const name of ['qwen', 'llama']) {
    assert.equal(parseArgs([name]).model, MODEL_PRESETS[name]);
    assert.ok(MODEL_PRESETS[name].endsWith(':free'));
    assert.throws(() => checkModel(catalog, name), error => error.code === 'model_unavailable' && /No replacement/.test(error.message));
  }
  assert.throws(() => checkModel(catalog, 'constructor'), /absent/);
});

test('preflight rejects unavailable IDs before any inference can happen', async () => {
  await assert.rejects(preflightOpenRouterModel('missing/model', {fetchImpl: mockFetch}), /absent.*No replacement/);
});

test('catalog outage and invalid payload are unknown, not available', async () => {
  await assert.rejects(fetchCatalog({fetchImpl: async () => {throw new Error('private diagnostic');}}), /Could not verify/);
  await assert.rejects(fetchCatalog({fetchImpl: async () => new Response('denied',{status:503})}), /HTTP 503/);
  await assert.rejects(fetchCatalog({fetchImpl: async () => new Response('{')}), /Could not verify/);
  assert.throws(() => normalizeCatalog({data:[]}), /empty or invalid/);
});

test('free checks reject paid, unknown and newly priced free IDs', () => {
  assert.equal(checkModel(catalog, 'example/model:free', {freeOnly:true}).available, true);
  for (const id of ['example/paid','example/unknown']) assert.throws(() => checkModel(catalog,id,{freeOnly:true}), /not verified as zero-priced/);
  const changed=normalizeCatalog({data:[{id:'example/model:free',pricing:{prompt:'0',completion:'0',request:'1'}}]});
  assert.throws(() => checkModel(changed,'example/model:free'), /no paid replacement/);
});

test('catalog filters include only advertised capabilities and observed zero prices', () => {
  assert.deepEqual(filterModels(catalog,{freeOnly:true,tools:true}).map(m=>m.id),['example/model:free']);
  assert.deepEqual(filterModels(catalog,{search:'PAID'}).map(m=>m.id),['example/paid']);
  assert.equal(checkModel(catalog,'example/unknown').contextLength,null);
});

test('catalog JSON retains observation scope and exact selected model', async () => {
  const output=[];
  await runCatalogCommand('check',['example/paid','--json'],{fetchImpl:mockFetch,log:x=>output.push(JSON.parse(x))});
  assert.equal(output[0].id,'example/paid'); assert.equal(output[0].available,true);
  assert.match(output[0].scope,/native subscription entitlement/);
  await assert.rejects(runCatalogCommand('models',['--search'],{fetchImpl:()=>{throw new Error('must not fetch');}}),/Unknown or incomplete/);
});

test('catalog body is bounded', async () => {
  await assert.rejects(fetchCatalog({fetchImpl:async()=>new Response('x'.repeat(8*1024*1024+1))}),/8 MiB/);
});

test('native client wins and automatic bundle/cwd lookup is absent', () => {
  const paths=[];
  const client=findClient({env:{},locateNative:()=>'/owned/bin/claude',exists:path=>{paths.push(path);return true;}});
  assert.equal(client.cmd,'/owned/bin/claude'); assert.deepEqual(paths,['/owned/bin/claude']);
  assert.equal(findClient({env:{},locateNative:()=>'',exists:()=>true}),null);
});

test('explicit client is honored; missing explicit client fails without fallback', () => {
  assert.equal(findClient({env:{ANYMODEL_CLIENT:'/authorized/client.mjs'},exists:()=>true,locateNative:()=>{throw new Error('must not resolve');}}).args[0],'/authorized/client.mjs');
  assert.equal(findClient({env:{ANYMODEL_CLIENT:'/authorized/claude'},exists:()=>true}).cmd,'/authorized/claude');
  assert.throws(()=>findClient({env:{ANYMODEL_CLIENT:'/missing'},exists:()=>false}),/does not exist/);
});

test('proxy client uses only the proxy auth and exact backend model', () => {
  const env=proxyClientEnvironment(9012,'provider/model','proxy-token',{ANTHROPIC_API_KEY:'real-key',ANTHROPIC_AUTH_TOKEN:'other-token',CLAUDE_CODE_OAUTH_TOKEN:'oauth',CLAUDE_CODE_USE_VERTEX:'1',ANTHROPIC_MODEL:'old',PATH:'/bin'});
  assert.equal(env.ANTHROPIC_BASE_URL,'http://127.0.0.1:9012'); assert.equal(env.ANTHROPIC_API_KEY,'');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN,'proxy-token'); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,'');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX,''); assert.equal(env.ANTHROPIC_MODEL,'provider/model'); assert.equal(env.PATH,'/bin');
});

test('CLI help describes adapter scope without loading a client or using inference', () => {
  const result=spawnSync(process.execPath,['cli.mjs','--help'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000});
  assert.equal(result.status,0); assert.match(result.stdout,/optional API compatibility/);
  assert.match(result.stdout,/anymodel models/); assert.match(result.stdout,/No bundled client is selected/);
});

test('live CLI stale-preset failure exits before binding proxy', () => {
  const stub=`globalThis.fetch=async(url,options)=>{if(url!==${JSON.stringify(CATALOG_URL)})throw new Error('Unexpected network');return new Response(${JSON.stringify(JSON.stringify(data))})};`;
  const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(stub)}`,'cli.mjs','proxy','qwen'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,OPENROUTER_API_KEY:'synthetic-test-key'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,2,result.stderr); assert.match(result.stderr,/absent.*No replacement/);
  assert.doesNotMatch(result.stdout,/Listening|listening|Next step/);
});

// Package version must not fall through to the proxy health/client path.
test('CLI version is package metadata and never connects to a proxy', () => {
  const result=spawnSync(process.execPath,['cli.mjs','--version'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000});
  assert.equal(result.status,0);
  assert.equal(result.stdout.trim(),JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version);
});
