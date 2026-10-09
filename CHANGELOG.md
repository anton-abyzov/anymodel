# Changelog

## 2.0.0 — 2026-10-09

AnyModel is an optional API compatibility adapter. SpecWeave Studio keeps native frontier execution as its default; direct OpenRouter support in existing agents remains the first route to consider.

### Breaking changes

- Install a maintained coding client separately. The npm package no longer includes the historical `cli.js` client. Automatic client discovery uses installed Claude Code on `PATH`; local, sibling and home-directory legacy bundles are never selected automatically. An explicit `ANYMODEL_CLIENT` path remains available for a client the user is authorized to run.
- Node.js 22 or newer is the supported runtime. Release verification runs on Node.js 22.
- OpenRouter startup verifies the exact selected model in the public catalog and fails when availability is unknown or the ID is absent. Free aliases retain their original IDs and are never silently replaced by paid models. An OpenAI-compatible endpoint requires an explicit model.

### Compatibility and safety

- Provider credentials stay within their configured provider boundary. Proxy routes consistently enforce configured authentication, rate limits and body limits; unsupported cloud routes fail explicitly.
- Hosted reasoning controls, tool dictionaries, streaming failures and usage accounting retain their supported protocol semantics.
- Worker funding and authentication policies distinguish user-supplied API keys from the deployment's server key.
- Proxy-connected clients receive the proxy token and selected model without inherited native account routing overrides.
- `anymodel models` and `anymodel check` read the public OpenRouter catalog without inference, credentials or local discovery. Catalog listings do not prove account access, endpoint health, coding quality or native subscription entitlement.

### Distribution and evidence

- The legacy client and branding manifest remain frozen in source. Bundle-mutating prepublish scripts and brand-patch release checks are removed. `NOTICE.md` describes the original-code license and third-party boundary without claiming additional redistribution rights.
- The historical one-model local benchmark remains available. Its 17/18 artifact passes include one timeout; 16/18 runs also completed successfully without timing out. It is not a frontier comparison.
- The offline test runner removes live credentials, blocks external and local-inference traffic, and produces test and coverage receipts. Hosted evaluation evidence is separate from offline compatibility tests.

See [the migration guide](docs/migration-2.md) and [Studio boundary](docs/studio-boundary.md).
