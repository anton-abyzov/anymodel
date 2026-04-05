# Adding Azure OpenAI as a New Provider for AnyModel

## Overview

Azure OpenAI uses the same OpenAI Chat Completions format but differs in authentication (API key header), URL structure (resource-based endpoints), and API versioning (query parameter). Since AnyModel already has a full OpenAI provider with bidirectional Anthropic-to-OpenAI translation, your Azure provider can reuse all of that translation logic and only override the networking and auth layer.

---

## 1. Provider File Structure

Create `providers/azure.mjs`. The provider must export this interface (matching the pattern in `providers/openai.mjs` and `providers/ollama.mjs`):

```js
// providers/azure.mjs
// Azure OpenAI provider for anymodel
// Reuses OpenAI translation layer, overrides auth and URL routing for Azure endpoints

import { translateRequest, translateResponse, createStreamTranslator } from './openai.mjs';

export default {
  name: 'azure',

  buildRequest(url, payload, apiKey) {
    // Azure OpenAI endpoints follow this pattern:
    // https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
    const resource = process.env.AZURE_OPENAI_RESOURCE;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
    const key = apiKey || process.env.AZURE_OPENAI_API_KEY;

    const hostname = `${resource}.openai.azure.com`;
    const path = `/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

    return {
      hostname,
      port: 443,
      protocol: 'https:',
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': key,                        // Azure uses api-key header, NOT Bearer auth
        'content-length': Buffer.byteLength(payload),
      },
    };
  },

  // Reuse OpenAI translation — Azure uses the same Chat Completions format
  transformRequest(body) {
    const translated = translateRequest(body);
    // Azure ignores the model field (deployment determines the model),
    // but sending it doesn't break anything, so leave it for logging.
    return translated;
  },

  transformResponse(body) {
    return translateResponse(body);
  },

  createStreamTranslator,

  displayInfo(model) {
    const resource = process.env.AZURE_OPENAI_RESOURCE || '?';
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || '?';
    return model
      ? `(${model} via Azure OpenAI: ${resource}/${deployment})`
      : `(Azure OpenAI: ${resource}/${deployment})`;
  },

  detect() {
    return !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_RESOURCE && process.env.AZURE_OPENAI_DEPLOYMENT);
  },
};
```

### Key Format Differences to Handle

| Aspect | Standard OpenAI | Azure OpenAI |
|--------|----------------|--------------|
| Auth header | `Authorization: Bearer sk-...` | `api-key: <key>` |
| Endpoint | `https://api.openai.com/v1/chat/completions` | `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions` |
| API version | Implicit | `?api-version=2024-10-21` (query param, required) |
| Model field | Required in body | Ignored (deployment determines model) |
| Request/response format | OpenAI Chat Completions | Identical to OpenAI Chat Completions |
| Streaming SSE format | OpenAI SSE | Identical to OpenAI SSE |
| Tool calling format | OpenAI function calling | Identical to OpenAI function calling |

Because the request and response wire formats are identical, all translation logic from `providers/openai.mjs` (`translateRequest`, `translateResponse`, `createStreamTranslator`) is reused directly. The only differences are in `buildRequest` (URL construction and auth header).

---

## 2. Register the Provider in cli.mjs

### 2a. Add to PROVIDERS array

In `cli.mjs`, line 19:

```js
// Before:
const PROVIDERS = ['openrouter', 'ollama', 'openai'];

// After:
const PROVIDERS = ['openrouter', 'ollama', 'openai', 'azure'];
```

### 2b. Update detectProvider()

In the `detectProvider` function (around line 90), add Azure detection before the generic OpenAI check, because `OPENAI_API_KEY` might also be set and you want Azure to take priority when Azure-specific vars are present:

```js
export async function detectProvider(model) {
  if (model && model.includes('/')) {
    return 'openrouter';
  }
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  // Azure check BEFORE generic OpenAI — more specific wins
  if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_RESOURCE) return 'azure';
  if (process.env.OPENAI_API_KEY) return 'openai';
  const { default: ollama } = await import('./providers/ollama.mjs');
  if (await ollama.detect()) return 'ollama';
  return null;
}
```

### 2c. Add Azure-specific validation in startProxyOnly()

After the OpenRouter key check (around line 366), add:

```js
if (providerName === 'azure') {
  if (!process.env.AZURE_OPENAI_API_KEY) {
    console.error(`${C.red('Error:')} AZURE_OPENAI_API_KEY environment variable is required`);
    process.exit(1);
  }
  if (!process.env.AZURE_OPENAI_RESOURCE) {
    console.error(`${C.red('Error:')} AZURE_OPENAI_RESOURCE environment variable is required`);
    console.error('This is the name of your Azure OpenAI resource (e.g., "my-openai")');
    process.exit(1);
  }
  if (!process.env.AZURE_OPENAI_DEPLOYMENT) {
    console.error(`${C.red('Error:')} AZURE_OPENAI_DEPLOYMENT environment variable is required`);
    console.error('This is the deployment name (e.g., "gpt-4o" or "my-gpt4-deployment")');
    process.exit(1);
  }
}
```

### 2d. Update help text in printHelp()

Add Azure to the Environment section and Commands section:

```
  ${C.bold('Commands:')}
    ...
    anymodel proxy azure                          ${C.cyan('# start proxy with Azure OpenAI')}

  ${C.bold('Environment:')}
    ...
    AZURE_OPENAI_API_KEY      API key for Azure OpenAI
    AZURE_OPENAI_RESOURCE     Azure resource name (e.g., "my-openai")
    AZURE_OPENAI_DEPLOYMENT   Deployment name (e.g., "gpt-4o")
    AZURE_OPENAI_API_VERSION  API version (default: 2024-10-21)
```

---

## 3. Proxy Behavior (proxy.mjs)

The proxy's `sanitizeBody()` already handles everything Azure needs:

- **cache_control**: Will be stripped (Azure does not support Anthropic prompt caching). The `keepCache` flag in `handleMessages` is only `true` for `provider.name === 'openrouter'`, so Azure gets `keepCache = false` automatically.
- **Tool schema fixing**: The `_unused` placeholder injection works identically for Azure as for OpenAI, since Azure uses the same function calling schema validation.
- **max_tokens clamping**: Azure GPT models have the same minimum requirement as OpenAI.
- **thinking field**: Not stripped by default, which is fine because Azure will simply ignore it.

No changes to `proxy.mjs` are needed. The `handleMessages` function dynamically loads the provider and calls `transformRequest`/`transformResponse`/`createStreamTranslator` if they exist — since the Azure provider exports all three, streaming and non-streaming both work.

---

## 4. Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `AZURE_OPENAI_API_KEY` | Yes | Azure OpenAI API key from the Azure portal |
| `AZURE_OPENAI_RESOURCE` | Yes | Azure resource name (the subdomain in `{resource}.openai.azure.com`) |
| `AZURE_OPENAI_DEPLOYMENT` | Yes | Deployment name you created in Azure portal |
| `AZURE_OPENAI_API_VERSION` | No | API version string (default: `2024-10-21`) |

---

## 5. Tests

Create `test/azure.test.mjs` following the pattern in `test/openai.test.mjs` and `test/providers.test.mjs`. Use `node:test` and `node:assert/strict` (no external test frameworks).

```js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('azure provider', () => {
  let savedKey, savedResource, savedDeployment, savedVersion;

  beforeEach(() => {
    savedKey = process.env.AZURE_OPENAI_API_KEY;
    savedResource = process.env.AZURE_OPENAI_RESOURCE;
    savedDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    savedVersion = process.env.AZURE_OPENAI_API_VERSION;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, saved] of [
      ['AZURE_OPENAI_API_KEY', savedKey],
      ['AZURE_OPENAI_RESOURCE', savedResource],
      ['AZURE_OPENAI_DEPLOYMENT', savedDeployment],
      ['AZURE_OPENAI_API_VERSION', savedVersion],
    ]) {
      if (saved !== undefined) process.env[key] = saved;
      else delete process.env[key];
    }
  });

  it('exports required provider interface', async () => {
    const { default: azure } = await import('../providers/azure.mjs');
    assert.equal(azure.name, 'azure');
    assert.equal(typeof azure.buildRequest, 'function');
    assert.equal(typeof azure.displayInfo, 'function');
    assert.equal(typeof azure.detect, 'function');
    assert.equal(typeof azure.transformRequest, 'function');
    assert.equal(typeof azure.transformResponse, 'function');
    assert.equal(typeof azure.createStreamTranslator, 'function');
  });

  it('buildRequest constructs correct Azure URL and auth', async () => {
    process.env.AZURE_OPENAI_RESOURCE = 'my-resource';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4o-deploy';
    process.env.AZURE_OPENAI_API_VERSION = '2024-10-21';
    process.env.AZURE_OPENAI_API_KEY = 'azure-key-123';
    const { default: azure } = await import('../providers/azure.mjs');
    const opts = azure.buildRequest('/v1/messages', '{}');
    assert.equal(opts.hostname, 'my-resource.openai.azure.com');
    assert.equal(opts.port, 443);
    assert.ok(opts.path.includes('/openai/deployments/gpt-4o-deploy/chat/completions'));
    assert.ok(opts.path.includes('api-version=2024-10-21'));
    assert.equal(opts.headers['api-key'], 'azure-key-123');
    // Must NOT have Bearer auth
    assert.equal(opts.headers['authorization'], undefined);
  });

  it('detect returns true when all Azure vars set', async () => {
    process.env.AZURE_OPENAI_API_KEY = 'key';
    process.env.AZURE_OPENAI_RESOURCE = 'res';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'dep';
    const { default: azure } = await import('../providers/azure.mjs');
    assert.equal(azure.detect(), true);
  });

  it('detect returns false when Azure vars missing', async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_RESOURCE;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    const { default: azure } = await import('../providers/azure.mjs');
    assert.equal(azure.detect(), false);
  });

  it('uses default api-version when AZURE_OPENAI_API_VERSION not set', async () => {
    process.env.AZURE_OPENAI_RESOURCE = 'res';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'dep';
    delete process.env.AZURE_OPENAI_API_VERSION;
    const { default: azure } = await import('../providers/azure.mjs');
    const opts = azure.buildRequest('/v1/messages', '{}', 'key');
    assert.ok(opts.path.includes('api-version=2024-10-21'));
  });

  it('transformRequest delegates to OpenAI translateRequest', async () => {
    const { default: azure } = await import('../providers/azure.mjs');
    const result = azure.transformRequest({
      model: 'gpt-4o',
      max_tokens: 1024,
      stream: false,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    // Should have OpenAI format: system message + user message
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.stream, false);
  });

  it('displayInfo shows resource and deployment', async () => {
    process.env.AZURE_OPENAI_RESOURCE = 'myres';
    process.env.AZURE_OPENAI_DEPLOYMENT = 'mydep';
    const { default: azure } = await import('../providers/azure.mjs');
    assert.ok(azure.displayInfo('gpt-4o').includes('myres'));
    assert.ok(azure.displayInfo('gpt-4o').includes('mydep'));
  });
});
```

Also add to `test/providers.test.mjs`:

```js
it('azure provider exports required interface', async () => {
  const { default: azure } = await import('../providers/azure.mjs');
  assert.equal(azure.name, 'azure');
  assert.equal(typeof azure.buildRequest, 'function');
  assert.equal(typeof azure.displayInfo, 'function');
  assert.equal(typeof azure.detect, 'function');
});
```

Don't forget to add a `detectProvider` test for Azure priority:

```js
it('returns azure when AZURE_OPENAI vars are set', async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.AZURE_OPENAI_API_KEY = 'key';
  process.env.AZURE_OPENAI_RESOURCE = 'res';
  const provider = await detectProvider();
  assert.equal(provider, 'azure');
});
```

---

## 6. Documentation Updates

### KNOWLEDGE-BASE.md

Update the "Three providers" section to "Four providers" and add:

```markdown
- **Azure OpenAI** (`providers/azure.mjs`) — Azure-hosted OpenAI models, reuses OpenAI translation, Azure-specific auth (`api-key` header) and URL routing (`{resource}.openai.azure.com/openai/deployments/{deployment}/...`)
```

### README.md

Add Azure to the provider list and include usage example:

```bash
# Azure OpenAI
AZURE_OPENAI_API_KEY=<key> \
AZURE_OPENAI_RESOURCE=my-resource \
AZURE_OPENAI_DEPLOYMENT=gpt-4o \
npx anymodel proxy azure
```

### site/index.html

Add Azure to the provider cards/section on the anymodel.dev homepage.

### SKILL.md (this skill file)

Update the "Three Providers" table to include Azure, add Azure env vars to the environment table.

---

## 7. Full Deployment Pipeline

After all code and docs are updated, follow the mandatory deployment pipeline:

```bash
# 1. Run ALL tests (existing + new azure tests)
node --test test/*.test.mjs

# 2. Commit and push
git add providers/azure.mjs test/azure.test.mjs cli.mjs KNOWLEDGE-BASE.md README.md site/index.html
git commit -m "add Azure OpenAI provider"
git push

# 3. Version bump and publish to npm
npm version patch
npm run sync-version
npm publish

# 4. Deploy website (site/ was changed)
vercel --prod

# 5. No client repo changes needed (cli.js unchanged)
```

---

## 8. Summary of Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `providers/azure.mjs` | **Create** | New provider (reuses OpenAI translation, Azure auth + URL) |
| `test/azure.test.mjs` | **Create** | Provider-specific tests |
| `cli.mjs` | **Modify** | Add `'azure'` to PROVIDERS, update `detectProvider()`, add validation in `startProxyOnly()`, update help text |
| `test/providers.test.mjs` | **Modify** | Add Azure interface test and detectProvider test |
| `KNOWLEDGE-BASE.md` | **Modify** | Add Azure provider docs |
| `README.md` | **Modify** | Add Azure usage instructions |
| `site/index.html` | **Modify** | Add Azure to provider listing |

No changes needed to `proxy.mjs` -- the sanitization and routing logic handles Azure automatically through the provider interface.

---

## 9. Usage (End Result)

```bash
# Terminal 1: Start proxy with Azure OpenAI
AZURE_OPENAI_API_KEY=abc123 \
AZURE_OPENAI_RESOURCE=my-company-openai \
AZURE_OPENAI_DEPLOYMENT=gpt-4o \
npx anymodel proxy azure

# Terminal 2: Connect
npx anymodel
```

The proxy banner will display:

```
  anymodel v1.6.41

  <->  Proxy on :9090
     /v1/messages -> azure (gpt-4o via Azure OpenAI: my-company-openai/gpt-4o)
     everything else -> passthrough
     Retries: 3 with exponential backoff
```
