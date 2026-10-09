# Migrating to AnyModel 2.0

Version 2.0 makes the maintained-client, optional-proxy workflow primary. Existing explicit provider configuration and local settings remain; there is no automatic model or account migration.

## Install your coding client separately

The npm package no longer contains the legacy `cli.js`. `anymodel` and `anymodel claude` resolve the installed `claude` executable on PATH. Install or update it using the [official Claude Code setup instructions](https://code.claude.com/docs/en/setup), and verify that `claude --version` works before using the launcher.

AnyModel does not repair or replace shared client installations. If yours is missing or broken, fix that installation through its owning installer. The launcher does not search your current directory, sibling repositories, home folder or old package bundles for substitute clients.

An explicitly chosen compatible client is still supported:

```bash
ANYMODEL_CLIENT=/absolute/path/to/your/authorized/client anymodel
```

A `.js`, `.mjs` or `.cjs` path runs with Node; another executable path runs directly. A missing explicit path fails instead of falling back to a different client. The retained legacy bundle is frozen source material with its existing third-party notice, not a newly granted distribution. See [NOTICE](../NOTICE.md).

## Verify your exact model

```bash
anymodel models --tools
anymodel check qwen
anymodel proxy openrouter --model provider/model-id
```

Legacy aliases stay pinned. If an old `:free` model disappears, `check` and OpenRouter proxy startup fail; they never select a paid successor. Choose an available model explicitly after reviewing its current pricing. A catalog outage also blocks startup, because availability could not be verified. No cached catalog is treated as current.

`models` and `check` are public read-only requests, not paid tests. Their output does not prove model access on your account or native subscription entitlement.

## Prefer an existing direct connection

SpecWeave Studio's native frontier sessions do not require AnyModel. OpenCode and Pi can use hosted providers directly; OpenRouter also documents a direct Claude Code route within its compatibility limits. Move to those paths when they satisfy the task. Keep the proxy only for an adaptation you actually need.

API credentials and subscriptions remain separate. Preserve your native account profiles and active sessions; use separate configuration for a new API route. A new provider route is a deliberate new session or handoff, not a transparent continuation of another agent's native history.
