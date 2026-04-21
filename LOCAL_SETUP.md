# Running Claude Code locally through AnyModel → LMStudio

A fully local, zero-cloud setup: **Claude Code → AnyModel proxy → LMStudio → Qwen3-Coder-30B**. Designed for speed: ≤3s first response, sub-second subsequent turns.

## Why you're here

The default `npx anymodel` setup works, but Claude Code sends ~100 KB of payload per turn (global CLAUDE.md + 90 MCP tools + all your skills). Local models choke on this — 30–60s prefill just to answer "hi".

This guide isolates Claude Code to **project-only context**, drops the payload to ~5 KB, and makes the agent loop feel native.

## Prerequisites

| Requirement | Check |
|---|---|
| Apple Silicon Mac, ≥32 GB RAM | `sysctl -n hw.memsize` → at least `34359738368` |
| LMStudio installed | `open /Applications/LM\ Studio.app` |
| `lms` CLI on PATH | `which lms` (see [setup](#making-lms-globally-available) below) |
| Claude Code installed | `which claude` |
| Node ≥ 20 | `node --version` |

## Step 0 — Make `lms` globally available (one-time)

```bash
ln -sf ~/.lmstudio/bin/lms /opt/homebrew/bin/lms   # Apple Silicon
# or:
sudo ln -sf ~/.lmstudio/bin/lms /usr/local/bin/lms # Intel Mac
```

## Step 1 — Load Qwen3-Coder with 128 K context

```bash
lms unload --all
lms load qwen/qwen3-coder-30b --context-length 131072 --gpu max
```

**Why 131072?** Claude Code's payload can reach 15–20 K tokens even with aggressive trimming. 32 K is too tight; 128 K gives ~100 K of headroom for the conversation. On a 128 GB M4 Max, context this size fits comfortably in RAM.

**Don't have Qwen3-Coder yet?**
```bash
lms get https://huggingface.co/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit -y
```

## Step 2 — Start the AnyModel proxy (pin `@latest`)

```bash
unset OPENROUTER_API_KEY OPENAI_API_KEY   # avoid auto-detect stealing the wheel
npx anymodel@latest proxy lmstudio
```

You should see:
```
[LMSTUDIO] Found N model(s). Using: qwen/qwen3-coder-30b (loaded + coding-preferred)
anymodel v1.10.4
Proxy on :9090
/v1/messages → lmstudio (qwen/qwen3-coder-30b @ http://127.0.0.1:1234/v1)
```

Leave this terminal running.

## Step 3 — Scaffold your project (one-time)

```bash
mkdir -p ~/Projects/focus-timer/.claude && cd ~/Projects/focus-timer
```

Create **`./.claude/empty-mcp.json`** — a valid empty MCP config (Claude Code requires a real file, not `/dev/null`):
```bash
cat > .claude/empty-mcp.json <<'JSON'
{ "mcpServers": {} }
JSON
```

Create **`./CLAUDE.md`** — your project-local context (kept small):
```bash
cat > CLAUDE.md <<'MD'
# Focus Timer
Node 20 + Express + better-sqlite3 + vanilla JS frontend.
Port 8090. Dark mode. Keyboard shortcuts. `node --test` for tests.
Be terse. No preamble.
MD
```

## Step 4 — Launch Claude Code in `--bare` mode through AnyModel

`--bare` is Claude Code's official flag that skips auto-discovery of hooks, skills, plugins, MCP servers, auto-memory, and global `~/.claude/CLAUDE.md`. You load **only** what you pass explicitly.

Starting in AnyModel **1.10.4**, you can forward args to Claude Code via the `--` separator:

```bash
cd ~/Projects/focus-timer
npx anymodel@latest -- \
  --bare \
  --strict-mcp-config --mcp-config ./.claude/empty-mcp.json \
  --append-system-prompt "$(cat CLAUDE.md)"
```

What each flag does:

| Flag | Effect |
|---|---|
| `--` | Everything after is forwarded to Claude Code verbatim (AnyModel 1.10.4+) |
| `--bare` | Skip global config, plugins, skills, MCP, CLAUDE.md auto-load |
| `--strict-mcp-config` | Only use MCP servers from `--mcp-config`, ignore all others |
| `--mcp-config ./.claude/empty-mcp.json` | Point at our empty config (zero MCP tools) |
| `--append-system-prompt "$(cat CLAUDE.md)"` | Inject *project-only* CLAUDE.md content |

## Payload comparison

| Setup | Tools | System | Total payload | First response |
|---|---:|---:|---:|---:|
| Default `npx anymodel` | 90 (~55 KB) | ~15 KB | **~100 KB** | 60 s+ (hangs/400s) |
| `npx anymodel@1.10.3` (auto-compression) | 90 → compressed 25 KB | ~4 KB | ~35 KB | 15–30 s |
| **`--bare` + empty MCP** (this guide) | **0** | ~1 KB (project CLAUDE.md only) | **~3 KB** | **≤ 3 s** |

## What you lose with `--bare`

- No `/sw:increment` or any SpecWeave slash commands
- No Obsidian/Slack/GitHub MCP tools
- No global `~/.claude/CLAUDE.md` (Obsidian rules, git conventions, etc.)

## What you keep

- Bash, Read, Edit, Write, Glob, Grep — all the built-in tools that matter for coding
- Project-local `CLAUDE.md` content (via `--append-system-prompt`)
- The full agent loop: Claude Code can still read/edit files, run `npm install`, run tests, start dev servers

## Your first prompt

After `--bare` Claude Code launches, try:

```
Build the focus timer per CLAUDE.md. Create server.mjs, index.html, db.mjs, api.test.mjs.
Run npm install, then run the tests, then start the server.
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid MCP configuration: not valid JSON` | Your `--mcp-config` target doesn't exist or is empty. Create `.claude/empty-mcp.json` with `{"mcpServers":{}}` |
| `Error: Proxy not running on :9090` | Terminal 2 isn't running, or `OPENROUTER_API_KEY` is set and stole auto-detect. `unset OPENROUTER_API_KEY` before launching |
| `400 The number of tokens … is greater than the context length` | Qwen loaded with too-small context. `lms load qwen/qwen3-coder-30b --context-length 131072 --gpu max` |
| Banner shows `anymodel v1.9.x` or earlier | npx cached an old version. `rm -rf ~/.npm/_npx` then `npx anymodel@latest` |
| Banner picked Gemma instead of Qwen | Qwen not loaded. `lms ps` should show `qwen/qwen3-coder-30b` as `LOADED` |
| Still slow (>10s per turn) after `--bare` | Qwen KV cache not reusing across turns. Reduce `LOCAL_MAX_SYSTEM_CHARS=1500` when starting the proxy |

## Advanced: tighten further via env vars on the proxy

Any of these can be set on the `npx anymodel proxy lmstudio` command (Terminal 2):

| Env var | Default | What it does |
|---|---|---|
| `LOCAL_MAX_TOOLS` | unlimited | Max tools forwarded (even after compression). Set to `20` for smaller payload |
| `LOCAL_MAX_SYSTEM_CHARS` | `4000` | Max characters of system prompt. Set lower (e.g. `1500`) for speed |
| `LOCAL_MAX_TOOL_DESC` | `100` | Max chars per tool description |
| `LOCAL_NUM_CTX` | `32768` | Assumed context for budgeting calculations |
| `LOCAL_TOOL_BUDGET_PCT` | `0.30` | % of context reserved for tool schemas (0.0–1.0) |

Example aggressive config:
```bash
LOCAL_MAX_TOOLS=15 LOCAL_MAX_SYSTEM_CHARS=1500 \
  npx anymodel@latest proxy lmstudio
```

## Re-enabling specific skills (optional)

If you want `/sw:increment` back for a specific session without reloading the whole global environment:

```bash
npx anymodel@latest -- \
  --bare \
  --plugin-dir ~/.claude/plugins/cache/specweave/sw/1.0.0 \
  --strict-mcp-config --mcp-config ./.claude/empty-mcp.json \
  --append-system-prompt "$(cat CLAUDE.md)"
```

## Full command reference

```bash
# === Terminal 1 (once per reboot / model swap) ===
lms unload --all
lms load qwen/qwen3-coder-30b --context-length 131072 --gpu max

# === Terminal 2 (keep running) ===
unset OPENROUTER_API_KEY OPENAI_API_KEY
npx anymodel@latest proxy lmstudio

# === Terminal 3 (per coding session) ===
cd ~/Projects/focus-timer
npx anymodel@latest -- \
  --bare \
  --strict-mcp-config --mcp-config ./.claude/empty-mcp.json \
  --append-system-prompt "$(cat CLAUDE.md)"
```

## Further reading

- [Claude Code `--bare` docs](https://code.claude.com/docs/en/headless.md)
- [AnyModel README](./README.md)
- [AnyModel model bench report](../../.specweave/increments/0006-local-backend-providers/model-bench/REPORT.md)
