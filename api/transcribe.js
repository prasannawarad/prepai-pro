// Whisper transcription via Groq, for browsers without the Web Speech API
// (Firefox). Same posture as api/gemini.js: key server-side only, model
// pinned, per-IP rate limit. Audio arrives as base64 JSON because Vercel
// serverless bodies are capped at ~4.5 MB — the client caps recordings well
// below that.

import { rateLimit } from "./_lib/ratelimit.js";
import { originAllowed } from "./_lib/origin.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // decoded; ~3 min of opus with headroom
const UPSTREAM_TIMEOUT_MS = 25_000;
const RATE_LIMIT = { name: "transcribe", limit: 10, windowSeconds: 60 };

const MIME_EXT = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!originAllowed(req)) {
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }

  const { allowed } = await rateLimit(req, RATE_LIMIT);
  if (!allowed) {
    return res.status(429).json({ error: "Too many requests — wait a minute and try again." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(501).json({
      error: "Voice transcription isn't configured on this server — type your answer instead.",
    });
  }

  const { audio, mimeType = "" } = req.body ?? {};
  const baseMime = String(mimeType).split(";")[0].trim().toLowerCase();
  if (typeof audio !== "string" || !audio) {
    return res.status(400).json({ error: "Missing audio." });
  }
  if (!MIME_EXT[baseMime]) {
    return res.status(400).json({ error: "Unsupported audio format." });
  }

  let buffer;
  try {
    buffer = Buffer.from(audio, "base64");
  } catch {
    return res.status(400).json({ error: "Audio is not valid base64." });
  }
  if (buffer.length === 0 || buffer.length > MAX_AUDIO_BYTES) {
    return res.status(400).json({ error: "Recording is empty or too large — keep answers under ~3 minutes." });
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: baseMime }), `answer.${MIME_EXT[baseMime]}`);
  form.append("model", MODEL);
  form.append("response_format", "json");

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return res.status(504).json({
      error: timedOut ? "Transcription took too long. Try again." : "Could not reach the transcription service.",
    });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return res.status(502).json({ error: "Transcription service returned an unreadable response." });
  }

  if (!upstream.ok) {
    if (upstream.status === 429) {
      return res.status(429).json({ error: "Transcription rate limit reached — wait a minute and try again." });
    }
    return res.status(502).json({ error: data?.error?.message || "Transcription failed." });
  }

  const text = (data.text || "").trim();
  if (!text) {
    return res.status(422).json({ error: "Couldn't hear anything in that recording — try again." });
  }

  return res.status(200).json({ text });
}
