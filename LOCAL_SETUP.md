# Running Claude Code locally through AnyModel → LMStudio

A zero-cloud setup: **Claude Code → AnyModel proxy → LMStudio → Qwen3-Coder-30B**. Designed for speed — ≤3 s first response, sub-second subsequent turns.

## What 1.11.0 changed

Starting with `anymodel@1.11.0`, **local providers automatically suppress globally-configured MCP servers**. This is the single biggest perf win for local models (dropping 50–60 K tokens of MCP tool schemas that local models can't handle). No flags required.

- Local provider (`lmstudio` / `llamacpp` / `ollama`) → auto-suppresses global MCP, loads project `./.claude/.mcp.json` if present
- Remote provider (`openrouter` / `openai`) → unchanged, keeps all global MCP
- Opt out with `--full-mcp` or `ANYMODEL_FULL_MCP=1`

## Install anymodel once, use everywhere

Recommended: **install globally so `anymodel` is a real command** — no `npx`, no `@latest`, no cache clearing:

```bash
npm i -g anymodel
# Upgrade later with:
npm update -g anymodel
```

From here on this guide uses plain `anymodel` instead of `anymodel`. If you prefer `npx`, substitute `anymodel` anywhere you see `anymodel`.

## Prerequisites

| Requirement | Check |
|---|---|
| Apple Silicon Mac, ≥32 GB RAM | `sysctl -n hw.memsize` → at least `34359738368` |
| LMStudio installed | `open /Applications/LM\ Studio.app` |
| `lms` CLI on PATH | `which lms` (see [setup](#step-0) below) |
| Claude Code installed | `which claude` |
| Node ≥ 20 | `node --version` |
| `anymodel@1.11.1+` | `anymodel --help` should list `--full-mcp` |

## Step 0 — Make `lms` globally available (one-time)

```bash
ln -sf ~/.lmstudio/bin/lms /opt/homebrew/bin/lms   # Apple Silicon
# or:
sudo ln -sf ~/.lmstudio/bin/lms /usr/local/bin/lms # Intel Mac
```

## Step 1 — Load Qwen3-Coder with 32 K context

**The easy way** (one-time): open LMStudio GUI → select Qwen3-Coder-30B → set Context Length to `32768` → tick **"Remember settings for qwen3-coder-30b"** → Load. From then on `lms load qwen/qwen3-coder-30b` uses 32 K automatically.

**CLI alternative**:
```bash
lms unload --all
lms load qwen/qwen3-coder-30b --context-length 32768 --gpu max
```

**Why 32 K (not 128 K)?** KV cache allocation is proportional to context size:

| Context | KV cache | Prefill speed | When to use |
|---|---:|---:|---|
| 4 K | ~200 MB | fastest | pure chat, no tools |
| **32 K** | **~1.6 GB** | **fast** | **default — projects with `.claude/.mcp.json`** |
| 131 K | ~6.5 GB | slow even on small msgs | only if you pass `--full-mcp` with many MCP servers |

**Verify what's loaded**:
```bash
lms ps
# IDENTIFIER              STATUS    SIZE        CONTEXT    DEVICE
# qwen/qwen3-coder-30b    LOADED    17.19 GB    32768      Local
```
`LOADED` = warm, instant. `IDLE` = cold (30–60 s load on next request). Nothing = not loaded.

**Don't have Qwen3-Coder yet?**
```bash
lms get https://huggingface.co/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit -y
```

## Step 2 — Start the AnyModel proxy

```bash
unset OPENROUTER_API_KEY OPENAI_API_KEY   # avoid auto-detect picking openrouter
anymodel proxy lmstudio
```

You should see:
```
[LMSTUDIO] Found N model(s). Using: qwen/qwen3-coder-30b (loaded + coding-preferred)
anymodel v1.11.0
Proxy on :9090
/v1/messages → lmstudio (qwen/qwen3-coder-30b @ http://127.0.0.1:1234/v1)
```

Leave this terminal running.

## Step 3 — Launch Claude Code through AnyModel

The simplest possible command — **no MCP flags needed**:

```bash
cd ~/Projects/your-project
anymodel
```

On a local provider, AnyModel automatically injects:
```
--strict-mcp-config --mcp-config <project .mcp.json or empty>
```

You'll see this banner line from the proxy:
```
[anymodel] Local provider — global MCP suppressed, using no MCP servers.
  Pass --full-mcp to keep global MCP.
```

Or, if your project has `./.claude/.mcp.json`:
```
[anymodel] Local provider — global MCP suppressed, using project MCP (./.claude/.mcp.json).
```

### What this means for `/context`

| Source | Status |
|---|---|
| Built-in tools (Bash, Read, Edit, etc.) | ✅ loaded (~11 K tokens) |
| Project `./.claude/.mcp.json` MCP servers | ✅ loaded |
| Global MCP servers (15+ from `~/.claude/settings.json`) | ❌ suppressed |
| Project `./.claude/skills/*/SKILL.md` | ✅ loaded |
| Foreign skill roots (`.agents` / `.codex` / `.gemini` / `.agent`, cwd + `$HOME`) | ✅ bridged ([see below](#universal-skill-discovery)) |
| Project `./.claude/agents/*.md` | ✅ loaded |
| Project `CLAUDE.md` | ✅ loaded |
| Global `~/.claude/CLAUDE.md` | ⚠️ still loads (small, ~1 K tokens — acceptable) |
| Global skills / plugin agents | ⚠️ still loads (~7 K tokens — see [full isolation](#full-isolation)) |

For most workflows, this default is exactly right. You keep project skills/agents/CLAUDE.md, drop the massive global MCP payload, keep the small global `~/.claude/CLAUDE.md` for personal conventions.

## Step 4 — Verify

```
/context
```

You should see:
- `MCP tools: ~100-2000 tokens` (just project MCP or none — NOT the 55 K+ from global)
- Model header shows the actual local model (`qwen/qwen3-coder-30b`), not `claude-opus-*`

## Opt-out — keep global MCP

If you know your machine can handle it (128 GB RAM, 131 K Qwen context, fewer MCP servers), or you just want full fidelity:

```bash
# per-invocation
anymodel --full-mcp

# or via env
ANYMODEL_FULL_MCP=1 anymodel
```

You'll see a warning:
```
[anymodel] --full-mcp: keeping global MCP servers (may be slow on local models)
```

## Full isolation

If even global `~/.claude/CLAUDE.md` and global skills are too much, go nuclear with a fake `CLAUDE_CONFIG_DIR`:

```bash
ISO=$(mktemp -d); echo '{}' > "$ISO/settings.json"
CLAUDE_CONFIG_DIR="$ISO" anymodel
```

This skips ALL global config. Project `./.claude/*` still loads because it's cwd-relative. Cleanup: `rm -rf "$ISO"`.

## Custom project structure

Your project's `.claude/` directory is auto-discovered. A typical demo setup:

```
your-project/
├── CLAUDE.md                          # project context
└── .claude/
    ├── .mcp.json                      # project MCP servers (optional)
    ├── skills/
    │   └── <name>/SKILL.md            # custom skills
    └── agents/
        └── <name>.md                  # custom subagents (FLAT file, not subdir)
```

### Minimal `.mcp.json` (project filesystem server)

```json
{
  "mcpServers": {
    "project-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## Universal skill discovery

SKILL.md is one shared open standard — Claude Code, OpenAI/Codex, Gemini/Antigravity,
Cursor, and Copilot all write the same `<name>/SKILL.md` format. Since `anymodel@1.16.0`,
AnyModel auto-discovers skills from the **other ecosystems'** roots and bridges them into
the bundled client with **zero format translation**. No flags needed.

It scans these foreign roots, in precedence order, under **both** the project cwd **and**
`$HOME`:

| Root | Ecosystem |
|---|---|
| `.agents/skills/` | cross-tool interop (Codex, Cursor, Copilot, Goose, Gemini CLI) |
| `.codex/skills/` | OpenAI Codex |
| `.gemini/skills/` | Gemini CLI |
| `.agent/skills/` | Google Antigravity (singular) |

Each discovered `<root>/<name>/SKILL.md` is symlinked into a per-session temp
`.claude/skills` shadow that AnyModel passes to the client via `--add-dir`, so the
client's native SKILL.md reader picks it up. You'll see a launch line like:

```
[anymodel] Bridged 3 skill(s) from .agents/.codex/.gemini: my-skill, codex-skill, gem-skill
```

**Rules:**
- Project `./.claude/skills/<name>` **wins** on a name collision (case-insensitive);
  among foreign roots the first one wins, and shadowed duplicates are logged.
- Symlinked skill entries must resolve *inside* their scanned root (an untrusted repo
  can't point a "skill" at `~/.ssh`); escapers are skipped.
- Unlinkable skills (e.g. Windows without symlink privilege) are logged, never silently
  dropped.

### `ANYMODEL_SKILL_ROOTS` — add or override discovery roots

Colon-separated paths add extra skill-discovery roots beyond the conventional ones:

```bash
# absolute roots used as-is; relative roots resolve against cwd
ANYMODEL_SKILL_ROOTS="$HOME/work/shared-skills:./vendor/skills" anymodel
```

Use it to share one skill library across projects, or to point at a non-standard layout.
Roots are de-duped (order preserved) and the project's own `.claude/skills` still wins on
any name collision.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner shows `anymodel v1.10.x` or earlier | npx cached. `rm -rf ~/.npm/_npx && anymodel --help` |
| `400 tokens > context length` | Qwen loaded with too-small context. Reload with 32 K minimum |
| `Invalid MCP configuration: not valid JSON` | Shouldn't happen with 1.11.0 auto-flow. Check `./.claude/.mcp.json` is valid JSON if present |
| Auto-injection not happening | Proxy `/health` didn't return provider name. Check `curl http://127.0.0.1:9090/health` returns `"provider":"lmstudio"` |
| Want to force-inject for openai/openrouter | Local-providers-only by design. Pass MCP flags manually via `-- --strict-mcp-config --mcp-config ./.claude/.mcp.json` |
| First response still slow (>10 s) | Normal — first turn prefills 5–10 K tokens. Subsequent turns <2 s |

## Advanced proxy tuning

Set any of these env vars on the `npx anymodel proxy lmstudio` command (Terminal 2):

| Env var | Default | Effect |
|---|---|---|
| `LOCAL_MAX_TOOLS` | unlimited | Max tools forwarded after compression |
| `LOCAL_MAX_SYSTEM_CHARS` | `4000` | Max chars of system prompt (defense in depth) |
| `LOCAL_MAX_TOOL_DESC` | `100` | Max chars per tool description |
| `LOCAL_NUM_CTX` | `32768` | Assumed context for tool budgeting |
| `LOCAL_TOOL_BUDGET_PCT` | `0.30` | % of context reserved for tool schemas |
| `ANYMODEL_FULL_MCP` | `0` | Set to `1` to keep global MCP servers on local |
| `LOCAL_FIDELITY` | `balanced` | Skill-fidelity tier — see below |
| `LOCAL_SKILL_INDEX` | `auto` | `on`/`off`/`auto` — gate the skill index independently |
| `LOCAL_MAX_SYSTEM_PCT` | `0.08` | Fraction of context budgeted for the curated system block |
| `LOCAL_SKILL_DESC_CHARS` | `140` | Max chars per skill description in the index |
| `LOCAL_PROJECT_DIR` | cwd | Where the proxy reads `.claude/skills/` for project scope |
| `LOCAL_SKILL_SCOPE` | derived | `project` \| `all` — override scope independent of tier |
| `LOCAL_SKILL_ALWAYS` | sw:* essentials | Comma list of skills always kept in project scope |

## Skill auto-trigger on local models (`--local-fidelity`)

To stay fast, the proxy condenses Claude Code's 50-100 KB system prompt and strips the
`<system-reminder>` that carries the **skill catalog**. Without that catalog a local
model can't auto-trigger skills (it still has the `Skill` *tool*, but doesn't know which
skills exist). The fidelity layer fixes this by re-injecting a compact, name-sorted skill
index + a curated behavioral core into the **system prefix** — deterministic, so it's a
one-time cost that the prefix cache reuses from turn 2 onward.

```bash
anymodel proxy lmstudio --local-fidelity balanced   # default
```

| Tier | Skill scope | Index size | When to use |
|---|---|---|---|
| `lean` | — (nothing) | 0 | latency purists; you don't use skills locally |
| `balanced` *(default)* | **project `.claude/skills` + sw:* workflow-core** | ~150-500 tok | the daily driver — relevant skills, small + cacheable |
| `full` | whole harvested catalog | ~1-3 K tok | when you want every global/plugin skill available |

**Scope matters more than budget (0016).** Measured on a realistic local request (100
skills, 90 tools, 6.7 KB system) on qwen3-coder-30b MLX, the prefix breaks down as
**tool schemas 7,757 tok (79%)**, system 917 tok (9%), skill index 1,147 tok (12%). So
the skill index is the *small* cost — and `full` injects ~30 mostly-irrelevant global
skills. `balanced` scopes the index to **your project's own skills + the SpecWeave
workflow** (read from `LOCAL_PROJECT_DIR`, default cwd), dropping the rest: in the bench,
**2,812 tok (full) → 147 tok (project scope)**. It stays *query-independent* on purpose,
so it lives in the cacheable prefix instead of busting the KV cache every turn.

To get your project's skills, start the proxy from the project dir or pass the dir:
```bash
LOCAL_PROJECT_DIR=~/Projects/wc26 anymodel proxy lmstudio   # balanced = wc26 skills + sw:*
anymodel proxy lmstudio --local-fidelity full               # or: every skill, bigger prefix
```

**The real lever is tools, not skills.** If local is still slow, the 90 tool schemas
(7.7 K tok even after 68 % compression) dominate — cut them with `LOCAL_MAX_TOOLS` or a
lower `LOCAL_TOOL_BUDGET_PCT` (default `0.30`). MCP suppression is separate — `--full-mcp`.

Skill triggering on qwen3-coder-30b is real but variable (~50-75 % per run at default
temperature). Run the harness yourself: `node test/skill-trigger-eval.mjs` (needs a
running proxy; `full` tier to exercise the whole catalog).

## The full three-command reference

```bash
# === Terminal 1 (once per reboot) ===
lms load qwen/qwen3-coder-30b

# === Terminal 2 (keep running) ===
unset OPENROUTER_API_KEY OPENAI_API_KEY
anymodel proxy lmstudio

# === Terminal 3 (per coding session) ===
cd ~/Projects/your-project
anymodel
```

That's it. Three commands. Global MCP suppression handled automatically.

## Further reading

- [AnyModel README](./README.md)
- [Model bench report](../../.specweave/increments/0006-local-backend-providers/model-bench/REPORT.md)
- [Claude Code docs](https://code.claude.com/docs/en/)
