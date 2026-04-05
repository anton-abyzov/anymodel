// Ollama provider for anymodel
// Routes to Ollama's OpenAI-compatible endpoint with num_ctx optimization
// Uses /v1/chat/completions (not /v1/messages) to enable Ollama-specific options

import http from 'http';
import { translateRequest, translateResponse, createStreamTranslator } from './openai.mjs';

// Default context size — keeps KV cache small for fast responses.
// Ollama defaults to 131K+ which causes 30-60s delays even for simple prompts.
const DEFAULT_NUM_CTX = 8192;

export default {
  name: 'ollama',

  buildRequest(url, payload) {
    // Always route to OpenAI-compatible endpoint (not /v1/messages)
    // This allows us to inject num_ctx via Ollama's extended options
    return {
      hostname: 'localhost',
      port: 11434,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  // Translate Anthropic → OpenAI format + inject Ollama options
  transformRequest(anthropicBody) {
    const openaiBody = translateRequest(anthropicBody);

    // Inject Ollama-specific options to limit KV cache allocation
    const numCtx = parseInt(process.env.OLLAMA_NUM_CTX, 10) || DEFAULT_NUM_CTX;
    openaiBody.options = { num_ctx: numCtx };

    // Disable thinking/reasoning for all models — prevents qwen3, deepseek etc.
    // from wasting output tokens on hidden chain-of-thought.
    // Models like qwen3 enable thinking by default which can add 30-120s of
    // invisible token generation before producing any visible output.
    // Inject /no_think into system message (prompt-level control, works across all API formats).
    if (openaiBody.messages?.length > 0) {
      const sysMsg = openaiBody.messages.find(m => m.role === 'system');
      if (sysMsg) {
        sysMsg.content = '/no_think\n' + sysMsg.content;
      } else {
        openaiBody.messages.unshift({ role: 'system', content: '/no_think' });
      }
    }

    return openaiBody;
  },

  // Translate OpenAI → Anthropic format
  transformResponse(openaiBody) {
    return translateResponse(openaiBody);
  },

  // Streaming translator
  createStreamTranslator() {
    return createStreamTranslator();
  },

  displayInfo(model) {
    const numCtx = parseInt(process.env.OLLAMA_NUM_CTX, 10) || DEFAULT_NUM_CTX;
    return model ? `(${model} @ localhost:11434, ctx=${numCtx})` : '(localhost:11434)';
  },

  // Check if Ollama is running locally
  detect() {
    return new Promise(resolve => {
      const req = http.get('http://localhost:11434', res => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
  },
};
