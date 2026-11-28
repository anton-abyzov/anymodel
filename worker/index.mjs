// Cloudflare Worker entry point. Policy and harmless CORS preflight live together.
import { handleRequest } from './handler.mjs';

export const RETIRED_MESSAGE =
  'The hosted AnyModel endpoint was retired on November 27, 2026. AnyModel runs locally with your own API key or a local model: https://github.com/anton-abyzov/anymodel#hosted-endpoint-retired';

// While RETIRED is "true", every request gets 410 before any other handling,
// so no model call, key or rate-limit state is touched. Unset it to restore.
export function retiredResponse() {
  return new Response(JSON.stringify({ error: { type: 'gone', message: RETIRED_MESSAGE } }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  fetch(request, env) {
    if (env?.RETIRED === 'true') return retiredResponse();
    return handleRequest(request, env);
  },
};
