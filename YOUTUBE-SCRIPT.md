**YouTube video:** https://youtu.be/k0RI_M6lIsg

# YouTube Script: "AnyModel — Run Claude Code with GPT, Gemini, DeepSeek, and 200+ Models"

**Duration:** 4-5 minutes
**Style:** Screen recording + voiceover, fast-paced

---

## Title

**AnyModel — Run Claude Code with GPT, Gemini, DeepSeek, and 200+ Models (Free)**

## Description

```
AnyModel lets you run Claude Code with any AI model — GPT-5.4, Gemini 3.1,
DeepSeek R1, Codex, Llama, Qwen, and 200+ more via OpenRouter. Free models
available at $0 cost.

Two terminals. Any model.

--

Get started:
  Terminal 1: OPENROUTER_API_KEY=your-key npx anymodel proxy deepseek
  Terminal 2: npx anymodel

Website: https://anymodel.dev
npm: https://npmjs.com/package/anymodel
GitHub: https://github.com/anton-abyzov/anymodel
Free OpenRouter key: https://openrouter.ai/keys

--

Timestamps:
0:00 The problem — Claude Code is locked to one provider
0:25 What is AnyModel
0:50 Demo: DeepSeek R1 (two terminals)
1:45 Demo: GPT-5.4 and Codex
2:15 Demo: Ollama fully offline (Gemma 4)
2:50 Multiple models at once (different ports)
3:15 Built-in presets — the full list
3:45 Free models that actually work
4:15 How to get started

--

Claude Code any model, Claude Code free, Claude Code OpenRouter, AnyModel,
npx anymodel, Claude Code GPT, Claude Code Gemini, Claude Code DeepSeek,
Claude Code local, Claude Code Ollama, AI coding assistant, Claude Code proxy
```

## Tags

```
claude code, anymodel, claude code any model, claude code free, claude code openrouter,
claude code gpt, claude code gemini, claude code deepseek, npx anymodel,
claude code proxy, claude code ollama, claude code local, ai coding tool,
claude code alternative models, run claude code free, claude code tutorial,
google gemma 4, gpt 5.4 codex, deepseek r1
```

---

## SCRIPT

### HOOK — 0:00 to 0:25

```
[SCREEN: Terminal, Claude Code running normally]

"Claude Code is the best AI coding tool right now.
But it only works with Anthropic models.

What if you could run it with GPT-5.4, Gemini, DeepSeek,
Codex — even completely free models?"

[SCREEN: Quick flash of `npx anymodel proxy deepseek` + `npx anymodel`]

"Two terminals. Any model. I built this. It's called AnyModel."
```

### WHAT IS ANYMODEL — 0:25 to 0:50

```
[SCREEN: anymodel.dev — scroll the homepage]

"AnyModel is an npm proxy. It sits between the client
and your model provider — OpenRouter, Ollama, or any
OpenAI-compatible API.

It strips incompatible fields, handles retries, translates
formats. Zero dependencies. Open source."

[SCREEN: Architecture diagram: AnyModel → anymodel proxy → OpenRouter / Ollama]

"You set the model on the proxy. The client just connects."
```

### DEMO 1: DEEPSEEK R1 — 0:50 to 1:45

```
"Let me show you. Get a free OpenRouter key — link below."

[SCREEN: Clean terminal, split view — two terminals side by side]

[LEFT terminal: Type:]
  OPENROUTER_API_KEY=sk-or-v1-my-key npx anymodel proxy deepseek

[LEFT: Output:]
  anymodel v1.6.31
  Proxy on :9090 → OpenRouter
  Model override: deepseek/deepseek-r1-0528

  Next step — run in another terminal:
    npx anymodel

"The proxy is running with DeepSeek R1. Now in the second terminal..."

[RIGHT terminal: Type:]
  npx anymodel

[RIGHT: Output:]
  [anymodel] Connected to proxy on :9090
  [anymodel] Model: deepseek/deepseek-r1-0528
  [anymodel] Starting...

  ◆▟▀█▀▙◆    AnyModel v1.6.31
   ▜█████▛   deepseek/deepseek-r1-0528 · anymodel

"That's it. The violet character means you're running AnyModel,
not standard Claude. And it shows the model — DeepSeek R1."

[TYPE: "What's 127 * 389? Think step by step."]

[SCREEN: DeepSeek R1 shows its thinking process — visible chain-of-thought
streaming in real-time: "Let me break this down... 127 × 400 = 50,800...
minus 127 × 11 = 1,397... so 50,800 - 1,397 = 49,403"]

"See that? DeepSeek R1 shows its thinking process live.
That's the power of a reasoning model — and it's running
through AnyModel, not through Anthropic."

[BEAT — let the thinking finish, answer appears: 49,403]

"Tool use, file editing, bash — all works too. Same experience,
different brain."
```

### DEMO 2: GPT-5.4 AND CODEX — 1:45 to 2:15

```
"Want GPT instead? Just change the preset."

[SCREEN: Stop proxy, restart:]
  npx anymodel proxy gpt

[LEFT: Shows "Model override: openai/gpt-5.4"]

"gpt gives you GPT-5.4 — the latest. There's also codex —
OpenAI's dedicated coding model."

  npx anymodel proxy codex

[LEFT: Shows "Model override: openai/gpt-5.3-codex"]

"Presets are shortcuts. You can also use --model for
any of the 200+ models on OpenRouter."
```

### DEMO 3: OLLAMA OFFLINE — 2:15 to 2:50

```
"And if you want to go fully offline — no internet, no API key."

[SCREEN: Terminal]

  ollama pull gemma3n
  npx anymodel proxy ollama --model gemma3n

"Google's Gemma — runs locally, everything stays on your machine.
3 gigabytes of RAM. Private."

[SCREEN: Show second terminal connecting with `npx anymodel`]
```

### MULTIPLE MODELS — 2:50 to 3:15

```
"Here's a power move. Run multiple proxies on different ports."

[SCREEN: Three terminal panes]

  npx anymodel proxy --port 9090 --model openai/gpt-5.4
  npx anymodel proxy --port 9091 --model deepseek/deepseek-r1-0528
  npx anymodel proxy --port 9092 --model google/gemini-3.1-flash-lite-preview

"Three models running simultaneously. Connect to any port."
```

### PRESETS — 3:15 to 3:45

```
[SCREEN: Show the preset table from anymodel.dev]

"Built-in presets:"

  gpt       → openai/gpt-5.4
  codex     → openai/gpt-5.3-codex        (coding)
  gemini    → google/gemini-3.1-flash-lite
  deepseek  → deepseek/deepseek-r1-0528
  qwen      → qwen/qwen3-coder:free       (free)
  nemotron  → nvidia/nemotron-3-super-120b (free)
  llama     → meta-llama/llama-3.3-70b    (free)
  gemma     → google/gemma-4-31b-it

"Four of them are free. Zero cost."
```

### CTA — 3:45 to 4:15

```
[SCREEN: anymodel.dev]

"AnyModel is free, open source, MIT licensed.

Get your OpenRouter key — link below. Then:
  Terminal 1: npx anymodel proxy deepseek
  Terminal 2: npx anymodel

That's it. anymodel.dev for the full docs."

[BEAT]

"Subscribe if you want more tools like this.
I'm shipping weekly."

[END SCREEN: Subscribe button + card to previous video]
```

---

## End Screen Strategy (last 20 seconds)

- **Left card:** Previous video (e.g., "Claude Code Source" or latest)
- **Right card:** Subscribe button
- **Verbal:** "Subscribe for more AI tools" — keep it simple

## Thumbnail

- AnyModel logo (violet diamond) on left
- Terminal screenshot showing the two-terminal flow
- Text: "ANY MODEL" in bold, model logos (GPT, Gemini, DeepSeek) scattered
- Your face on the right
