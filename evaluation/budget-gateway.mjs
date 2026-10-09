import http from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function conservativeRates(pricing) {
  const rows=[pricing,...(pricing.overrides||[])];
  const maximum=fields=>Math.max(0,...rows.flatMap(row=>fields.filter(field=>row[field]!==undefined).map(field=>{
    const rate=Number(row[field]);if(!Number.isFinite(rate)||rate<0)throw new Error(`Unusable ${field} pricing.`);return rate;
  })));
  return {input:maximum(['prompt','input_cache_read','input_cache_write']),output:maximum(['completion']),request:maximum(['request'])};
}

export function catalogModel(catalogPath, model) {
  const catalog=JSON.parse(readFileSync(catalogPath,'utf8'));
  const row=(catalog.data||catalog).find(item=>item.id===model);
  if(!row)throw new Error(`Requested model absent from frozen catalog: ${model}`);
  for(const field of ['prompt','completion','request'])if(!Number.isFinite(Number(row.pricing?.[field] ?? (field==='request'?0:NaN)))||Number(row.pricing?.[field] ?? 0)<0)throw new Error(`Unusable ${field} pricing for ${model}`);
  if(!(row.supported_parameters||[]).includes('tools'))throw new Error(`Requested model does not advertise tools: ${model}`);
  return row;
}
function reserve(path, amount, cap, request) {
  mkdirSync(dirname(path),{recursive:true});
  const lock=openSync(path+'.lock','wx');
  try {
    const ledger=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1,capUsd:cap,reservedUsd:0,requests:[]};
    if(!Number.isFinite(amount)||amount<0||!Number.isFinite(ledger.reservedUsd)||ledger.reservedUsd<0||!Array.isArray(ledger.requests))throw new Error('Invalid shared budget ledger or reservation.');
    if(ledger.capUsd!==cap)throw new Error('Shared budget cap differs from prior run.');
    if(ledger.reservedUsd+amount>cap)throw new Error('Conservative shared API budget exhausted.');
    ledger.reservedUsd+=amount;ledger.requests.push({...request,reservedUsd:amount});
    writeFileSync(path,JSON.stringify(ledger,null,2)+'\n');
    return ledger.requests.length;
  } finally {closeSync(lock);unlinkSync(path+'.lock');}
}
function hasRemoteMedia(value) {
  if(!value||typeof value!=='object')return false;
  if(['image','image_url','input_image','input_audio','audio','file','input_file','document','video_url','input_video','video','item_reference'].includes(value.type))return true;
  return Object.values(value).some(v=>Array.isArray(v)?v.some(hasRemoteMedia):hasRemoteMedia(v));
}
function receipt(raw) {
  const rows=[];
  for(const line of raw.split('\n')){
    const value=line.startsWith('data:')?line.slice(5).trim():line.trim();
    if(!value||value==='[DONE]')continue;
    try{rows.push(JSON.parse(value));}catch{}
  }
  const usages=rows.map(r=>r.usage||r.response?.usage||r.message?.usage).filter(Boolean);
  return {observedModels:[...new Set(rows.flatMap(r=>[r.model,r.response?.model,r.message?.model]).filter(Boolean))],usage:usages.at(-1)||null,costUsd:usages.findLast(u=>typeof u.cost==='number')?.cost??null};
}
export async function createBudgetGateway({key,token,model,catalogRow,ledgerPath,eventPath,capUsd=5,maxRequests=6,maxOutputTokens=2048,upstreamFetch=fetch}) {
  if(!key||!token)throw new Error('Explicit provider key and gateway token required.');
  if(!(capUsd>0&&capUsd<=5))throw new Error('Pilot total budget must be positive and no more than $5.');
  if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>24)throw new Error('Request limit must be between 1 and 24.');
  if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>4096)throw new Error('Output limit must be between 1 and 4096.');
  if(catalogRow.id!==model||['prompt','completion','request'].some(k=>!Number.isFinite(Number(catalogRow.pricing?.[k]??(k==='request'?0:NaN)))||Number(catalogRow.pricing?.[k]??0)<0))throw new Error('Invalid pinned pricing.');
  const rates=conservativeRates(catalogRow.pricing);
  const outputLimit=value=>Number.isFinite(Number(value))&&Number(value)>0?Math.min(Math.floor(Number(value)),maxOutputTokens):maxOutputTokens;
  let calls=0;const events=[];
  const record=event=>{events.push(event);if(eventPath)appendFileSync(eventPath,JSON.stringify(event)+'\n');};
  // Explicitly stateless text requests only. An allowlist rejects newly introduced
  // server-side services and prior-response references that bypass byte accounting.
  const fields=new Set(['model','messages','input','system','instructions','max_tokens','max_completion_tokens','max_output_tokens','stream','stream_options','tools','tool_choice','parallel_tool_calls','response_format','text','temperature','top_p','top_k','frequency_penalty','presence_penalty','repetition_penalty','seed','stop','stop_sequences','logit_bias','logprobs','top_logprobs','reasoning','reasoning_effort','thinking','output_config','user','metadata','verbosity','provider','n','service_tier','store']);
  const paths=new Set(['/api/v1/messages','/api/v1/chat/completions','/api/v1/responses']);
  const server=http.createServer(async(req,res)=>{
    const fail=(code,message)=>{if(!res.headersSent)res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'evaluation_gate',message}}));};
    try{
      if(req.headers.authorization!==`Bearer ${token}`&&req.headers['x-api-key']!==token)return fail(401,'Invalid evaluation gateway token.');
      const path=new URL(req.url,'http://fixture.invalid').pathname;
      if(req.method==='GET'&&path==='/api/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[catalogRow]}));return;}
      if(req.method!=='POST'||!paths.has(path))return fail(404,'Unsupported evaluation route.');
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>256*1024)return fail(413,'Evaluation input too large.');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'Expected request object.');
      if(body.model!==model)return fail(400,'Requested model differs from pinned evaluation model.');
      if(hasRemoteMedia(body))return fail(400,'Pilot accepts text-only requests.');
      if(Object.keys(body).some(k=>!fields.has(k))||(body.n!==undefined&&body.n!==1))return fail(400,'Pilot rejects unregistered fields, billing multipliers, fallback models and server services.');
      if(body.service_tier!==undefined&&!['default','auto'].includes(body.service_tier))return fail(400,'Pilot rejects premium service tiers.');
      if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(tool=>!tool||typeof tool!=='object'||(tool.type!==undefined&&!['function','custom'].includes(tool.type)))))return fail(400,'Pilot accepts only client-executed tools.');
      // OpenRouter max_price uses USD per million prompt/completion tokens.
      // Reject provider-selected price escalation rather than trusting lowest-price catalog rows.
      body.provider={allow_fallbacks:false,max_price:{prompt:Number(catalogRow.pricing.prompt)*1e6,completion:Number(catalogRow.pricing.completion)*1e6,request:Number(catalogRow.pricing.request||0)}};
      if(body.service_tier!==undefined)body.service_tier='default';
      if(calls>=maxRequests)return fail(429,'Evaluation request/step limit reached.');
      if(path.endsWith('/responses'))body.max_output_tokens=outputLimit(body.max_output_tokens);
      else if(body.max_completion_tokens!==undefined){body.max_completion_tokens=outputLimit(body.max_completion_tokens);delete body.max_tokens;}
      else body.max_tokens=outputLimit(body.max_tokens);
      if(!path.endsWith('/messages')&&!path.endsWith('/responses')&&body.stream)body.stream_options={...body.stream_options,include_usage:true};
      const payload=JSON.stringify(body);
      // For text-only BPE inputs, UTF-8 bytes plus ample message framing overhead
      // conservatively bound input tokens. No cache discounts are assumed.
      const inputTokenUpperBound=Buffer.byteLength(payload)+4096;
      const estimated=inputTokenUpperBound*rates.input+maxOutputTokens*rates.output+rates.request;
      const reservation=reserve(ledgerPath,estimated,capUsd,{model,path,at:new Date().toISOString(),inputTokenUpperBound,maxOutputTokens,rates});
      calls++;
      const start=performance.now();
      const response=await upstreamFetch('https://openrouter.ai'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`,'anthropic-version':'2023-06-01'},body:payload,redirect:'error',signal:AbortSignal.timeout(120000)});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});
      let raw='';let received=0;
      if(response.body)for await(const chunk of response.body){received+=chunk.length;if(received>4*1024*1024)throw new Error('Upstream response exceeded evaluation limit.');res.write(chunk);raw+=Buffer.from(chunk).toString();}
      res.end();
      record({reservation,path,status:response.status,ms:Math.round(performance.now()-start),...receipt(raw)});
    }catch(error){record({error:String(error.message).split(key).join('[REDACTED]').split(token).join('[TOKEN]')});if(res.headersSent)res.destroy();else fail(402,error.message.includes('budget')?error.message:'Evaluation request failed before completion.');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {server,baseURL:`http://127.0.0.1:${server.address().port}/api/v1`,events,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
