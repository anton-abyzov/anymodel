# Adding the `phi` preset (microsoft/phi-4:free)

Per the skill's "Adding a New Preset" checklist, there are 5 files to edit plus a deployment pipeline to run. Here is every change, in order.

---

## 1. `cli.mjs` -- Add to `MODEL_PRESETS`

**File**: `/Users/antonabyzov/Projects/claude-code-umb/repositories/antonoly/anymodel/cli.mjs`

In the `MODEL_PRESETS` object (line 22-32), add the `phi` entry. Since it is a free model, place it in the free section alongside `qwen`, `nemotron`, and `llama`:

```js
// Before (lines 22-32):
const MODEL_PRESETS = {
  gpt:      'openai/gpt-5.4',
  codex:    'openai/gpt-5.3-codex',
  gemini:   'google/gemini-3.1-flash-lite-preview',
  deepseek: 'deepseek/deepseek-r1-0528',
  mistral:  'mistralai/devstral-2512',
  gemma:    'google/gemma-4-31b-it',
  qwen:     'qwen/qwen3-coder:free',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b:free',
  llama:    'meta-llama/llama-3.3-70b-instruct:free',
};

// After:
const MODEL_PRESETS = {
  gpt:      'openai/gpt-5.4',
  codex:    'openai/gpt-5.3-codex',
  gemini:   'google/gemini-3.1-flash-lite-preview',
  deepseek: 'deepseek/deepseek-r1-0528',
  mistral:  'mistralai/devstral-2512',
  gemma:    'google/gemma-4-31b-it',
  qwen:     'qwen/qwen3-coder:free',
  nemotron: 'nvidia/nemotron-3-super-120b-a12b:free',
  llama:    'meta-llama/llama-3.3-70b-instruct:free',
  phi:      'microsoft/phi-4:free',
};
```

Also add `microsoft/phi-4:free` to the `FREE_MODELS` array (line 35-47):

```js
// Add after the last entry in FREE_MODELS:
  'microsoft/phi-4:free',
```

---

## 2. `cli.mjs` -- Update help text in `printHelp()` and `printQuickUsage()`

**Same file**: `cli.mjs`

### `printQuickUsage()` (line 115)

```
// Before:
${C.bold('Presets:')} gpt, codex, gemini, deepseek, mistral, gemma, qwen, nemotron, llama

// After:
${C.bold('Presets:')} gpt, codex, gemini, deepseek, mistral, gemma, qwen, nemotron, llama, phi
```

### `printHelp()` Model Presets section (around lines 133-142)

Add a new line after the `llama` entry:

```
    llama     -> meta-llama/llama-3.3-70b-instruct:free ${C.cyan('(free)')}
    phi       -> microsoft/phi-4:free                   ${C.cyan('(free)')}
```

Exact edit:

```js
// Before (line 142):
    llama     → meta-llama/llama-3.3-70b-instruct:free ${C.cyan('(free)')}

// After:
    llama     → meta-llama/llama-3.3-70b-instruct:free ${C.cyan('(free)')}
    phi       → microsoft/phi-4:free                   ${C.cyan('(free)')}
```

---

## 3. `KNOWLEDGE-BASE.md` -- Update preset table

**File**: `/Users/antonabyzov/Projects/claude-code-umb/repositories/antonoly/anymodel/KNOWLEDGE-BASE.md`

In the presets table (around line 60), add a new row:

```markdown
| llama | meta-llama/llama-3.3-70b-instruct:free | free |
| phi | microsoft/phi-4:free | free |
```

---

## 4. `site/index.html` -- Update three sections

**File**: `/Users/antonabyzov/Projects/claude-code-umb/repositories/antonoly/anymodel/site/index.html`

### 4a. Built-in presets table (around line 372-374)

The last entry (llama) currently has no `border-bottom` since it is the final row. It needs `border-bottom:1px solid var(--border);` added, and the new `phi` row becomes the last (no border-bottom).

```html
<!-- Before (lines 372-374): -->
          <div style="padding:8px 16px; color:var(--accent-cyan);">llama</div>
          <div style="padding:8px 16px; color:var(--text-secondary);">meta-llama/llama-3.3-70b-instruct:free</div>
          <div style="padding:8px 16px; color:var(--accent-emerald); text-align:right; font-size:0.7rem;">FREE</div>

<!-- After: -->
          <div style="padding:8px 16px; border-bottom:1px solid var(--border); color:var(--accent-cyan);">llama</div>
          <div style="padding:8px 16px; border-bottom:1px solid var(--border); color:var(--text-secondary);">meta-llama/llama-3.3-70b-instruct:free</div>
          <div style="padding:8px 16px; border-bottom:1px solid var(--border); color:var(--accent-emerald); text-align:right; font-size:0.7rem;">FREE</div>

          <div style="padding:8px 16px; color:var(--accent-cyan);">phi</div>
          <div style="padding:8px 16px; color:var(--text-secondary);">microsoft/phi-4:free</div>
          <div style="padding:8px 16px; color:var(--accent-emerald); text-align:right; font-size:0.7rem;">FREE</div>
```

### 4b. CLI Reference presets list (around line 582)

```
<!-- Before: -->
  llama    meta-llama/llama-3.3-70b-instruct:free

<!-- After: -->
  llama    meta-llama/llama-3.3-70b-instruct:free
  phi      microsoft/phi-4:free
```

### 4c. Hero subtitle (line 208) -- optional

The hero text mentions specific model families. Phi could be added if desired:

```html
<!-- Before: -->
<strong>Llama</strong>, <strong>Qwen</strong>, or any of 300+ models

<!-- After: -->
<strong>Llama</strong>, <strong>Qwen</strong>, <strong>Phi</strong>, or any of 300+ models
```

This is optional since the hero already covers it with "300+ models".

---

## 5. `README.md` -- Update presets section

**File**: `/Users/antonabyzov/Projects/claude-code-umb/repositories/antonoly/anymodel/README.md`

In the Presets section (around lines 38-50), add under the free models block:

```markdown
# Free models:
npx anymodel proxy qwen       # -> qwen/qwen3-coder:free                (free)
npx anymodel proxy nemotron   # -> nvidia/nemotron-3-super-120b-a12b:free (free)
npx anymodel proxy llama      # -> meta-llama/llama-3.3-70b-instruct:free (free)
npx anymodel proxy phi        # -> microsoft/phi-4:free                  (free)
```

---

## 6. Deployment Pipeline (MANDATORY per skill)

After all edits, execute every step in order:

```bash
# Step 1: Run all tests
node --test test/*.test.mjs

# Step 2: Commit and push
git add cli.mjs KNOWLEDGE-BASE.md site/index.html README.md
git commit -m "add phi preset mapping to microsoft/phi-4:free"
git push

# Step 3: Version bump and publish to npm
npm version patch
npm run sync-version
npm publish

# Step 4: Deploy website (site/index.html changed, so this is required)
vercel --prod
```

Step 5 (sync client repo) is not needed since `cli.js` was not modified.

---

## Summary of all touched files

| # | File | Change |
|---|------|--------|
| 1 | `cli.mjs` | Add `phi: 'microsoft/phi-4:free'` to `MODEL_PRESETS`, add to `FREE_MODELS`, update `printHelp()` and `printQuickUsage()` |
| 2 | `KNOWLEDGE-BASE.md` | Add row to presets table |
| 3 | `site/index.html` | Add row to built-in presets grid, add to CLI reference presets list, optionally mention in hero |
| 4 | `README.md` | Add `phi` line to presets code block |

Total: 4 files edited, 0 new files created. Every edit is additive (append a new entry to an existing list/table). No existing behavior changes.
