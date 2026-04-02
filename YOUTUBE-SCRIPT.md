# YouTube Script: "Run Claude Code with Any AI Model — Free, One Command (anymodel)"

**Duration:** 4-5 minutes
**Style:** Screen recording + voiceover, fast-paced

---

## Title

**Run Claude Code with Any AI Model — Free, One Command (anymodel)**

## Description

```
Run Claude Code with GPT, Gemini, Llama, DeepSeek — even free models.
No lock-in. One command: npx anymodel

anymodel is an open-source proxy that lets Claude Code work with 200+
AI models via OpenRouter or local Ollama. Zero dependencies, zero cost
for free models.

--

Get started:
OPENROUTER_API_KEY=your-key npx anymodel

Website: https://anymodel.dev
npm: https://npmjs.com/package/anymodel
GitHub: https://github.com/anton-abyzov/anymodel
Free OpenRouter key: https://openrouter.ai/keys

--

Timestamps:
0:00 Claude Code is locked to one provider
0:25 The problem with other models
0:50 What is anymodel
1:15 Demo: Remote proxy (one command)
2:30 Demo: Local proxy (two terminals)
3:15 Demo: Ollama (fully offline)
3:45 OpenAI-compatible APIs (GPT, Groq, vLLM)
4:15 Free models — which ones actually work
4:45 How to get started

--

Claude Code alternative models, Claude Code free, Claude Code OpenRouter,
Claude Code any model, Claude Code GPT, Claude Code Gemini, Claude Code
local LLM, Claude Code Ollama, npx anymodel, anymodel npm, AI coding
assistant any model, Claude Code proxy, run Claude Code for free
```

## Tags

```
claude code, claude code any model, claude code free, claude code openrouter,
claude code proxy, npx anymodel, anymodel, claude code gpt, claude code gemini,
claude code llama, claude code ollama, claude code local, ai coding tool,
claude code alternative models, run claude code free, anthropic claude code,
claude code tutorial, claude code tips
```

---

## SCRIPT

### HOOK — 0:00 to 0:25

```
[SCREEN: Terminal, Claude Code is running]

"Claude Code is the best AI coding tool right now.
But it only works with Anthropic models.

What if I told you — you can run it with GPT, Gemini,
Llama, DeepSeek... even completely free models?"

[SCREEN: Type `npx anymodel` — proxy starts, shows model name]

"One command. I built this. It's called anymodel."
```

### PROBLEM — 0:25 to 0:50

```
[SCREEN: Claude Code login screen — show the 3 options briefly]

"When you install Claude Code, you get three login options.
Anthropic subscription, API key, or cloud platforms.
All Anthropic.

OpenRouter has 200 models — including free ones. And Claude
Code actually supports custom endpoints. But if you point it
at a non-Anthropic model..."

[SCREEN: Show error — 1 second]

"It breaks. Claude Code sends fields that only Anthropic
understands."
```

### SOLUTION — 0:50 to 1:15

```
[SCREEN: anymodel.dev — clean scroll of the homepage]

"So I built anymodel. An npm proxy. It strips the incompatible
fields, handles retries, translates formats, and routes your
requests to any provider.

Zero dependencies. 8 kilobytes on npm. Open source."

[SCREEN: Show the architecture diagram briefly]

"Your tool, your proxy, your models."
```

### DEMO 1: REMOTE — 1:15 to 2:30

```
"The easiest way. You need a free OpenRouter key —
link in the description."

[SCREEN: Clean terminal. Type slowly enough to read:]

  OPENROUTER_API_KEY=sk-or-v1-my-key npx anymodel

[SCREEN: Output appears:]

  [anymodel] OpenRouter key loaded: sk-or-v1-ac0...
  [anymodel] Proxy: remote (api.anymodel.dev)
  [anymodel] Model: nvidia/nemotron-3-super-120b-a12b:free
  [anymodel] Starting...

  ▗▟▀█▀▙▖    anymodel v1.5.0
   ▜█████▛   nvidia/nemotron-3-super-120b:free · anymodel

"One command. It connected to the remote proxy, picked a free
NVIDIA Nemotron model — 120 billion parameters, zero cost —
and launched the interface."

[TYPE a coding prompt: "Write a Python function that finds prime numbers"]

[SCREEN: Model responds with working code, streaming in real-time]

"Full Claude Code experience. Tool use, file editing, bash
commands — all working on a free model."

[BEAT — let the response finish]

"You can pick a specific model with --model."

[SCREEN: Show briefly:]
  npx anymodel --model qwen/qwen3-coder:free
  npx anymodel --model openai/gpt-oss-120b:free
```

### DEMO 2: LOCAL — 2:30 to 3:15

```
"Want full control? Run the proxy on your machine."

[SCREEN: Split terminal]

[LEFT: Type:]
  OPENROUTER_API_KEY=sk-or-v1-... npx anymodel proxy --port 9090

[LEFT: Proxy starts, shows model and port]

[RIGHT: Type:]
  ANTHROPIC_BASE_URL=http://localhost:9090 node cli.js

[RIGHT: anymodel banner appears]

"Two terminals. Left runs the proxy, right runs the app.
Everything local. And look at the proxy log..."

[SCREEN: Highlight the proxy log line:]
  [OPENROUTER] POST /v1/messages model=claude-opus-4-6 → nvidia/nemotron-3-super-120b:free

"Claude Code requested Opus 4.6. The proxy swapped it to
the free Nemotron model. Transparent."
```

### DEMO 3: OLLAMA — 3:15 to 3:45

```
"And if you want to go fully offline."

[SCREEN: Terminal]

  ollama pull qwen3-coder:30b
  npx anymodel proxy ollama --model qwen3-coder:30b

"Ollama runs the model locally. No API key, no internet,
nothing leaves your machine. Private."
```

### OPENAI PROVIDER — 3:45 to 4:15

```
"One more thing. If you have an OpenAI key, or use
Groq, Together, LMStudio — anymodel translates
the format automatically."

[SCREEN: Terminal]

  OPENAI_API_KEY=sk-... npx anymodel proxy openai --model gpt-4o

"Full bidirectional translation. Anthropic format in,
OpenAI format out. Streaming, tool calling — all works.

Three providers. One proxy. Any model."
```

### CTA — 4:15 to 4:40

```
[SCREEN: anymodel.dev]

"anymodel is free, open source, MIT licensed.

Get your OpenRouter key — link below. Install is just
npx anymodel. Website is anymodel.dev."

[BEAT]

"If you watched my video on Claude Code's leaked source —
this is what I built from it. Subscribe if you want more
tools like this. I'm shipping weekly."

[END SCREEN: Subscribe button + card to previous video]
```

---

## End Screen Strategy (last 20 seconds)

- **Left card:** Previous video ("Claude Code's Full Source Leaked")
- **Right card:** Subscribe button
- **Verbal:** "Watch the video that started this" — drives viewers to your 8K video

## Thumbnail

Generated at: `/Users/antonabyzov/Pictures/youtube_thumbnail_anymodel.png`
Composite your face on the left side.
