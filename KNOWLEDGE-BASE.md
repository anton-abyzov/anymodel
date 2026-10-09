# AnyModel Knowledge Base

Current product boundary: 2.0, October 2026. Older skills and ADR implementation details can describe the former bundled-client product; this approved direction governs new work.

## Product

AnyModel is an optional API compatibility adapter, not a universal replacement for native frontier coding agents. Prefer direct provider support. Keep it only where a demonstrated request/response mismatch needs adaptation.

SpecWeave owns portable intent, task claims, acceptance and handoff. Studio owns native sessions, approvals, workspaces and checkpoints. Native Codex/Claude is the default Studio path; AnyModel is not a required driver or native entitlement source. Hosted alternatives can use existing OpenCode/Pi/ACP integrations directly.

## Owned runtime

- `proxy.mjs`: authenticated routing, request policy, protocol adaptation, streaming and provider failures.
- `providers/`: OpenRouter, OpenAI-compatible and existing local adapters; credentials belong to their selected provider.
- `cli.mjs`: explicit proxy startup and maintained-client launch. Client resolution is `ANYMODEL_CLIENT` or executable `claude` on PATH. No automatic legacy bundle/cwd/home discovery.
- `catalog/openrouter.mjs`: public read-only discovery, exact legacy aliases and startup availability checks. No credentials, local probes or inference calls.
- `catalog-test/`: offline discovery, no-substitution, launcher and product-contract regressions.

## Catalog and selection

`anymodel models [--search text] [--free] [--tools] [--json]` fetches the current public OpenRouter catalog. `anymodel check <model-id|preset> [--json]` verifies an exact selection. Results include source/time and explicitly exclude account access, live inference health, quality and native subscription entitlement.

`MODEL_PRESETS` in `catalog/openrouter.mjs` is the canonical legacy-alias table. Do not remap aliases just because a newer model exists. In particular, retired free aliases must never become paid defaults. OpenRouter proxy startup fails before listening when the selected ID is unavailable or catalog verification fails; free aliases and `--free-only` must have observed zero catalog prices. Users choose replacements explicitly. Non-OpenRouter endpoints require their own explicit IDs; the OpenRouter catalog is not authoritative for them.

## Clients and license boundaries

ADR-0002's maintained native-client/pure-proxy direction is primary. ADR-0003's bundle branding manifest is retained historical material. Freeze `cli.js` bytes and that manifest; do not update their branding, version or features. The legacy bundle is omitted from new npm packages. An explicit user-authorized client path remains supported.

The MIT license offered for original project code is not a license for third-party client code, models or services. Keep notices intact; see `NOTICE.md`. Never claim a subscription or distribution right from a model name or generic project license.

## Maintained behavior

Preserve provider-specific credentials and valid tool dictionaries. Unsupported routes fail explicitly. Provider errors and incomplete streams must remain failures. Forward supported reasoning controls and report unavailable usage as unknown. Do not strip capabilities silently to turn a failing coding request into a successful text reply.

The existing skill-discovery bridge lives in the launcher and passes native client arguments. Existing local configurations remain compatible; `LOCAL_SETUP.md` records their historical setup. Local inference is excluded from the October hosted review and release verification; no current local performance claims follow from it.

## Evidence

The June local benchmark is historical: one Qwen3-Coder 30B model, six small tasks, three repetitions per arm. The fixed proxy has 17/18 artifact passes but 16/18 clean completed runs; one artifact pass timed out. Preserve raw JSON and make this distinction visible. It is not a frontier parity result or current hosted-model ranking.

For current evaluations, separate public catalog visibility, protocol compatibility, native-agent execution, generated artifact checks and complete task acceptance. Record actual route/model, retries, spend, time and reviewer effort. Compare the same backend/harness when measuring proxy effects. Do not infer lower cost per accepted task from token prices or a one-task smoke.

## Release

Use the canonical increment and isolated owned worktrees. Run offline regressions without live credentials/local inference, then only authorized hosted evaluations. Release source, npm integrity/isolated install and public website/worker readback are separate proof states. Packaging must include `catalog/`, docs and notices and must not rewrite/distribute `cli.js`. Root coordination owns release versions and manifests.
