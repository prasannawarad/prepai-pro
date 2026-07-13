// Vercel serverless proxy for Gemini. The API key lives only in the server
// environment (GEMINI_API_KEY — no VITE_ prefix, so it never enters the bundle).
// Model, tools, and token cap are pinned here so the endpoint can't be
// repurposed as a general-purpose Gemini relay.

import { rateLimit } from "./_lib/ratelimit.js";
import { originAllowed } from "./_lib/origin.js";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const MAX_PROMPT_CHARS = 120_000; // resume cap (80k) + prompt scaffolding, with headroom
const MAX_SCHEMA_CHARS = 10_000;
const UPSTREAM_TIMEOUT_MS = 55_000; // under the 60s maxDuration in vercel.json
const RATE_LIMIT = { name: "gemini", limit: 10, windowSeconds: 60 };

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing its Gemini API key." });
  }

  const { prompt, temperature = 0.7, useSearch = false, responseSchema = null } = req.body ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "A non-empty prompt is required." });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: "Prompt is too long." });
  }

  const temp = Number.isFinite(Number(temperature))
    ? Math.min(Math.max(Number(temperature), 0), 1)
    : 0.7;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: temp, maxOutputTokens: 8192 },
  };
  if (useSearch === true) requestBody.tools = [{ google_search: {} }];

  // Gemini can't combine tools with JSON mode, so the schema only applies to
  // ungrounded calls (the scorecard). Guarantees parseable, shape-valid JSON.
  if (responseSchema && !useSearch) {
    if (
      typeof responseSchema !== "object" ||
      Array.isArray(responseSchema) ||
      JSON.stringify(responseSchema).length > MAX_SCHEMA_CHARS
    ) {
      return res.status(400).json({ error: "Invalid response schema." });
    }
    requestBody.generationConfig.responseMimeType = "application/json";
    requestBody.generationConfig.responseSchema = responseSchema;
  }

  let upstream;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return res.status(504).json({
      error: timedOut
        ? "Gemini took too long to respond. Try again."
        : "Could not reach Gemini. Try again.",
    });
  }

  let data;
  try {
    data = await upstream.json();
  } catch {
    return res.status(502).json({ error: "Gemini returned an unreadable response. Try again." });
  }

  if (!upstream.ok || data.error) {
    const status = data.error?.code || upstream.status;
    if (status === 429 || data.error?.status === "RESOURCE_EXHAUSTED") {
      return res.status(429).json({ error: "Rate limit reached — wait a minute and try again." });
    }
    if (status === 503 || data.error?.status === "UNAVAILABLE") {
      return res.status(503).json({ error: "Gemini is briefly overloaded — wait a few seconds and try again." });
    }
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: "The server's Gemini key was rejected." });
    }
    return res.status(502).json({ error: data.error?.message || "Gemini API error." });
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    return res.status(502).json({ error: "Gemini returned an empty response. Try again." });
  }

  return res.status(200).json({ text });
}
