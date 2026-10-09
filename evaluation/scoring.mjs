import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sha256 } from './tasks.mjs';

const suites = {
  dictionary: `
for (const [name, schema] of [
 ['root', {type:'object',properties:{},additionalProperties:{type:'string'}}],
 ['no-properties', {type:'object',additionalProperties:true}],
 ['nested', {type:'object',properties:{headers:{type:'object',properties:{},additionalProperties:{type:'string'}}}}],
 ['array', {type:'array',items:{type:'object',properties:{},additionalProperties:{type:'number'}}}],
 ['alternative', {anyOf:[{type:'object',properties:{},additionalProperties:true},{type:'null'}]}],
 ['closed', {type:'object',properties:{},additionalProperties:false}],
]) await check(name,()=>{
 const original=structuredClone(schema);const body={tools:[{name:'fixture',input_schema:schema}]};m.sanitizeBody(body,{keepCache:true});
 function inspect(before,after){for(const [k,v]of Object.entries(before)){if(k==='additionalProperties')assert.deepEqual(after[k],v);else if(v&&typeof v==='object')inspect(v,after[k]);}}
 inspect(original,body.tools[0].input_schema);
});
await check('named-parameter-preserved',()=>{const b={tools:[{name:'f',input_schema:{type:'object',properties:{x:{type:'string'}},required:['x']}}]};m.sanitizeBody(b);assert.deepEqual(b.tools[0].input_schema.required,['x']);});`,
  'worker-auth': `
const key='sk-or-fixture-server',token='fixture-gateway',caller='sk-or-fixture-caller';let calls=[];
globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return new Response('{}',{status:200});};
const req=(headers={},path='/v1/messages',method='POST')=>new Request('https://fixture.invalid'+path,{method,headers,...(method==='GET'?{}:{body:JSON.stringify({model:'fixture/model:free',messages:[]})})});
const reset=()=>{calls=[];m.handleRequest._rateState={};};
for(const [name,headers]of [['missing',{}],['wrong',{authorization:'Bearer wrong'}],['byok-without-gateway',{'x-api-key':caller}]])await check(name,async()=>{reset();const r=await m.handleRequest(req(headers),{ANYMODEL_TOKEN:token,OPENROUTER_API_KEY:key});assert.equal(r.status,401);assert.equal(calls.length,0);});
for(const headers of [{authorization:'Bearer '+token},{'x-api-key':token}])await check('authorized-'+Object.keys(headers)[0],async()=>{reset();const r=await m.handleRequest(req(headers),{ANYMODEL_TOKEN:token,OPENROUTER_API_KEY:key});assert.equal(r.status,200);assert.equal(calls[0].opts.headers.authorization,'Bearer '+key);});
await check('byok-plus-gateway',async()=>{reset();const r=await m.handleRequest(req({authorization:'Bearer '+token,'x-api-key':caller}),{ANYMODEL_TOKEN:token,OPENROUTER_API_KEY:key});assert.equal(r.status,200);assert.equal(calls[0].opts.headers.authorization,'Bearer '+caller);});
await check('no-unprotected-server-funding',async()=>{reset();const r=await m.handleRequest(req(),{OPENROUTER_API_KEY:key});assert.equal(r.status,401);assert.equal(calls.length,0);});
await check('public-byok',async()=>{reset();const r=await m.handleRequest(req({'x-api-key':caller}),{});assert.equal(r.status,200);assert.equal(calls[0].opts.headers.authorization,'Bearer '+caller);});
await check('arbitrary-route-needs-auth',async()=>{reset();const r=await m.handleRequest(req({},'/anything'),{ANYMODEL_TOKEN:token,OPENROUTER_API_KEY:key});assert.equal(r.status,401);assert.equal(calls.length,0);});
await check('public-health',async()=>{reset();assert.equal((await m.handleRequest(req({},'/health','GET'),{ANYMODEL_TOKEN:token})).status,200);assert.equal(calls.length,0);});`,
  'reasoning-budget': `
const b=(model,effort='high')=>({model,max_tokens:123,__anymodel_effort:effort,messages:[{role:'user',content:'fixture'}]});
process.env.OPENAI_BASE_URL='https://api.openai.com/v1';delete process.env.ANYMODEL_FORWARD_EFFORT;
for(const model of ['o3','gpt-5.4','gpt-6.1-sol'])await check('budget-'+model,()=>{const r=m.default.transformRequest(b(model));assert.equal(r.max_completion_tokens,123);assert.equal(r.max_tokens,undefined);});
for(const effort of ['none','minimal','low','medium','high','xhigh','max'])await check('effort-'+effort,()=>assert.equal(m.default.transformRequest(b('gpt-5.4',effort)).reasoning_effort,effort));
await check('fallback-budget',()=>{const input=b('gpt-5.4');delete input.max_tokens;input.max_output_tokens=37;assert.equal(m.default.transformRequest(input).max_completion_tokens,37);});
await check('legacy-budget',()=>assert.equal(m.default.transformRequest(b('gpt-4o')).max_tokens,123));
await check('effort-optout',()=>{process.env.ANYMODEL_FORWARD_EFFORT='off';assert.equal(m.default.transformRequest(b('gpt-5.4')).reasoning_effort,undefined);delete process.env.ANYMODEL_FORWARD_EFFORT;});
await check('custom-default',()=>{process.env.OPENAI_BASE_URL='http://fixture.invalid/v1';const r=m.default.transformRequest(b('gpt-5.4'));assert.equal(r.reasoning_effort,undefined);assert.equal(r.max_completion_tokens,123);assert.equal(m.default.transformRequest(b('fixture-custom-model')).max_tokens,123);});`,
};
export function hiddenTestSource(taskId, targetPath) {
  if (!suites[taskId]) throw new Error('Unknown scoring suite');
  return `import assert from 'node:assert/strict';\nconst m=await import(${JSON.stringify(pathToFileURL(targetPath).href)});const results=[];async function check(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}\n${suites[taskId]}\nconsole.log(JSON.stringify({checks:results,passed:results.every(r=>r.passed),passedCount:results.filter(r=>r.passed).length,total:results.length}));\n`;
}
export function scoreTask(taskId, targetPath) {
  const source = hiddenTestSource(taskId, targetPath);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PWDEBUG:'0', PLAYWRIGHT_HTML_OPEN:'never' };
  const guard = fileURLToPath(new URL('../scripts/verification/offline-guard.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', source], { env, encoding:'utf8', timeout:15000, maxBuffer:1024*1024 });
  let result;
  try { result=JSON.parse((run.stdout||'').trim().split('\n').at(-1)); } catch { result={passed:false,passedCount:0,total:null,error:(run.stderr||'No scorer result').slice(0,2000)}; }
  return {...result,scorerExitCode:run.status,testHash:sha256(suites[taskId]),artifactPassed:run.status===0&&result.passed===true};
}
