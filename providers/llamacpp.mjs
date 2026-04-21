// llama.cpp / llama-server provider — configured instance of openai-local factory (1.12.0+).
// llama-server exposes an OpenAI-compatible endpoint at :8080/v1. No native /api/v0/models,
// so v0Probe stays false — we use only /v1/models which doesn't surface loaded state.
import { makeOpenAILocalProvider } from './openai-local.mjs';

export default makeOpenAILocalProvider({
  name: 'llamacpp',
  defaultPort: 8080,
  envVar: 'LLAMACPP_BASE_URL',
  bearerStub: 'no-key', // llama-server ignores the Bearer token entirely
  v0Probe: false,
});
