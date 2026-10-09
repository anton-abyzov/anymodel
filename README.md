# AnyModel

**An optional API compatibility adapter for coding tools.**

Use your maintained coding agent and provider directly when they already work together. AnyModel is useful when a particular endpoint needs request, tool-schema or response adaptation. It does not make models equally capable, supply subscription access, or replace an agent's planning, permissions and session history.

[Website](https://anymodel.dev) · [2.0 migration](docs/migration-2.md) · [Studio boundary](docs/studio-boundary.md) · [License and legacy notices](NOTICE.md)

## Choose the simplest supported route

| Your task | Recommended route |
|---|---|
| Frontier coding in SpecWeave Studio | Studio → official native Codex/Claude runtime → your selected provider account |
| Hosted models through OpenRouter | Existing OpenCode or Pi integration → OpenRouter; evaluate the model on your actual tasks |
| Claude Code with OpenRouter | Use [OpenRouter's direct integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) where compatible |
| A demonstrated protocol mismatch | Maintained client → AnyModel proxy → explicitly selected API provider/model |

OpenRouter documents its Claude Code compatibility guarantee for Anthropic first-party only. Non-Anthropic models need their own validation. [OpenCode supports OpenRouter directly](https://opencode.ai/docs/providers/#openrouter), without this proxy.

SpecWeave owns portable specs, task claims and acceptance evidence. Studio owns native execution, approvals, workspaces and sessions. AnyModel belongs outside Studio's default native path. **API billing and native subscription capacity are separate.**

## Check current hosted availability

These commands read OpenRouter's public model catalog. They need no API key, send no inference request and do not discover or warm up local models.

```bash
npx anymodel models --search coder --tools
npx anymodel models --free --json
npx anymodel check qwen
npx anymodel check provider/model-id --json
```

The result includes the source and check time. “Listed” means present in the public API catalog, not authenticated account access, endpoint health, coding quality or native subscription entitlement. `--tools` filters advertised tool support; it does not prove correct tool execution.

Legacy presets (`gpt`, `codex`, `gemini`, `deepseek`, `mistral`, `gemma`, `qwen`, `nemotron`, `llama`) retain their original exact model IDs. They are not “latest model” selectors. Before an OpenRouter proxy starts, the CLI checks the selected ID against the live catalog. Missing entries fail with an actionable error. **Former free presets never silently become paid models.** Free aliases and `--free-only` also require observed zero pricing. If catalog verification is unavailable, startup stops; retry when the catalog is reachable.

## Use the adapter when needed

AnyModel 2.0 supports Node.js 22 or newer. Release checks run on Node.js 22.

Install and maintain your client separately. Version 2.0 no longer distributes or automatically discovers the legacy bundled client. The launcher uses `claude` on your PATH, or an explicit `ANYMODEL_CLIENT` path you are authorized to use. See [migration](docs/migration-2.md).

```bash
# First inspect the catalog and choose a supported exact model ID.
npx anymodel models --tools

# Terminal 1: OPENROUTER_API_KEY is already set in your environment.
# Replace provider/model-id with your deliberate choice.
npx anymodel proxy openrouter --model provider/model-id

# Terminal 2: launch your separately installed Claude Code through the proxy.
npx anymodel
```

For an authenticated proxy, use the same proxy token on both sides:

```bash
# Terminal 1
npx anymodel proxy openrouter --model provider/model-id --token "$ANYMODEL_TOKEN"
# Terminal 2
npx anymodel --token "$ANYMODEL_TOKEN"
```

The proxy token is not your provider API key. Credentials for the upstream provider stay with the proxy. Keep separate client account configuration for API routing so a cached native login cannot select another billing path. Check the provider's usage dashboard after an authorized test.

You can also connect a maintained client without the launcher:

```bash
# Scope these values to this invocation, not your shared shell profile.
ANTHROPIC_BASE_URL=http://127.0.0.1:9090 \
ANTHROPIC_AUTH_TOKEN="$ANYMODEL_TOKEN" ANTHROPIC_API_KEY= claude
```

For an unauthenticated loopback proxy, use a non-secret placeholder token. An exposed proxy must require authentication. Default binding is loopback (`127.0.0.1`).

## OpenAI-compatible endpoints

```bash
# OPENAI_API_KEY is set separately. Select an ID supported by this endpoint.
npx anymodel proxy openai --model your-model-id
```

Set `OPENAI_BASE_URL` for a custom compatible endpoint. OpenRouter catalog checks apply only to OpenRouter, not this separate provider. Compatibility depends on the request format and backend; unsupported routes fail explicitly. Provider errors and incomplete streams are errors, not successful completed turns.

## Scope and controls

Run `anymodel --help` for exact flags. `--model` pins the proxy model, `--port` selects its port, `--token` protects it, and `--rpm` sets its request limit. Client arguments go after `--`, for example `anymodel -- --bare`.

Existing explicit local provider commands and settings remain for existing users; see [LOCAL_SETUP.md](LOCAL_SETUP.md). They are not the default recommendation for frontier coding, and no local-model evaluation was performed for this release. The shared skill-discovery bridge remains in the launcher; the legacy client bytes and branding manifest are frozen.

## Evidence, not parity claims

The [historical June 2026 benchmark](https://anymodel.dev/bench) used one local Qwen3-Coder 30B model, six small tasks and three repetitions per arm. Fixed AnyModel produced passing artifacts in **17/18 runs**; **16/18** also exited successfully without timing out. One artifact pass timed out. This is a bounded historical compatibility result, not frontier parity or a current hosted-model ranking. Raw results remain available with the report.

For a new route, measure accepted tasks, time to an accepted result, incremental API cost including repairs, and reviewer effort. A cheaper token price alone is not lower cost per completed task, especially when native subscription capacity is already paid for.

## Development and licensing

Use focused offline tests and mock provider endpoints; live model evaluations require an explicit scope and budget. Keep request/response protocol evidence separate from actual native-agent execution and repository acceptance.

The original project license is retained in [LICENSE](LICENSE). Read [NOTICE.md](NOTICE.md) for its scope and the separate third-party legacy-client notice. AnyModel does not grant rights to third-party clients, models, services or accounts.
