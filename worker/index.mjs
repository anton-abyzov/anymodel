// Cloudflare Worker entry point. Policy and harmless CORS preflight live together.
import { handleRequest } from './handler.mjs';

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
