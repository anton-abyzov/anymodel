import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetGateway, conservativeRates } from '../budget-gateway.mjs';
const row={id:'fixture/model',pricing:{prompt:'0.000001',completion:'0.000002'},supported_parameters:['tools']};
async function fixture(t,overrides={}) {
 const calls=[];const dir=mkdtempSync(join(tmpdir(),'anymodel-gate-test-'));
 const gateway=await createBudgetGateway({key:'real-fixture-key',token:'fixture-token',model:row.id,catalogRow:row,ledgerPath:join(dir,'budget.json'),upstreamFetch:async(url,opts)=>{calls.push({url,opts});return Response.json({model:row.id,usage:{prompt_tokens:10,completion_tokens:2,cost:0.000014},choices:[]});},...overrides});
 t.after(()=>gateway.close());
 const request=(body={},headers={authorization:'Bearer fixture-token'})=>fetch(gateway.baseURL+'/chat/completions',{method:'POST',headers,body:JSON.stringify({model:row.id,messages:[],...body})});
 return {gateway,calls,request,dir};
}
test('gate rejects unauthenticated, wrong models and remote media before spending',async t=>{
 const f=await fixture(t);assert.equal((await f.request({},{})).status,401);assert.equal((await f.request({model:'other'})).status,400);assert.equal((await f.request({messages:[{content:[{type:'image_url',image_url:{url:'https://x.invalid'}}]}]})).status,400);assert.equal(f.calls.length,0);
 for(const type of ['input_file','document','video_url','input_video','item_reference'])assert.equal((await f.request({messages:[{content:[{type,url:'https://x.invalid'}]}]})).status,400);
 assert.equal(f.calls.length,0);
});
test('gate clamps output, authenticates only upstream and captures actual usage',async t=>{
 const f=await fixture(t);const response=await f.request({max_tokens:99999,stream:true});assert.equal(response.status,200);await response.text();
 assert.equal(f.calls[0].opts.headers.authorization,'Bearer real-fixture-key');const body=JSON.parse(f.calls[0].opts.body);assert.equal(body.max_tokens,2048);assert.equal(body.stream_options.include_usage,true);
 assert.equal(f.gateway.events[0].costUsd,0.000014);const ledger=JSON.parse(readFileSync(join(f.dir,'budget.json')));assert.ok(ledger.reservedUsd>0);assert.equal(ledger.requests.length,1);assert.ok(!JSON.stringify(ledger).includes('real-fixture-key'));
});
test('shared budget and request limits fail closed',async t=>{
 const f=await fixture(t,{maxRequests:1});await (await f.request()).text();assert.equal((await f.request()).status,429);assert.equal(f.calls.length,1);
 const expensive=await fixture(t,{catalogRow:{...row,pricing:{prompt:'1',completion:'1'}}});assert.equal((await expensive.request()).status,402);assert.equal(expensive.calls.length,0);
});
test('invalid pricing and limits cannot bypass cap',async()=>{
 const common={key:'k',token:'t',model:row.id,catalogRow:row,ledgerPath:'/unused'};
 for(const patch of [{capUsd:Infinity},{maxRequests:0},{maxOutputTokens:-1},{catalogRow:{...row,pricing:{prompt:'0',completion:'0',request:'NaN'}}}])await assert.rejects(createBudgetGateway({...common,...patch}));
});

test('gate refuses billing multipliers, model fallbacks and server-paid tool work',async t=>{
 const f=await fixture(t);for(const body of [{n:10},{best_of:3},{models:['expensive/model']},{fallbacks:['expensive/model']},{preset:'paid-preset'},{previous_response_id:'old-context'},{conversation:'old-context'},{speed:'fast'},{plugins:[{id:'web'}]},{service_tier:'priority'},{tools:[{type:'web_search'}]}])assert.equal((await f.request(body)).status,400);assert.equal(f.calls.length,0);
 await(await f.request({provider:{max_price:{prompt:99999}}})).text();assert.deepEqual(JSON.parse(f.calls[0].opts.body).provider.max_price,{prompt:1,completion:2,request:0});
});

test('parallel requests cannot exceed the pinned per-cell request cap',async t=>{
 const f=await fixture(t,{maxRequests:2});
 const responses=await Promise.all(Array.from({length:8},()=>f.request()));
 assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(f.calls.length,2);
 await Promise.all(responses.map(r=>r.text()));
});

test('reservation includes cache-write and every context-tier surcharge',async t=>{
 const pricing={prompt:'0.000002',completion:'0.00001',input_cache_write:'0.0000025',overrides:[{min_prompt_tokens:272000,prompt:'0.000004',completion:'0.000015',input_cache_write:'0.000005'}]};
 assert.deepEqual(conservativeRates(pricing),{input:0.000005,output:0.000015,request:0});
 const f=await fixture(t,{catalogRow:{...row,pricing}});await(await f.request()).text();
 const ledger=JSON.parse(readFileSync(join(f.dir,'budget.json')));const r=ledger.requests[0];
 assert.equal(r.reservedUsd,r.inputTokenUpperBound*0.000005+2048*0.000015);
 assert.throws(()=>conservativeRates({...pricing,input_cache_write:'NaN'}));
});
