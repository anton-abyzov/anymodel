#!/usr/bin/env node
// Deliberately opt-in: importing/--help never invokes a model.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TASKS, taskById, fixtureSource, sha256 } from './tasks.mjs';
import { scoreTask } from './scoring.mjs';
import { catalogModel, createBudgetGateway } from './budget-gateway.mjs';
import { createEvaluationProxy } from './proxy-route.mjs';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const help=`Opt-in bounded pilot, no local models. Node 22 required.
node evaluation/run-pilot.mjs --execute --arm native|frontier-direct|frontier-proxy|qwen-direct --model EXACT_ID --task all|dictionary|worker-auth|reasoning-budget --out EXTERNAL_DIR [--root SOURCE_ROOT] [--catalog FROZEN_JSON --budget-file SHARED_JSON]
Hosted arms require OPENROUTER_API_KEY in this process only. The same shared budget-file is mandatory across hosted arms/protocol checks; cap is $4.75, conservatively reserved before each request. Native uses existing Codex authentication, no OAuth copies.
Optional --opencode PATH --codex PATH; versions must be OpenCode 1.14.33 / Codex 0.161.0.`;
if(process.argv.includes('--help')||!process.argv.includes('--execute')){console.log(help);process.exit(process.argv.includes('--help')?0:2);}
if(process.versions.node.split('.')[0]!=='22')throw new Error('Use Node 22.');
const arm=arg('--arm');if(!['native','frontier-direct','frontier-proxy','qwen-direct'].includes(arm))throw new Error('Explicit arm required.');
const native=arm==='native',model=arg('--model'),out=arg('--out')&&resolve(arg('--out'));
if(!model||!out)throw new Error('Explicit model and external output directory required.');
const root=resolve(arg('--root')||fileURLToPath(new URL('..',import.meta.url)));
if(out===root||out.startsWith(root+'/'))throw new Error('Keep evaluation artifacts outside the product checkout.');
const selected=arg('--task')&&arg('--task')!=='all'?[taskById(arg('--task'))]:TASKS;
const key=process.env.OPENROUTER_API_KEY;
const catalogPath=arg('--catalog'),budgetFile=arg('--budget-file')&&resolve(arg('--budget-file'));
if(!native&&(!key||!catalogPath||!budgetFile))throw new Error('Hosted arms require explicit key, catalog and shared budget file.');
const row=native?null:catalogModel(catalogPath,model);
const executable=native?(arg('--codex')||join(dirname(process.execPath),'codex')):(arg('--opencode')||join(process.env.HOME,'.opencode/bin/opencode'));
const version=spawnSync(executable,['--version'],{encoding:'utf8'});
if(version.status!==0||!version.stdout.includes(native?'0.161.0':'1.14.33'))throw new Error('Unexpected runtime version; re-register the evaluation before changing runtimes.');
const rootRevision=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
mkdirSync(out,{recursive:true});
const cleanEnv=()=>{const env={...process.env};for(const k of Object.keys(env))if(/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BASE_URL|ENDPOINT)/i.test(k)||/^(?:OLLAMA|LOCAL_|LMSTUDIO|LLAMACPP|ANYMODEL_|PROXY_|OPENCODE_)/.test(k))delete env[k];delete env.NODE_OPTIONS;delete env.NODE_V8_COVERAGE;env.PATH=dirname(process.execPath)+':'+(env.PATH||'');env.PWDEBUG='0';env.PLAYWRIGHT_HTML_OPEN='never';return env;};
const redact=(s,token)=>String(s).split(key||'\u0000').join('[REDACTED]').split(token).join('[EVALUATION_TOKEN]');
const git=(dir,args)=>{const r=spawnSync('git',['-C',dir,...args],{encoding:'utf8',env:cleanEnv()});if(r.status!==0)throw new Error(`Fixture git command failed: ${args[0]}`);return r.stdout;};
async function execute(exe,args,env,token){
 const start=performance.now();let stdout='',stderr='',timedOut=false,overflow=false,spawnError=null;
 const child=spawn(exe,args,{env,stdio:['ignore','pipe','pipe']});
 let hardTimer;
 const stop=()=>{child.kill('SIGTERM');hardTimer=setTimeout(()=>child.kill('SIGKILL'),3000);};
 const timer=setTimeout(()=>{timedOut=true;stop();},360000);
 const collect=which=>chunk=>{const value=redact(chunk.toString(),token);if(stdout.length+stderr.length+value.length>8*1024*1024){overflow=true;stop();return;}if(which==='out')stdout+=value;else stderr+=value;};
 child.stdout.on('data',collect('out'));child.stderr.on('data',collect('err'));child.on('error',error=>{spawnError=redact(error.message,token);});
 const result=await new Promise(r=>child.on('close',(code,signal)=>r({exitCode:code,signal})));
 clearTimeout(timer);clearTimeout(hardTimer);
 return {...result,stdout,stderr,timedOut,overflow,spawnError,ms:Math.round(performance.now()-start)};
}
const summaries=[];
for(const task of selected){
 const cell=join(out,`${arm}-${task.id}-${Date.now()}`);mkdirSync(cell,{recursive:true});
 const scratch=join(cell,'workspace');mkdirSync(scratch);const target=join(scratch,'target.mjs');
 const source=fixtureSource(task.id);writeFileSync(target,source);
 writeFileSync(join(scratch,'package.json'),'{"type":"module","private":true}\n');
 writeFileSync(join(scratch,'AGENTS.md'),'Work only in this scratch repository. Modify target.mjs only. Do not access parent directories, credentials, network services, external tools, or other repositories. Hidden tests run after your final answer.\n');
 git(scratch,['init','--quiet']);git(scratch,['add','.']);git(scratch,['-c','user.name=AnyModel Evaluation','-c','user.email=evaluation@invalid','commit','--quiet','-m','Frozen public source fixture']);
 const initialNames=new Set(readdirSync(scratch));
 const token='anymodel-eval-'+randomUUID();let gateway,proxy;
 const env=cleanEnv();let args;
 try{
  if(native){
   args=['exec','--ignore-user-config','--ephemeral','--sandbox','workspace-write','--json','-C',scratch,'--model',model,'-o',join(cell,'last-message.txt'),task.prompt];
  }else{
   gateway=await createBudgetGateway({key,token,model,catalogRow:row,ledgerPath:budgetFile,capUsd:4.75,maxRequests:6,maxOutputTokens:2048});
   if(arm==='frontier-proxy')proxy=await createEvaluationProxy(root,gateway,model,token);
   const state=join(cell,'state');for(const kind of ['config','data','cache','state']){mkdirSync(join(state,kind),{recursive:true});env['XDG_'+kind.toUpperCase()+'_HOME']=join(state,kind);}
   env.OPENCODE_CONFIG_DIR=join(state,'config');env.OPENROUTER_API_KEY=token;
   for(const flag of ['AUTOCOMPACT','AUTOUPDATE','CHANNEL_DB','CLAUDE_CODE','CLAUDE_CODE_PROMPT','CLAUDE_CODE_SKILLS','DEFAULT_PLUGINS','EMBEDDED_WEB_UI','EXTERNAL_SKILLS','LSP_DOWNLOAD','MODELS_FETCH','PROJECT_CONFIG','PRUNE','SHARE','TERMINAL_TITLE'])env['OPENCODE_DISABLE_'+flag]='1';
   const permission={'*':'deny',read:'allow',edit:'allow',glob:'allow',grep:'allow',list:'allow',external_directory:'deny',bash:'deny',task:'deny',webfetch:'deny',websearch:'deny',skill:'deny',lsp:'deny',question:'deny'};
   env.OPENCODE_CONFIG_CONTENT=JSON.stringify({$schema:'https://opencode.ai/config.json',share:'disabled',autoupdate:false,enabled_providers:['openrouter'],model:'openrouter/'+model,small_model:'openrouter/'+model,permission,provider:{openrouter:{options:{baseURL:proxy?.baseURL||gateway.baseURL,apiKey:'{env:OPENROUTER_API_KEY}'},models:{[model]:{name:model,limit:{context:row.context_length||32768,output:2048}}}}},agent:{eval:{mode:'primary',model:'openrouter/'+model,steps:6,permission,prompt:'You are repairing a single-file JavaScript fixture. Read and edit target.mjs with the file tools. No shell or external access. Finish with a concise description.'}}});
   args=['run','--pure','--format','json','--model','openrouter/'+model,'--agent','eval','--dir',scratch,task.prompt];
  }
  writeFileSync(join(cell,'prompt.txt'),task.prompt+'\n');
  const startedAt=new Date().toISOString();const run=await execute(executable,args,env,token);
  writeFileSync(join(cell,'events.jsonl'),run.stdout);writeFileSync(join(cell,'stderr.log'),run.stderr);
  const events=run.stdout.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
  const runtimeErrors=events.filter(e=>e.type==='error'||e.type==='turn.failed'||e.error||e.item?.type==='error');
  const toolErrors=events.filter(e=>e.part?.state?.status==='error'||(e.item?.type==='command_execution'&&typeof e.item.exit_code==='number'&&e.item.exit_code!==0));
  const errors=[...runtimeErrors,...toolErrors];
  const complete=native?events.some(e=>e.type==='turn.completed'):events.some(e=>e.type==='step_finish'&&['stop','end_turn'].includes(e.part?.reason));
  const diff=git(scratch,['diff','--','target.mjs']);writeFileSync(join(cell,'change.diff'),diff);
  const trackedChanged=git(scratch,['diff','--name-only','HEAD']).trim().split('\n').filter(Boolean);
  const newNames=readdirSync(scratch).filter(name=>!initialNames.has(name));
  const forbiddenChanges=[...trackedChanged.filter(name=>name!=='target.mjs'),...newNames];
  const scoring=scoreTask(task.id,target);
  const cleanCompletion=run.exitCode===0&&!run.timedOut&&!run.overflow&&!run.spawnError&&complete&&runtimeErrors.length===0;
  const knownCost=gateway?.events.map(e=>e.costUsd).filter(x=>typeof x==='number')||[];
  const report={arm,task:task.id,requestedModel:model,observedModels:[...new Set(gateway?.events.flatMap(e=>e.observedModels||[])||[])],runtime:{path:executable,version:version.stdout.trim()},sourceRevision:rootRevision,fixtureHash:sha256(source),testHash:scoring.testHash,startedAt,finishedAt:new Date().toISOString(),ms:run.ms,exitCode:run.exitCode,signal:run.signal,timedOut:run.timedOut,outputOverflow:run.overflow,spawnError:run.spawnError,completionEvent:complete,cleanCompletion,artifactPassed:scoring.artifactPassed,scoring,forbiddenChanges,toolOrRuntimeErrors:errors,runtimeErrorCount:runtimeErrors.length,toolErrorCount:toolErrors.length,toolErrorRecoveryObserved:toolErrors.length>0&&cleanCompletion,providerRequests:gateway?.events||[],knownApiCostUsd:knownCost.length?knownCost.reduce((a,b)=>a+b,0):null,billing:native?'existing native subscription/authentication; monetary cost unavailable':'OpenRouter API; absent provider cost is unknown; conservative shared reservations are not actual spend',interventions:0,repetitions:1,passed:scoring.artifactPassed&&cleanCompletion&&forbiddenChanges.length===0,limitations:['Three repair fixtures, one repetition per cell; not a quality ranking, parity proof, Studio session, or speed/cost benchmark.','Resume, long-context pressure and multi-agent Studio workflows are untested.',native?'Native Codex CLI has six-minute timeout; no enforced six-step or API output-token limit.':'OpenCode has six steps, six provider requests, 2048 output tokens/request; shell/external access denied.']};
  writeFileSync(join(cell,'report.json'),JSON.stringify(report,null,2)+'\n');
  summaries.push({task:task.id,report:join(cell,'report.json'),passed:report.passed,artifactPassed:report.artifactPassed,cleanCompletion});
  console.log(JSON.stringify(summaries.at(-1)));
 }finally{await proxy?.close();await gateway?.close();}
}
writeFileSync(join(out,`${arm}-summary.json`),JSON.stringify({arm,model,results:summaries},null,2)+'\n');
process.exitCode=summaries.every(r=>r.passed)?0:1;
