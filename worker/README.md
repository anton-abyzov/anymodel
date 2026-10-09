# AnyModel hosted compatibility worker

This worker accepts Anthropic Messages requests and sends them to OpenRouter. It supports only `POST /v1/messages`, `POST /v1/messages/count_tokens`, public `GET /health`, and harmless CORS preflight for the two POST routes. Unsupported routes return 404; they never forward to Anthropic or fabricate authentication success. Native Studio agents remain separate from this optional API compatibility service.

## Funding and authentication

The handler has two explicit policies:

- **Caller BYOK:** without `ANYMODEL_TOKEN`, each request must supply its own OpenRouter key through `Authorization: Bearer <OpenRouter key>` or `x-api-key`. A configured server key is never used in this mode.
- **Authenticated access:** when `ANYMODEL_TOKEN` exists, every non-public request must provide that exact gateway token. With a configured `OPENROUTER_API_KEY`, authenticated requests may use the server-funded key. To use BYOK instead, send the gateway token in `Authorization` and the OpenRouter key in `x-api-key` (the opposite header arrangement is also supported). Missing or incorrect gateway tokens are rejected even when the caller has their own provider key.

The gateway token is never forwarded to a provider. Only the selected OpenRouter key is sent to the fixed OpenRouter HTTPS destination. No automatic redirect to another destination is allowed. Do not place keys in committed configuration or logs. Deploying this code does not configure or rotate secrets.

## Model and resource policy

`FREE_ONLY` defaults to `true`. A paid or unspecified model fails explicitly; the worker never silently chooses a replacement. Set `FREE_ONLY=false` only when paid API requests are intended. `MODEL`, when configured, is an operator-selected override and is still checked against the free-only policy.

`ANYMODEL_MAX_BODY_BYTES` defaults to 4 MiB and is capped at 16 MiB to bound Worker memory usage. Both Content-Length and actual streamed bytes are checked before JSON parsing. Requests need an object with a model string and messages array. Reasoning `output_config`/`thinking` and tool dictionary schemas retain their native Messages semantics.

`RPM` defaults to 60 requests per minute per Cloudflare client IP. This limiter is an isolate-local best-effort guard, not a durable quota or financial budget. `X-Forwarded-For` is ignored. Deploy only behind Cloudflare's trusted edge; the local adapter uses its socket peer address and discards both forwarded and Cloudflare identity headers.

## Local fixture adapter

`node worker/serve-local.mjs` binds to `127.0.0.1` and streams requests through the same policy. It does not discover, load or run a local model. It can contact OpenRouter when supplied with real keys, so offline tests stub fetch rather than launching it with personal configuration.

Run offline tests with Node 22:

```sh
node --test worker/test/*.test.mjs
```

Tests invoke the actual handler and local HTTP adapter with mock upstream responses and fake keys; no live provider calls are required.
