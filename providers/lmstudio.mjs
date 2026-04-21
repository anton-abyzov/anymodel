// LMStudio provider — configured instance of the openai-local factory (1.12.0+).
// LMStudio exposes an OpenAI-compatible endpoint at :1234/v1 and a richer
// /api/v0/models endpoint that includes loaded-state info (v0Probe=true).
import { makeOpenAILocalProvider } from './openai-local.mjs';

export default makeOpenAILocalProvider({
  name: 'lmstudio',
  defaultPort: 1234,
  envVar: 'LMSTUDIO_BASE_URL',
  bearerStub: 'lm-studio', // server ignores, just needs non-empty
  v0Probe: true,
});
