# SpecWeave Studio and AnyModel

Studio is a workbench for native coding agents. AnyModel is an optional inference-protocol adapter. A proxy cannot provide the native agent's reasoning, tools, approvals, plans, context continuity or subscription allowance.

| Layer | Responsibility |
|---|---|
| SpecWeave | Portable intent, acceptance criteria, task ownership and verification evidence |
| Studio | Workspaces, native sessions, approvals, steering, checkpoints and review |
| Native agent | Agent loop, native tool protocol, model access and conversation history |
| Optional API adapter | Explicit request/response compatibility for a supported endpoint |

Frontier native Codex/Claude execution remains the Studio default. There is no required AnyModel dependency and no new AnyModel Studio driver. Existing OpenCode, Pi or ACP runtimes are the first route for hosted model experiments. [OpenCode supports OpenRouter](https://opencode.ai/docs/providers/#openrouter) directly. [OpenRouter's Claude Code route](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) needs no local proxy; it only guarantees compatibility with Anthropic first-party.

Choose a hosted alternative for a bounded task only after measuring the actual result. Delegate an owned task or worktree with a defined output, tests and review. Do not silently downgrade an active frontier writing session or equate an API model ID with the capabilities of a native agent.

Track accepted tasks per user hour, time to acceptance, incremental API spend including repairs, interventions and native quota consumption separately. Included subscription use may have no incremental cash cost; cheaper API tokens can add review and repair work. Availability, protocol fidelity and useful coding outcomes are different checks.

AnyModel's public catalog reports what OpenRouter currently lists. It does not replace Studio's native model discovery, grant account access or describe subscription entitlements. Preserve the selected runtime/account/model and explicit billing choice.
