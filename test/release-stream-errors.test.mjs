import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxy } from '../proxy.mjs';
import openai, { createStreamTranslator } from '../providers/openai.mjs';
import openrouter from '../providers/openrouter.mjs';

const textEvent = 'data: {"id":"fixture","choices":[{"delta":{"content":"working"}}]}\n\n';
function assertFailure(wire) {
  assert.match(wire, /event: error/);
  assert.doesNotMatch(wire, /event: message_stop|"stop_reason":"end_turn"/);
}

for (const [name, chunks] of [
  ['colon without space', ['data:{"error":{"message":"failed"}}\n\n']],
  ['fragmented CRLF error event', ['data:{"error":', '{"message":"failed"}}\r', '\n\r', '\n']],
  ['CR-delimited error event', ['data:{"error":{"message":"failed"}}\r\r']],
  ['multiline event', ['data: {"error":\ndata:{"message":"failed"}}\n\n']],
  ['named error event', ['event:error\ndata:{"message":"failed"}\n\n']],
  ['malformed hosted event', ['data: {invalid}\n\n']],
]) {
  test(`hosted SSE preserves failure: ${name}`, () => {
    const t = createStreamTranslator();
    let wire = chunks.map(chunk => t.transform(chunk)).join('');
    wire += t.transform('data: [DONE]\n\n') + t.flush();
    assertFailure(wire);
    assert.equal((wire.match(/event: error/g) || []).length, 1);
  });
}

for (const [name, chunk] of [
  ['empty EOF', ''], ['partial content EOF', textEvent],
  ['incomplete JSON at EOF', textEvent + 'data:{"error":'],
  ['unterminated SSE event', textEvent + 'data:{"error":{"message":"failed"}}\n'],
]) {
  test(`hosted EOF cannot fabricate completion: ${name}`, () => {
    const t = createStreamTranslator();
    assertFailure(t.transform(chunk) + t.flush());
    assert.equal(t.flush(), '');
  });
}

test('complete hosted streams retain text, usage and one terminal event', () => {
  for (const done of ['', 'data:[DONE]\n\n']) {
    const t = createStreamTranslator();
    const wire = t.transform(textEvent + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n' + done) + t.flush();
    assert.match(wire, /working/); assert.match(wire, /"input_tokens":9/); assert.match(wire, /"output_tokens":3/);
    assert.equal((wire.match(/event: message_stop/g) || []).length, 1);
    assert.doesNotMatch(wire, /event: error/);
  }
});

test('explicit local compatibility retains EOF finalization without hosted terminal signals', () => {
  const t = createStreamTranslator({localProvider:true});
  const wire=t.transform(textEvent)+t.flush();
  assert.match(wire,/event: message_stop/); assert.doesNotMatch(wire,/event: error/);
});

async function withFixture(providerBase, produce, run) {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});produce(res);});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const buildRequest=()=>({hostname:'127.0.0.1',port:upstream.address().port,path:'/fixture',protocol:'http:',method:'POST',headers:{'content-type':'application/json'}});
  const provider={...providerBase,buildRequest,buildWireRequest:buildRequest,warmup:undefined};
  const key=provider.name==='openrouter'?'OPENROUTER_API_KEY':'OPENAI_API_KEY';const saved=process.env[key];process.env[key]='synthetic-fixture-key';
  const proxy=createProxy(provider,{port:0});await once(proxy,'listening');
  try {await run(proxy.address().port);}finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);if(saved===undefined)delete process.env[key];else process.env[key]=saved;}
}
function request(port,path='/v1/messages') {
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method:'POST',headers:{'content-type':'application/json'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('aborted',()=>resolve({body,aborted:true}));res.on('error',()=>resolve({body,aborted:true}));res.on('end',()=>resolve({body,aborted:false}));});req.on('error',reject);req.end(JSON.stringify({model:'fixture',max_tokens:64,stream:true,messages:[{role:'user',content:'test'}],input:'test'}));});
}

test('real Messages conversion sends an error for hosted partial EOF',async()=>{
  await withFixture(openai,res=>res.end(textEvent),async port=>{const result=await request(port);assert.equal(result.aborted,false);assertFailure(result.body);});
});
test('real Messages conversion accepts a no-space error without turning it into success',async()=>{
  await withFixture(openai,res=>res.end(textEvent+'data:{"error":{"message":"fixture error"}}\n\ndata:[DONE]\n\n'),async port=>{const result=await request(port);assertFailure(result.body);assert.match(result.body,/fixture error/);});
});
for(const route of ['/v1/messages','/v1/responses','/v1/chat/completions']) {
  test(`raw OpenRouter ${route} propagates a reset as aborted transport`,async()=>{
    await withFixture(openrouter,res=>{res.write(textEvent);setImmediate(()=>res.destroy(new Error('fixture reset')));},async port=>{const result=await request(port,route);assert.equal(result.aborted,true);assert.doesNotMatch(result.body,/message_stop/);});
  });
}
