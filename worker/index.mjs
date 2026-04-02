// Cloudflare Worker entry point for anymodel proxy
import { handleRequest } from './handler.mjs';

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
          'access-control-max-age': '86400',
        },
      });
    }

    return handleRequest(request, env);
  },
};
