# Running Claude Code locally through AnyModel → LMStudio

A zero-cloud setup: **Claude Code → AnyModel proxy → LMStudio → Qwen3-Coder-30B**. Designed for speed — ≤3 s first response, sub-second subsequent turns.

## What 1.11.0 changed

Starting with `anymodel@1.11.0`, **local providers automatically suppress globally-configured MCP servers**. This is the single biggest perf win for local models (dropping 50–60 K tokens of MCP tool schemas that local models can't handle). No flags required.

- Local provider (`lmstudio` / `llamacpp` / `ollama`) → auto-suppresses global MCP, loads project `./.claude/.mcp.json` if present
- Remote provider (`openrouter` / `openai`) → unchanged, keeps all global MCP
- Opt out with `--full-mcp` or `ANYMODEL_FULL_MCP=1`

## Prerequisites

| Requirement | Check |
|---|---|
| Apple Silicon Mac, ≥32 GB RAM | `sysctl -n hw.memsize` → at least `34359738368` |
| LMStudio installed | `open /Applications/LM\ Studio.app` |
| `lms` CLI on PATH | `which lms` (see [setup](#step-0) below) |
| Claude Code installed | `which claude` |
| Node ≥ 20 | `node --version` |
| `anymodel@1.11.0+` | `npx anymodel@latest --help` should list `--full-mcp` |

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
npx anymodel@latest proxy lmstudio
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
npx anymodel@latest
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
npx anymodel@latest --full-mcp

# or via env
ANYMODEL_FULL_MCP=1 npx anymodel@latest
```

You'll see a warning:
```
[anymodel] --full-mcp: keeping global MCP servers (may be slow on local models)
```

## Full isolation

If even global `~/.claude/CLAUDE.md` and global skills are too much, go nuclear with a fake `CLAUDE_CONFIG_DIR`:

```bash
ISO=$(mktemp -d); echo '{}' > "$ISO/settings.json"
CLAUDE_CONFIG_DIR="$ISO" npx anymodel@latest
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| Banner shows `anymodel v1.10.x` or earlier | npx cached. `rm -rf ~/.npm/_npx && npx anymodel@latest --help` |
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

## The full three-command reference

```bash
# === Terminal 1 (once per reboot) ===
lms load qwen/qwen3-coder-30b

# === Terminal 2 (keep running) ===
unset OPENROUTER_API_KEY OPENAI_API_KEY
npx anymodel@latest proxy lmstudio

# === Terminal 3 (per coding session) ===
cd ~/Projects/your-project
npx anymodel@latest
```

That's it. Three commands. Global MCP suppression handled automatically.

## Further reading

- [AnyModel README](./README.md)
- [Model bench report](../../.specweave/increments/0006-local-backend-providers/model-bench/REPORT.md)
- [Claude Code docs](https://code.claude.com/docs/en/)
