# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
VITE_GEMINI_API_KEY=your-gemini-api-key-here
```

The key is accessed in code via `import.meta.env.VITE_GEMINI_API_KEY`. Only `VITE_`-prefixed variables are exposed to the browser bundle by Vite.

Deployment targets **Vercel** (`vercel.json`); set `VITE_GEMINI_API_KEY` in the Vercel project environment. Custom domains are configured in the Vercel dashboard (DNS at your registrar).

## Architecture

This is a **single-file React application**. All logic, UI, and inline styles live in [src/App.jsx](src/App.jsx). There is no routing, no state management library, and no component library.

### Two modes, one component

`App.jsx` exports a single `PrepAIPro` component that manages two distinct flows via `activeMode` state:

- **`research` mode** — User enters company + role (+ optional resume text or `.txt/.md` upload). A single Gemini JSON request returns the dossier: history, products/market, culture, recent news, interview playbook, plus STAR stories when resume text is present. Search grounding is enabled for recency.
- **`mock` mode** — A multi-turn conversation loop. `handleMockStart()` seeds the conversation with a system prompt embedding company/role/difficulty context. Each `handleMockSend()` appends the user answer, sends the full history to Gemini, and receives an interviewer reply. After 5 questions, `handleMockComplete()` fires a separate scoring prompt (temperature 0.5) that returns a JSON scorecard.

### Gemini API integration

Two thin wrappers in [src/App.jsx](src/App.jsx) handle all API calls:

- `callGemini(prompt, temperature, tools?)` — raw text response
- `callGeminiJSON(prompt, temperature, tools?)` — strips markdown fences and `JSON.parse`s the result

Model: `gemini-2.5-flash` via `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`.

Google Search grounding is passed via the `tools` parameter as `[{ google_search: {} }]`.

### Styling

All styles are inline objects defined directly in JSX — no CSS modules, no Tailwind, no component library. Global tokens live in `src/index.css`. Fonts are loaded in `src/index.css` (Fraunces + Geist + JetBrains Mono).

### Temperature conventions

| Task | Temperature |
|------|-------------|
| Research / company data | 0.7 |
| Mock interview responses | 0.8 |
| Scorecard / evaluation | 0.5 |
