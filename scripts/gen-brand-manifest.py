#!/usr/bin/env python3
# Source of truth for scripts/brand-patches.json — regenerate after an upstream cli.js bump.
# Run against a PRISTINE bundle (counts anchors); then `node scripts/brand-patch.mjs` applies them.
# Generate the curated, deduped, conflict-resolved brand-patch manifest.
# Computes `expect` from the live (pristine) bundle and fails loudly if any anchor is missing.
import json, sys

import os
_HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(_HERE, "..", "cli.js")          # pristine bundle to count anchors against
OUT = os.path.join(_HERE, "brand-patches.json")
src = open(BUNDLE, encoding="utf-8").read()

# (id, category, adaptive, from, to)
E = [
 # ── adaptive: reflect the runtime-loaded model (process.env.ANYMODEL_MODEL) ──
 ("announcement-opus-1m-promo","announcement-tip",True,
  '"Opus now defaults to 1M context · 5x more room, same pricing"',
  '(process.env.ANYMODEL_MODEL?process.env.ANYMODEL_MODEL+" · /model to switch":"anymodel · route any model to any tool")'),
 ("plan-mode-exploring","plan-mode",True,
  '"Claude is now exploring and designing an implementation approach."',
  '`${process.env.ANYMODEL_MODEL||"anymodel"} is now exploring and designing an implementation approach.`'),
 ("plan-mode-will","plan-mode",True,
  '"In plan mode, Claude will:"',
  '`In plan mode, ${process.env.ANYMODEL_MODEL||"anymodel"} will:`'),
 ("plan-mode-ready","plan-mode",True,
  '"Claude has written up a plan and is ready to execute. Would you like to proceed?"',
  '`${process.env.ANYMODEL_MODEL||"anymodel"} has written up a plan and is ready to execute. Would you like to proceed?`'),
 ("idle-waiting","status-spinner",True,
  'message:"Claude is waiting for your input"',
  'message:`${process.env.ANYMODEL_MODEL||"anymodel"} is waiting for your input`'),
 ("computer-use-active","status-spinner",True,
  'message:K?"Claude is using your computer · press Esc to stop":"Claude is using your computer · press Ctrl+C to stop"',
  'message:K?`${process.env.ANYMODEL_MODEL||"anymodel"} is using your computer · press Esc to stop`:`${process.env.ANYMODEL_MODEL||"anymodel"} is using your computer · press Ctrl+C to stop`'),
 ("computer-use-done","status-spinner",True,
  'message:"Claude is done using your computer"',
  'message:`${process.env.ANYMODEL_MODEL||"anymodel"} is done using your computer`'),
 ("ctx-has-context","other-ui",True,
  '"• Claude has context of "',
  '`• ${process.env.ANYMODEL_MODEL||"anymodel"} has context of `'),
 ("placeholder-tell","other-ui",True,
  'placeholder:"Tell Claude what to change"',
  'placeholder:`Tell ${process.env.ANYMODEL_MODEL||"anymodel"} what to change`'),
 ("searching-with","status-spinner",True,
  '"Searching with Claude…"',
  '`Searching with ${process.env.ANYMODEL_MODEL||"anymodel"}…`'),

 # ── static: brand-neutral / anymodel ──
 ("model-updated-opus","announcement-tip",False,
  'Model updated to Opus 4.6','Model updated'),
 ("model-updated-sonnet","announcement-tip",False,
  'Model updated to Sonnet 4.6','Model updated'),
 ("upgrade-max-opus","slash-command-text",False,
  'description:"Upgrade to Max for higher rate limits and more Opus"',
  'description:"Upgrade for higher rate limits"'),
 ("err-high-load","error-message",False,
  'Opus is experiencing high load, please use /model to switch to Sonnet',
  'The model is experiencing high load, please use /model to switch to a different model'),
 ("err-high-demand","error-message",False,
  '"We are experiencing high demand for Opus 4."',
  '"We are experiencing high demand for this model."'),
 ("queue-while-working","status-spinner",False,
  'Hit Enter to queue up additional messages while Claude is working.',
  'Hit Enter to queue up additional messages while anymodel is working.'),
 ("can-make-mistakes","other-ui",False,
  'O3.default.createElement(k,null,"Claude can make mistakes")',
  'O3.default.createElement(k,null,"anymodel can make mistakes")'),
 # consolidated: covers the box header (x2), welcomeMessage, and the "…for " variant
 ("welcome-banner","welcome-onboarding",False,
  'Welcome to Claude Code','Welcome to anymodel'),
 ("login-title","login-auth",False,
  'title:"Log in to Claude"','title:"Log in to anymodel"'),
 ("login-label","login-auth",False,
  'label:"Login with Claude account"','label:"Login with anymodel account"'),
 ("signin-anthropic","login-auth",False,
  '"Sign in with your Anthropic account"','"Sign in with your anymodel account"'),
 ("switch-anthropic","login-auth",False,
  'description:Ev1()?"Switch Anthropic accounts"','description:Ev1()?"Switch anymodel accounts"'),
 ("signout-anthropic","login-auth",False,
  '"Sign out from your Anthropic account"','"Sign out from your anymodel account"'),
 ("signout-success","login-auth",False,
  '"Successfully logged out from your Anthropic account."','"Successfully logged out from your anymodel account."'),
 ("try-desktop","announcement-tip",False,
  'title:"Try Claude Code Desktop"','title:"Try anymodel Desktop"'),
 ("transcript-consent","welcome-onboarding",False,
  'Can Anthropic look at your session transcript to help us improve Claude Code?',
  'Can we look at your session transcript to help us improve anymodel?'),
 ("upgrade-keep-using","cost-billing",False,
  'return"/upgrade to keep using Claude Code"','return"/upgrade to keep using anymodel"'),
 ("billing-subscription","cost-billing",False,
  '"You are currently using your subscription to power your Claude Code usage"',
  '"You are currently using your subscription to power your anymodel usage"'),
 ("billing-canbeused","cost-billing",False,
  '"Claude Code can be used with your Claude subscription or billed based on API usage through your Console account."',
  '"anymodel can be used with your configured provider subscription or billed based on API usage through your provider account."'),
 ("billing-promax","login-auth",False,
  '"Your Claude Pro/Max subscription will be used by Claude Code."',
  '"Your provider subscription will be used by anymodel."'),
 ("cost-desc","cost-billing",False,
  'description:"Cost of the Claude Code session"','description:"Cost of the anymodel session"'),
 ("feedback-desc","slash-command-text",False,
  'description:"Submit feedback about Claude Code"','description:"Submit feedback about anymodel"'),
 ("plugins-desc","slash-command-text",False,
  'description:"Manage Claude Code plugins"','description:"Manage anymodel plugins"'),
 ("usage-stats-desc","slash-command-text",False,
  'description:"Show your Claude Code usage statistics and activity"',
  'description:"Show your anymodel usage statistics and activity"'),
 ("doctor-desc","slash-command-text",False,
  'description:"Diagnose and verify your Claude Code installation and settings"',
  'description:"Diagnose and verify your anymodel installation and settings"'),
 ("yearinreview-desc","slash-command-text",False,
  'description:"Your 2025 Claude Code Year in Review"','description:"Your 2025 anymodel Year in Review"'),
 ("stickers-desc","slash-command-text",False,
  'description:"Order Claude Code stickers"','description:"Order anymodel stickers"'),
 ("web-setup-desc","slash-command-text",False,
  'description:"Setup Claude Code on the web (requires connecting your GitHub account)"',
  'description:"Setup anymodel on the web (requires connecting your GitHub account)"'),
 ("memory-desc","slash-command-text",False,
  'description:"Edit Claude memory files"','description:"Edit memory files"'),
 ("watermark-desc","other-ui",False,
  'description:"Show Claude logo watermark (default: true)"',
  'description:"Show anymodel logo watermark (default: true)"'),
 ("status-account","error-message",False,
  'Run /status in Claude Code to check your account.',
  'Run /status in anymodel to check your account.'),
 # `--version` / `-v` output suffix: `${VERSION} (Claude Code)` (template literal, x2)
 ("version-suffix","other-ui",False,
  '.VERSION} (Claude Code)','.VERSION} (anymodel)'),

 # ── commander.js CLI `.description(...)` layer (user-visible in `cli.js --help`) ──
 # NOTE: "Import MCP servers from Claude Desktop" is intentionally NOT rebranded —
 # Claude Desktop is a real external app you import FROM. Same for all `prompt:`
 # LLM templates and CLAUDE.md identity text (sent to the model, not shown to users).
 ("cli-root-desc","help-text",False,
  '"Claude Code - starts an interactive session by default, use -p/--print for non-interactive output"',
  '"anymodel - starts an interactive session by default, use -p/--print for non-interactive output"'),
 ("cli-doctor-desc","help-text",False,
  'Check the health of your Claude Code auto-updater',
  'Check the health of your anymodel auto-updater'),
 ("cli-install-desc","help-text",False,
  'Install Claude Code native build',
  'Install anymodel native build'),
 ("cli-logout-desc","help-text",False,
  '.description("Log out from your Anthropic account")',
  '.description("Log out from your anymodel account")'),
 ("cli-login-desc","help-text",False,
  '.description("Sign in to your Anthropic account")',
  '.description("Sign in to your anymodel account")'),
 ("cli-marketplaces-desc","help-text",False,
  '"Manage Claude Code marketplaces"','"Manage anymodel marketplaces"'),
 ("cli-plugins-desc","help-text",False,
  '.description("Manage Claude Code plugins")','.description("Manage anymodel plugins")'),
 ("cli-mcp-server-desc","help-text",False,
  'Start the Claude Code MCP server','Start the anymodel MCP server'),
 ("cli-token-desc","help-text",False,
  'Set up a long-lived authentication token (requires Claude subscription)',
  'Set up a long-lived authentication token (requires a provider subscription)'),

 # ── empty-states / inline help tips ──
 ("stats-empty","other-ui",False,
  '"No stats available yet. Start using Claude Code!"',
  '"No stats available yet. Start using anymodel!"'),
 ("help-get-help","help-text",False,
  '/help: Get help with using Claude Code','/help: Get help with using anymodel'),
 ("report-sessions","slash-command-text",False,
  'report analyzing your Claude Code sessions','report analyzing your anymodel sessions'),
 ("settings-env-sessions","help-text",False,
  'to set for Claude Code sessions','to set for anymodel sessions'),
 ("overage-usage","cost-billing",False,
  'overages to power your Claude Code usage','overages to power your anymodel usage'),

 # ── update / install / restart / empty-state status (user-visible) ──
 ("update-uptodate","status-spinner",False,
  'Claude Code is up to date','anymodel is up to date'),
 ("install-progress","status-spinner",False,
  '"Installing Claude Code native build ','"Installing anymodel native build '),
 ("restart-required","error-message",False,
  'manually restart Claude Code','manually restart anymodel'),
 ("no-sessions","other-ui",False,
  '"No Claude Code sessions found"','"No anymodel sessions found"'),
 ("version-mismatch","error-message",False,
  'your version of Claude Code','your version of anymodel'),

 # ── pre-existing user-facing lowercase "anymodel" -> "AnyModel" ──
 # Skill rule: product name is "AnyModel" (capital A/M) in user-facing text; the
 # package/command/URL/env stays lowercase. `from` keeps lowercase to match the
 # bundle; the .replace('anymodel','AnyModel') in the build loop capitalizes `to`.
 ("tier-labels","other-ui",False,
  'case"enterprise":return"anymodel Enterprise";case"team":return"anymodel Team";case"max":return"anymodel";case"pro":return"anymodel";default:return"anymodel"}',
  'case"enterprise":return"anymodel Enterprise";case"team":return"anymodel Team";case"max":return"anymodel";case"pro":return"anymodel";default:return"anymodel"}'),
 ("app-title","welcome-onboarding",False,
  'title:"anymodel"','title:"anymodel"'),
 ("version-banner","other-ui",False,
  'title:`anymodel v','title:`anymodel v'),
 ("bold-sentinel","other-ui",False,
  '{bold:!0},"anymodel")','{bold:!0},"anymodel")'),
 ("via-proxy-fallback","status-spinner",False,
  '"via anymodel proxy"','"via anymodel proxy"'),
]
# Deliberately EXCLUDED (documented, not silently dropped):
#   - "Import MCP servers from Claude Desktop"  -> Claude Desktop is a real external app
#   - "Open in Claude Code on the web" / "Use your existing Claude Code API key"
#       -> Claude-specific auth/web features anymodel does not replicate; rebranding
#          would imply features that don't exist.
#   - "For security, Claude Code may only ..." -> doubles as model system-prompt constraint text
#   - "You are an agent for Claude Code, Anthropic's official CLI" -> model identity (behavioral)
#   - CLAUDE.md guidance text, `prompt:` LLM templates, MCP client_name, ISSUES_EXPLAINER URLs,
#     api.anthropic.com hostnames, model IDs (claude-opus-*/claude-sonnet-*), config key "claude-code".

manifest, missing, dup_to = [], [], []
ids = set()
for (pid, cat, adaptive, frm, to) in E:
    if pid in ids: sys.exit(f"DUP id {pid}")
    ids.add(pid)
    c = src.count(frm)
    if c == 0:
        missing.append((pid, frm)); continue
    # Capitalize the product name in user-facing replacements (skill rule: "AnyModel").
    # Case-sensitive: never touches process.env.ANYMODEL_MODEL (uppercase) or `from`.
    to_cap = to.replace("anymodel", "AnyModel")
    manifest.append({"id":pid,"category":cat,"adaptive":adaptive,"from":frm,"to":to_cap,"expect":c})

if missing:
    print("MISSING ANCHORS:")
    for pid, frm in missing: print(f"  {pid}: {frm[:80]!r}")
    sys.exit(1)

json.dump(manifest, open(OUT,"w"), indent=2, ensure_ascii=False)
print(f"wrote {len(manifest)} patches to {OUT}")
print("expect>1:", [(m['id'],m['expect']) for m in manifest if m['expect']>1])
print("adaptive:", sum(1 for m in manifest if m['adaptive']), " static:", sum(1 for m in manifest if not m['adaptive']))
