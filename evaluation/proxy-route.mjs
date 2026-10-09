import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
export async function createEvaluationProxy(root, gateway, model, token) {
  const { createProxy } = await import(pathToFileURL(resolve(root,'proxy.mjs')));
  const { default: original } = await import(pathToFileURL(resolve(root,'providers/openrouter.mjs')));
  const address = new URL(gateway.baseURL);
  const routed = {...original, warmup:undefined, buildRequest(url,payload,key) {
    return {...original.buildRequest(url,payload,key),hostname:'127.0.0.1',port:Number(address.port),protocol:'http:'};
  }};
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = token;
  const server = createProxy(routed,{port:0,host:'127.0.0.1',model,token,rpm:120,maxPortRetries:0});
  await once(server,'listening');
  return {baseURL:`http://127.0.0.1:${server.address().port}/v1`,close:async()=>{
    await new Promise(r=>{server.closeAllConnections();server.close(r);});
    if(previous===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=previous;
  }};
}
