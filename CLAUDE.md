# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PrepAI Pro — an AI interview-prep web app with two modes: a company/role research dossier generator (with optional resume-tailored STAR stories) and a multi-turn mock interview with an AI scorecard. Powered by Gemini, deployed on Vercel.

## Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Production build → dist/
npm run preview   # Serve the production build locally
npm run lint      # ESLint with flat config
```

No test framework is configured — there are no test files or test scripts.

## Environment

Copy `.env.example` to `.env` and set:
```
GEMINI_API_KEY=your-gemini-api-key-here
```

The key is **server-side only** — read via `process.env.GEMINI_API_KEY` in [api/gemini.js](api/gemini.js). It must never get a `VITE_` prefix (Vite would inline it into the browser bundle; that leak is exactly what the proxy exists to prevent).

Optional: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` enable cross-instance rate limiting on the API functions (see [api/_lib/ratelimit.js](api/_lib/ratelimit.js)); without them a per-instance in-memory limiter is used. `GROQ_API_KEY` enables Whisper voice transcription via [api/transcribe.js](api/transcribe.js) — only needed for browsers without the Web Speech API (Firefox); without it that endpoint returns a friendly 501.

Deployment targets **Vercel** (`vercel.json`, which also sets security headers incl. CSP); set `GEMINI_API_KEY` in the Vercel project environment (delete the old `VITE_GEMINI_API_KEY` if present). Custom domains are configured in the Vercel dashboard (DNS at your registrar). CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint + build on pushes and PRs.

## Architecture

This is a **single-file React application**. All logic, UI, and inline styles live in [src/App.jsx](src/App.jsx). There is no routing, no state management library, and no component library.

### Two modes, one component

`App.jsx` exports a single `PrepAIPro` component that manages two distinct flows via `activeMode` state:

- **`research` mode** — User enters company + role (+ optional resume via paste or `.txt/.md/.pdf` upload, + optional pasted job posting). A single Gemini JSON request returns the dossier: history, products/market, culture, recent news, interview playbook, plus STAR stories when a resume is present and a Fit & gaps tab when a job posting is present. Search grounding is enabled for recency. PDF text extraction uses `pdfjs-dist`, lazy-loaded only when a PDF is chosen (keeps it out of the main bundle).
- **`mock` mode** — A multi-turn conversation loop. `startMockInterview()` seeds the conversation with a prompt embedding company/role/difficulty (+ resume/JD) context. Each `sendMockAnswer()` appends the user answer, sends the full history to Gemini, and receives an interviewer reply. After 5 questions, `generateScorecard()` fires a separate scoring prompt (temperature 0.5, `responseSchema`-enforced JSON) — it is also wired to a retry button so a failed scoring run isn't a dead end.

### Voice mode (mock interview)

- **Answers by voice** — `startVoiceAnswer()` is **Whisper-first**: audio is recorded via `MediaRecorder` (echo cancellation + noise suppression on) and sent as base64 JSON to [api/transcribe.js](api/transcribe.js) (Whisper `whisper-large-v3-turbo` on Groq — much better with accents than browser dictation). If the server returns 501 (no `GROQ_API_KEY`), the client remembers and falls back to Web Speech API live dictation (`navigator.language` English variants). Recordings auto-stop at 3 minutes; the endpoint caps decoded audio at 3 MB (Vercel body limit is ~4.5 MB).
- **Interviewer voice** — browser `speechSynthesis` reads new interviewer messages aloud when the user toggles it on; it is cancelled whenever the mic starts so the recording doesn't capture the interviewer.

### Guardrails

- Both API functions reject cross-origin browser requests ([api/_lib/origin.js](api/_lib/origin.js)) and rate-limit per IP; Gemini 429/503 map to friendly retry messages.
- Resume, job posting, and candidate answers are wrapped as untrusted data in every prompt (never follow embedded instructions). The mock interviewer has a persona block (`interviewerPersona()` in App.jsx) with conduct rules: stay in character, steer back off-topic input, ask for a repeat on garbled/unclear answers instead of pretending they made sense, cap reply length. The scorecard prompt scores only what the transcript supports and ignores embedded score requests.

### Gemini API integration

The browser never talks to Gemini directly. All calls go through **[api/gemini.js](api/gemini.js)**, a Vercel serverless function that holds the API key, pins the model (`gemini-2.5-flash`), caps `maxOutputTokens` at 8192, clamps temperature, rate-limits per IP (10 req/min), and maps upstream errors (429 quota, key rejection, timeout) to friendly messages. Its request contract is `POST /api/gemini` with `{ prompt, temperature, useSearch, responseSchema }`; it responds `{ text }` or `{ error }`.

Two thin client wrappers in [src/App.jsx](src/App.jsx) call the proxy:

- `callGemini(prompt, { temperature, useSearch, responseSchema })` — raw text response
- `callGeminiJSON(prompt, options)` — same options; extracts the outermost `{…}` from the reply and `JSON.parse`s it

`useSearch: true` enables Google Search grounding (server adds `tools: [{ google_search: {} }]`); only the research dossier uses it. `responseSchema` turns on Gemini JSON mode for guaranteed-shape output — the scorecard uses it (`SCORECARD_SCHEMA`), but it **cannot be combined with `useSearch`** (Gemini limitation; the server silently ignores the schema on grounded calls).

In dev, a middleware plugin in [vite.config.js](vite.config.js) serves the same handler at `/api/gemini`, so `npm run dev` works without the Vercel CLI. The plugin and the handler share one code path — change [api/gemini.js](api/gemini.js) and both environments pick it up.

**Rendering gotcha:** dossier markdown is rendered via `dangerouslySetInnerHTML`. `parseMarkdown()` HTML-escapes the LLM text *before* its regex transforms — keep that ordering, it is the XSS defense.

### Styling

All styles are inline objects defined directly in JSX — no CSS modules, no Tailwind, no component library. Global tokens live in `src/index.css`. Fonts are loaded in `src/index.css` (Fraunces + Geist + JetBrains Mono).

### Temperature conventions

| Task | Temperature |
|------|-------------|
| Research / company data | 0.7 |
| Mock interview responses | 0.8 |
| Scorecard / evaluation | 0.5 |
