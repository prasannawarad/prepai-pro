import { useState, useRef, useEffect, useMemo } from "react";

const MAX_RESUME_FILE_BYTES = 512 * 1024;
const MAX_RESUME_CHARS = 80_000;
const MAX_PDF_FILE_BYTES = 5 * 1024 * 1024;
const MAX_JD_CHARS = 30_000;
const MAX_RECORDING_MS = 180_000;           // auto-stop voice answers at 3 min
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;    // matches the /api/transcribe cap

/* ─────────────────────────────────────────────────────────────────────
   PREPAI//PRO  ·  Editorial Intelligence Briefing (mid-dark)
   Warm graphite surfaces · soft ivory type · vermillion accent.
   Fraunces · Geist · JetBrains Mono.
   ───────────────────────────────────────────────────────────────────── */

// ─── Section taxonomy (JSON keys must match Gemini response) ───
const RESEARCH_SECTIONS = [
  { id: "history",        num: "1", label: "History" },
  { id: "business",       num: "2", label: "Products & market" },
  { id: "culture",        num: "3", label: "Culture" },
  { id: "news",           num: "4", label: "Latest news" },
  { id: "interview_tips", num: "5", label: "Interview playbook" },
  { id: "star_stories",   num: "6", label: "Your STAR stories" },
  { id: "fit_gaps",       num: "7", label: "Fit & gaps" },
];

const DIFFICULTY_LEVELS = [
  { id: "easy",   label: "Easy",   desc: "Intro & behavioral questions", glyph: "○" },
  { id: "medium", label: "Medium", desc: "Behavioral + technical mix",   glyph: "◐" },
  { id: "hard",   label: "Hard",   desc: "Tough, deep-dive questions",   glyph: "●" },
];

const MODES = [
  {
    id: "research",
    num: "01",
    label: "Company Brief",
    tagline: "History, business fit, culture, news & playbook",
    desc: "Six dossier tabs: timeline, what they sell, culture, recent headlines, interview process & tips, plus STAR stories when you add a resume.",
    suggest: true,
  },
  {
    id: "mock",
    num: "02",
    label: "Mock Interview",
    tagline: "Practice & scored feedback",
    desc: "Five questions with an AI interviewer, then a scorecard with strengths, gaps, and per-question notes.",
    suggest: false,
  },
];

/** Single place first-time visitors look for “what do I do?” */
const FLOW_STEPS = [
  { k: "1", title: "Choose a mode", body: "Company Brief first, or Mock Interview if you only want practice." },
  { k: "2", title: "Enter the company", body: "Add a role if you want tighter tips and questions." },
  { k: "3", title: "Run it", body: "Research company or Start Mock Interview — results stay in this tab." },
];

const SUBJECT_HINTS = ["Stripe", "Anthropic", "Netflix", "Snowflake", "Figma", "Apple"];

// Tips that rotate while the brief is being prepared.
const INTERVIEW_TIPS = [
  "Most candidates ramble. Aim for 60–90 seconds per answer.",
  "Use the STAR format: Situation, Task, Action, Result.",
  "Always have one good question ready for your interviewer.",
  "Match your stories to the company’s stated values.",
  "Quantify your impact — numbers stick. “Improved X by 40%.”",
  "Listen for what they’re really asking, not just the literal question.",
  "Practice your answers out loud, not just in your head.",
  "It’s okay to pause and think before answering.",
  "Ask about the team’s biggest current challenge — shows real interest.",
  "Be specific about what you did. Skip the team’s collective ‘we’.",
];

// Steps shown progressively while the company brief loads.
const RESEARCH_STEPS_BASE = [
  "Searching the public web",
  "Building timeline & milestones",
  "Mapping products, customers & competitors",
  "Synthesizing culture & ways of working",
  "Collecting recent headlines",
  "Drafting interview playbook",
];
const RESEARCH_STEP_JD = "Mapping you against the job posting";
const RESEARCH_STEP_STAR = "Writing your STAR stories";
const MOCK_INIT_STEPS = [
  "Briefing your interviewer",
  "Setting the difficulty",
  "Crafting the first question",
];
const MOCK_REPORT_STEPS = [
  "Reading your transcript",
  "Scoring each answer",
  "Writing your feedback",
];

// ─── PDF text extraction (pdfjs is lazy-loaded so it never weighs down
//     the main bundle — only users who pick a .pdf pay for it) ───
async function extractPdfText(file) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pageCount = Math.min(doc.numPages, 10);
  let text = "";
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n\n";
  }
  return text;
}

// ─── Markdown → editorial HTML ───
// Escape first: the text comes from an LLM (with search grounding, it can echo
// arbitrary web content), and the result is rendered via dangerouslySetInnerHTML.
// After escaping, the only tags in the output are the ones we insert below.
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseMarkdown(text) {
  if (!text) return "";
  // The model very occasionally returns nested JSON where a markdown string
  // was asked for — degrade to readable text rather than crashing the render.
  if (typeof text !== "string") text = JSON.stringify(text, null, 2);
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^### (.*$)/gm, '<h4 class="md-h4">$1</h4>')
    .replace(/^## (.*$)/gm, '<h3 class="md-h3">$1</h3>')
    .replace(/^- (.*$)/gm, '<li class="md-li">$1</li>')
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

// ─── Gemini API (via serverless proxy — the key never reaches the browser) ───
async function callGemini(prompt, { temperature = 0.7, useSearch = false, responseSchema = null } = {}) {
  let response;
  try {
    response = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, temperature, useSearch, responseSchema }),
      // Slightly past the server's own 55s upstream timeout, so the friendlier
      // server-side 504 message wins when Gemini is merely slow.
      signal: AbortSignal.timeout(65_000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError")
      throw new Error("The request timed out. Try again.");
    throw new Error("Network error — check your connection and try again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Unexpected server response. Try again.");
  }
  if (!response.ok || data.error) throw new Error(data.error || "API error");
  if (!data.text) throw new Error("No response from Gemini.");
  return data.text;
}

async function callGeminiJSON(prompt, options) {
  const raw = await callGemini(prompt, options);
  // Grounded responses can wrap the JSON in fences or prose; extract the
  // outermost object rather than trusting the whole reply to parse.
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new SyntaxError("No JSON object in response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Enforced server-side via Gemini's responseSchema — the scorecard comes back
// as guaranteed-valid JSON in exactly this shape (ungrounded calls only).
const SCORECARD_SCHEMA = {
  type: "OBJECT",
  properties: {
    overall_score: { type: "NUMBER" },
    summary: { type: "STRING" },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    improvements: { type: "ARRAY", items: { type: "STRING" } },
    per_question: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question_summary: { type: "STRING" },
          score: { type: "NUMBER" },
          feedback: { type: "STRING" },
        },
        required: ["question_summary", "score", "feedback"],
      },
    },
    final_tip: { type: "STRING" },
  },
  required: ["overall_score", "summary", "strengths", "improvements", "per_question", "final_tip"],
};

// ─────────── Atomic typographic primitives ───────────

const Hairline = ({ thick = false, color, delay = 0, style }) => (
  <div
    className="hairline"
    style={{
      height: thick ? 2 : 1,
      background: color || "var(--ink)",
      animationDelay: `${delay}s`,
      ...style,
    }}
  />
);

const SmallLabel = ({ children, color = "var(--ink-3)", style }) => (
  <span
    style={{
      fontFamily: "var(--mono)",
      fontSize: 10,
      letterSpacing: "0.22em",
      textTransform: "uppercase",
      fontWeight: 500,
      color,
      ...style,
    }}
  >
    {children}
  </span>
);

const LeaderRow = ({ label, value, valueColor = "var(--ink)", labelColor = "var(--ink-3)" }) => (
  <div style={{
    display: "flex", alignItems: "baseline",
    fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em",
    padding: "5px 0", gap: 6,
    minWidth: 0,
    width: "100%",
  }}>
    <span style={{ color: labelColor, fontWeight: 500, textTransform: "uppercase", whiteSpace: "nowrap", flexShrink: 0 }}>
      {label}
    </span>
    <span style={{
      flex: "1 1 0",
      minWidth: 12,
      borderBottom: "1px dotted color-mix(in srgb, var(--ink) 40%, transparent)",
      transform: "translateY(-3px)",
    }} />
    <span style={{
      color: valueColor,
      fontWeight: 700,
      textTransform: "uppercase",
      fontFeatureSettings: '"tnum"',
      flex: "0 1 auto",
      minWidth: 0,
      maxWidth: "62%",
      textAlign: "right",
      lineHeight: 1.35,
      overflowWrap: "anywhere",
      wordBreak: "break-word",
    }}>
      {value}
    </span>
  </div>
);

// Glyph-by-glyph reveal for hero text
const GlyphTitle = ({ text, baseDelay = 0, style }) => (
  <span style={{ display: "inline-block", ...style }}>
    {text.split("").map((ch, i) => (
      <span
        key={i}
        className="glyph"
        style={{
          display: "inline-block",
          whiteSpace: ch === " " ? "pre" : "normal",
          animationDelay: `${baseDelay + i * 0.025}s`,
        }}
      >
        {ch}
      </span>
    ))}
  </span>
);

// Rotated rubber stamp
const Stamp = ({ children, rotate = -7, color = "var(--vermillion)", size = 72, style }) => (
  <div
    aria-hidden
    style={{
      display: "inline-flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      padding: "14px 22px",
      border: `3px double ${color}`,
      color,
      fontFamily: "var(--mono)",
      fontWeight: 700,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      fontSize: size * 0.18,
      lineHeight: 1.05,
      transform: `rotate(${rotate}deg)`,
      animation: "stampDrop 0.7s cubic-bezier(.2,.8,.2,1.1) both",
      animationDelay: "0.4s",
      borderRadius: 2,
      opacity: 0.94,
      whiteSpace: "nowrap",
      textAlign: "center",
      boxShadow: "0 0 0 1px color-mix(in srgb, var(--vermillion) 35%, transparent), 0 12px 40px color-mix(in srgb, black 45%, transparent)",
      ...style,
    }}
  >
    {children}
  </div>
);

// Score visualization
const ScoreBar = ({ score, max = 10, delay = 0 }) => {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const tone = score >= 7.5 ? "var(--forest)" : score >= 5.5 ? "var(--amber)" : "var(--crimson)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--mono)" }}>
      <div style={{
        flex: 1, height: 24, position: "relative",
        background: "transparent",
        borderTop: "var(--hair)",
        borderBottom: "var(--hair)",
      }}>
        {/* tick marks */}
        {Array.from({ length: max + 1 }).map((_, i) => (
          <div key={i} style={{
            position: "absolute", left: `${(i / max) * 100}%`, top: 0, bottom: 0,
            width: 1, background: i === score ? tone : "color-mix(in srgb, var(--ink) 22%, transparent)",
            opacity: i === 0 || i === max ? 1 : 0.6,
          }} />
        ))}
        {/* fill bar — scaleX avoids layout thrash vs animating width */}
        <div style={{
          position: "absolute", left: 0, top: 5, bottom: 5,
          width: `${pct}%`,
          overflow: "hidden",
          pointerEvents: "none",
        }}>
          <div style={{
            height: "100%",
            width: "100%",
            transformOrigin: "left center",
            background: tone,
            animation: `scoreFillScale 1s cubic-bezier(.2,.8,.2,1) ${delay}s both`,
            boxShadow: `inset 0 0 0 1px var(--ink)`,
          }} />
        </div>
      </div>
      <span style={{
        fontSize: 22, fontWeight: 700, color: "var(--ink)",
        fontFamily: "var(--serif)",
        fontVariationSettings: '"opsz" 144, "wght" 700, "SOFT" 60',
        letterSpacing: "-0.02em",
        minWidth: 70, textAlign: "right",
      }}>
        {Number(score).toFixed(1)}<span style={{ color: "var(--ink-4)", fontSize: 14, fontWeight: 400 }}>/{max}</span>
      </span>
    </div>
  );
};

// ─────────── Main Component ───────────

export default function PrepAIPro() {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [resume, setResume] = useState("");
  const [jd, setJd] = useState("");
  const [activeMode, setActiveMode] = useState("research");
  const [activeTab, setActiveTab] = useState("history");

  const [researchData, setResearchData] = useState(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const [mockDifficulty, setMockDifficulty] = useState("medium");
  const [mockStarted, setMockStarted] = useState(false);
  const [mockMessages, setMockMessages] = useState([]);
  const [mockInput, setMockInput] = useState("");
  const [mockLoading, setMockLoading] = useState(false);
  const [mockQuestionCount, setMockQuestionCount] = useState(0);
  const [mockComplete, setMockComplete] = useState(false);
  const [mockScorecard, setMockScorecard] = useState(null);
  const [scoreFailed, setScoreFailed] = useState(false);

  const [error, setError] = useState("");
  const [showResume, setShowResume] = useState(false);
  const [showJd, setShowJd] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Voice: "idle" | "recording" | "transcribing" (transcribing = Whisper path only)
  const [recState, setRecState] = useState("idle");
  const [voiceOn, setVoiceOn] = useState(false);

  const inputRef = useRef(null);
  const chatEndRef = useRef(null);
  const mockInputRef = useRef(null);
  const resumeFileRef = useRef(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recTimeoutRef = useRef(null);

  const ingestResumeFile = (file) => {
    if (!file) return;
    const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
    if (isPdf) {
      if (file.size > MAX_PDF_FILE_BYTES) {
        setError(`PDF is too large — max ${MAX_PDF_FILE_BYTES / (1024 * 1024)} MB.`);
        return;
      }
      setError("");
      extractPdfText(file)
        .then(text => {
          const trimmed = text.replace(/[ \t]+/g, " ").trim();
          if (!trimmed) {
            setError("Couldn't find selectable text in that PDF — is it a scan? Paste the text instead.");
            return;
          }
          setResume(trimmed.slice(0, MAX_RESUME_CHARS));
          setShowResume(true);
        })
        .catch(() => setError("Could not read that PDF — try pasting the text instead."));
      return;
    }
    if (file.size > MAX_RESUME_FILE_BYTES) {
      setError(`Resume file is too large — max ${MAX_RESUME_FILE_BYTES / 1024} KB. Trim or paste instead.`);
      return;
    }
    const okName = /\.(txt|md)$/i.test(file.name);
    const okType = !file.type || file.type === "text/plain" || file.type === "text/markdown";
    if (!okName && !okType) {
      setError("Please choose a .txt or .md file (exported plain text).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const trimmed = text.trim();
      if (!trimmed) {
        setError("That file looks empty.");
        return;
      }
      setResume(trimmed.slice(0, MAX_RESUME_CHARS));
      setShowResume(true);
      setError("");
    };
    reader.onerror = () => setError("Could not read that file — try pasting the text instead.");
    reader.readAsText(file, "UTF-8");
  };

  // ── Effects
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mockMessages]);
  useEffect(() => { if (mockStarted && !mockLoading) mockInputRef.current?.focus(); }, [mockStarted, mockLoading]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Derived
  const visibleSections = useMemo(() => RESEARCH_SECTIONS.filter(s =>
    (s.id !== "star_stories" || resume.trim()) &&
    (s.id !== "fit_gaps" || jd.trim())
  ), [resume, jd]);

  useEffect(() => {
    if (!visibleSections.some(s => s.id === activeTab)) {
      setActiveTab(visibleSections[0]?.id ?? "history");
    }
  }, [visibleSections, activeTab]);

  const dateStr = useMemo(() =>
    now.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "2-digit" }).toUpperCase(),
  [now]);
  const timeStr = useMemo(() =>
    now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }),
  [now]);

  const activeSectionMeta = useMemo(() => {
    const meta = visibleSections.find(s => s.id === activeTab);
    const idx = visibleSections.findIndex(s => s.id === activeTab);
    return { meta, idx };
  }, [visibleSections, activeTab]);

  const dossierBodyHtml = useMemo(
    () => parseMarkdown(researchData?.[activeTab] || "—"),
    [researchData, activeTab],
  );

  const fileNo = useMemo(() => {
    const slug = (company.trim() || "SUBJECT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "SUBJECT";
    const yr = now.getFullYear();
    return `${slug}-${yr}-Q${Math.floor((now.getMonth()) / 3) + 1}`;
  }, [company, now]);

  // ── Voice answers
  // Two free paths, picked by capability: browsers with the Web Speech API
  // (Chrome/Edge/Safari) dictate live into the input with no server round-trip;
  // others (Firefox) record via MediaRecorder and transcribe through
  // /api/transcribe (Whisper on Groq).
  const SpeechRec = typeof window !== "undefined"
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;

  const stopVoiceAnswer = () => {
    recognitionRef.current?.stop();
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    clearTimeout(recTimeoutRef.current);
  };

  const startVoiceAnswer = async () => {
    if (recState !== "idle" || mockLoading) return;
    window.speechSynthesis?.cancel(); // don't let the mic pick up the interviewer
    setError("");

    if (SpeechRec) {
      const rec = new SpeechRec();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      const base = mockInput.trim() ? mockInput.trim() + " " : "";
      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t + " ";
          else interim += t;
        }
        setMockInput((base + finalText + interim).trimStart());
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed")
          setError("Microphone access was blocked — allow it in your browser settings.");
      };
      rec.onend = () => {
        setRecState("idle");
        clearTimeout(recTimeoutRef.current);
      };
      recognitionRef.current = rec;
      rec.start();
      setRecState("recording");
      recTimeoutRef.current = setTimeout(() => rec.stop(), MAX_RECORDING_MS);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked — allow it and try again.");
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find(m => window.MediaRecorder?.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearTimeout(recTimeoutRef.current);
      const blob = new Blob(chunks, { type: (recorder.mimeType || "audio/webm").split(";")[0] });
      if (blob.size === 0) { setRecState("idle"); return; }
      if (blob.size > MAX_AUDIO_BYTES) {
        setError("Recording too large — keep answers under ~3 minutes.");
        setRecState("idle");
        return;
      }
      setRecState("transcribing");
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64, mimeType: blob.type }),
          signal: AbortSignal.timeout(60_000),
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || "Transcription failed.");
        setMockInput(prev => (prev.trim() ? prev.trim() + " " : "") + data.text);
      } catch (err) {
        setError(err.message || "Transcription failed — type your answer instead.");
      } finally {
        setRecState("idle");
      }
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecState("recording");
    recTimeoutRef.current = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, MAX_RECORDING_MS);
  };

  // Interviewer speaks new questions aloud when voice is on.
  useEffect(() => {
    if (!voiceOn || !mockStarted || mockComplete) return;
    const last = mockMessages[mockMessages.length - 1];
    if (!last || last.role !== "interviewer") return;
    const utterance = new SpeechSynthesisUtterance(last.text);
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [mockMessages, voiceOn, mockStarted, mockComplete]);

  useEffect(() => () => {
    window.speechSynthesis?.cancel();
    clearTimeout(recTimeoutRef.current);
  }, []);

  // ── Research
  const fetchResearch = async () => {
    // Guard re-entry: Enter in the inputs calls this directly, bypassing the
    // disabled button, so a second keypress mid-flight would double-fire.
    if (!company.trim() || researchLoading) return;
    setResearchLoading(true);
    setError("");
    setResearchData(null);
    setSearched(true);
    setActiveTab("history");

    const resumeContext = resume.trim()
      ? `\n\nThe candidate's resume:\n${resume.trim()}\n\nUse this resume to generate personalized STAR stories in the star_stories field.`
      : "";

    const roleLine = role.trim() ? ` The candidate is targeting: ${role.trim()}. Reflect this in business fit, playbook, and STAR mapping.` : "";

    const jdContext = jd.trim()
      ? `\n\nThe job posting the candidate is targeting:\n${jd.trim()}\n\nTailor the business fit, interview playbook, and likely question themes to this posting, and produce the fit_gaps field as described.`
      : "";

    const prompt = `You are an expert career coach and company research analyst. Research "${company.trim()}" using timely public information.${roleLine}${resumeContext}${jdContext}

Writing rules for ALL markdown fields: prefer concrete facts; where inference or rumor appears, label it briefly (e.g. "reported", "unclear"); keep sentences tight for screen reading; use ## subheads inside longer sections when helpful.

Respond ONLY in valid JSON (no markdown fences). Keys:
{
  "company_name": "Official legal or brand name",
  "tagline": "One plain sentence: what they do and for whom",
  "founded": "Year or N/A",
  "headquarters": "City, region/country",
  "industry": "Primary industry or sector label",
  "history": "Markdown: 3-4 short paragraphs. Chronological spine: founding → pivots → scale milestones (funding rounds, IPO, M&A) only if verified from public sources; current scale snapshot last.",
  "business": "Markdown: ## Offerings & customers — flagship products/services and main customer segments. ## Model & moat — revenue motion (e.g. enterprise SaaS, ads, hardware) and differentiators vs alternatives. ## Competitive set — 2-4 named peers or substitutes and how this company positions.${role.trim() ? ` ## Fit for ${role.trim()} — one short paragraph: typical teams, stack themes if known, how someone in this role would add value (grounded in public job posts or engineering blogs when possible; otherwise cautious generalization).` : ""}",
  "culture": "Markdown: 3-4 paragraphs. Official values/norms (name them), collaboration pace and decision style, remote/hybrid norms if known, notable perks or rituals. Separate **Verified** (careers site, filings, press) from **Themes from coverage** (Glassdoor/Blind-style sentiment — do not present as fact).",
  "news": "Markdown: 5-7 bullets with '- ', newest first, covering roughly the last 45 days (extend to 60 only if the company is quiet). Each bullet: headline-style phrase, **date** (month day, year or quarter), one clause of why it matters. If nothing recent, say so honestly and give the latest 2 relevant items with dates.",
  "interview_tips": "Markdown playbook titled implicitly for candidates.${role.trim() ? ` Prioritize ${role.trim()} where relevant.` : ""} Structure exactly with these ## headings in order: ## Hiring process — rounds, timeline hints, virtual vs onsite, homework/take-homes if publicly discussed. ## What they evaluate — signals and competencies repeatedly mentioned for this company. ## Likely question themes — 6-8 bullets (${role.trim() ? `skew toward ${role.trim()}` : "behavioral + role-agnostic"}). ## Questions you should ask them — 4-5 sharp questions referencing their strategy/news. ## Logistics & prep — 4-6 bullets (research tasks, stories to rehearse, red flags to watch).",
  "star_stories": "${resume.trim()
        ? "Markdown: 4-5 STAR stories from the resume only (Situation, Task, Action, Result). Each: **Title**, **Maps to** (company value or interview theme), then STAR paragraphs. Quantify impact where the resume allows; never invent employers or metrics."
        : "Markdown: Two short paragraphs explaining that STAR stories appear when the candidate pastes a resume or uploads a resume file, then re-runs Research company."}",
  "fit_gaps": "${jd.trim()
        ? `Markdown: ## What they're really hiring for — decode the posting's top priorities in plain language. ${resume.trim()
            ? "## Where you match — map specific resume evidence to each major requirement. ## Gaps & how to address them — honest gaps plus one mitigation talking point each; never invent experience."
            : "## What a strong candidate shows — the evidence interviewers will look for against each requirement (no resume provided, so stay general)."} ## Tailored talking points — 4-5 bullets the candidate should work into answers, tied to the posting's own language.`
        : "Markdown: Two short sentences explaining that this tab fills in when the candidate pastes the job posting and re-runs Research company."}"
}`;

    try {
      const parsed = await callGeminiJSON(prompt, { temperature: 0.7, useSearch: true });
      setResearchData(parsed);
    } catch (err) {
      console.error(err);
      setError(err instanceof SyntaxError ? "Failed to parse response. Try again." : err.message);
    } finally {
      setResearchLoading(false);
    }
  };

  // ── Mock Interview
  const startMockInterview = async () => {
    // Guard re-entry: Enter in the inputs calls this directly — without this,
    // a keypress mid-interview silently restarts and wipes the transcript.
    if (mockStarted || mockLoading) return;
    if (!company.trim()) {
      setError("Enter a company name first.");
      return;
    }
    setMockStarted(true);
    setMockMessages([]);
    setMockQuestionCount(0);
    setMockComplete(false);
    setMockScorecard(null);
    setMockLoading(true);
    setError("");

    const prompt = `You are an interviewer at ${company.trim()}${role.trim() ? ` for the ${role.trim()} role` : ""}. Difficulty: ${mockDifficulty}.
${resume.trim() ? `Candidate resume:\n${resume.trim()}\n` : ""}${jd.trim() ? `The job posting:\n${jd.trim()}\nGround your questions in this posting's requirements and language.\n` : ""}

Start the mock interview. Greet the candidate briefly, then ask your FIRST interview question. 
- For "easy": behavioral/intro questions
- For "medium": mix of technical and situational
- For "hard": pressure questions, curveballs, deep dives

Keep it natural and conversational. Ask ONE question at a time. Do NOT provide feedback yet.
Respond ONLY with your interviewer dialogue (no JSON, no labels).`;

    try {
      const response = await callGemini(prompt, { temperature: 0.8 });
      setMockMessages([{ role: "interviewer", text: response }]);
      setMockQuestionCount(1);
    } catch (err) {
      console.error(err);
      setError(err.message);
      setMockStarted(false);
    } finally {
      setMockLoading(false);
    }
  };

  // Callable from the normal flow AND from the retry button, so a failed
  // scoring run is never a dead end (and retrying adds no junk to the transcript).
  const generateScorecard = async (transcriptMessages) => {
    setMockLoading(true);
    setScoreFailed(false);
    setError("");

    const scorecardPrompt = `You conducted a mock interview for ${company.trim()}${role.trim() ? ` (${role.trim()})` : ""}. Difficulty: ${mockDifficulty}.

Here is the full interview transcript:
${transcriptMessages.map(m => `${m.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${m.text}`).join("\n\n")}

Provide a final evaluation. Scores are numbers from 1-10. "summary" is a 2-3 sentence overall assessment. "strengths" and "improvements" each have 3 items. "per_question" covers each question with a brief summary, score, and specific feedback. "final_tip" is one powerful closing piece of advice.`;

    try {
      const scorecard = await callGeminiJSON(scorecardPrompt, {
        temperature: 0.5,
        responseSchema: SCORECARD_SCHEMA,
      });
      setMockScorecard(scorecard);
      setMockComplete(true);
    } catch (err) {
      console.error(err);
      setError("Failed to generate scorecard. " + err.message);
      setScoreFailed(true);
    } finally {
      setMockLoading(false);
    }
  };

  const sendMockAnswer = async () => {
    if (!mockInput.trim() || mockLoading) return;
    stopVoiceAnswer();
    const userAnswer = mockInput.trim();
    setMockInput("");

    const updatedMessages = [...mockMessages, { role: "candidate", text: userAnswer }];
    setMockMessages(updatedMessages);
    setMockLoading(true);

    const newCount = mockQuestionCount + 1;

    if (newCount > 5) {
      await generateScorecard(updatedMessages);
      return;
    }

    const conversationHistory = updatedMessages
      .map(m => `${m.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${m.text}`)
      .join("\n\n");

    const nextPrompt = `You are an interviewer at ${company.trim()}${role.trim() ? ` for ${role.trim()}` : ""}. Difficulty: ${mockDifficulty}.
${resume.trim() ? `Candidate resume:\n${resume.trim()}\n` : ""}${jd.trim() ? `The job posting:\n${jd.trim()}\n` : ""}

Interview so far:
${conversationHistory}

Give brief, encouraging feedback on their last answer (1-2 sentences), then ask the NEXT interview question. This is question ${newCount} of 5.
${newCount === 5 ? "This is the FINAL question — make it count." : ""}
Keep it natural. Respond only with your interviewer dialogue.`;

    try {
      const response = await callGemini(nextPrompt, { temperature: 0.8 });
      setMockMessages(prev => [...prev, { role: "interviewer", text: response }]);
      setMockQuestionCount(newCount);
    } catch (err) {
      console.error(err);
      setError(err.message);
      setMockStarted(false);
      setMockMessages([]);
      setMockQuestionCount(0);
      setMockComplete(false);
      setMockScorecard(null);
    } finally {
      setMockLoading(false);
    }
  };

  const resetMock = () => {
    stopVoiceAnswer();
    window.speechSynthesis?.cancel();
    setMockStarted(false);
    setMockMessages([]);
    setMockInput("");
    setMockLoading(false);
    setMockQuestionCount(0);
    setMockComplete(false);
    setMockScorecard(null);
    setScoreFailed(false);
    setError("");
  };

  // ─────────── Render ───────────

  return (
    <div style={S.shell}>
      {/* Vertical edge ribbon — confidential running text on the left margin (desktop only) */}
      <aside data-edge-ribbon style={S.edgeRibbon} aria-hidden>
        <div style={S.edgeRibbonText}>
          PRIVATE · FOR YOU ONLY · PRIVATE · FOR YOU ONLY · PRIVATE · FOR YOU ONLY ·
        </div>
      </aside>

      {/* ─── Top masthead bar ─── */}
      <div style={S.topBar}>
        <div data-top-bar-inner style={S.topBarInner}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={S.monogram} aria-hidden>P</div>
            <SmallLabel color="var(--ink)">PrepAI//Pro</SmallLabel>
          </div>
          <div data-top-bar-mid style={S.topBarMid}>
            <SmallLabel>{dateStr}</SmallLabel>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: "var(--vermillion)",
              animation: "blink 1.4s steps(1) infinite",
              display: "inline-block",
            }} />
            <SmallLabel color="var(--ink)">Live · {timeStr} UTC</SmallLabel>
          </div>
        </div>
        <Hairline thick />
      </div>

      <main data-container style={S.container}>

        {/* ═══════════ HERO MASTHEAD ═══════════ */}
        <header style={S.hero}>
          <div data-hero-grid style={S.heroGrid}>
            <div style={S.heroLeft}>
              <SmallLabel>An AI prep tool for</SmallLabel>
              <h1 style={S.heroTitle}>
                <GlyphTitle text="Interviews" baseDelay={0.05} />
                <br />
                <GlyphTitle text="that go" baseDelay={0.28} style={{ fontStyle: "italic", fontVariationSettings: '"opsz" 144, "wght" 500, "SOFT" 100' }} />
                <br />
                <GlyphTitle text="your way." baseDelay={0.52} />
              </h1>
              <div style={S.heroRule} />
              <ol style={S.heroSteps}>
                {FLOW_STEPS.map((st, i) => (
                  <li
                    key={st.k}
                    style={{
                      ...S.heroStep,
                      animationDelay: `${0.82 + i * 0.07}s`,
                    }}
                  >
                    <span style={S.heroStepKey}>{st.k}</span>
                    <span style={S.heroStepText}>
                      <strong style={S.heroStepTitle}>{st.title}.</strong> {st.body}
                    </span>
                  </li>
                ))}
              </ol>
              <p style={S.heroDek}>
                <strong>Company Brief</strong> is research you can read before the interview.
                {" "}
                <strong>Mock Interview</strong> is timed practice with scores. Free, no signup — your inputs stay in this browser.
              </p>
            </div>
            <div style={S.heroRight}>
              <div style={S.metaBox}>
                <SmallLabel color="var(--vermillion)">Brief #{fileNo}</SmallLabel>
                <Hairline color="var(--vermillion-2)" delay={0.4} />
                <LeaderRow label="AI" value="Gemini 2.5 Flash" />
                <LeaderRow label="Privacy" value="Runs locally" valueColor="var(--forest)" />
              </div>
              <div style={S.priceTag}>
                <span style={S.priceTagSmall}>Cost</span>
                <span style={S.priceTagPrice}>FREE</span>
                <span style={S.priceTagSmall}>forever · no signup</span>
              </div>
            </div>
          </div>
        </header>

        <Hairline thick />

        {/* ═══════════ MODE TILES ═══════════ */}
        <section style={S.tocSection} aria-label="Choose preparation mode">
          <div style={S.tocHead}>
            <div>
              <SmallLabel>Step 1</SmallLabel>
              <p style={S.sectionLead}>Pick how you want to prep (you can switch later).</p>
            </div>
            <SmallLabel color="var(--ink-4)">2 modes</SmallLabel>
          </div>
          <div data-mode-grid style={S.modeGrid}>
            {MODES.map((m, idx) => {
              const active = activeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setActiveMode(m.id)}
                  className="hover-stamp"
                  style={{
                    ...S.modeTile,
                    background: active ? "var(--ink)" : "color-mix(in srgb, var(--paper-2) 72%, transparent)",
                    color: active ? "var(--paper)" : "var(--ink)",
                    borderColor: active ? "var(--ink)" : "color-mix(in srgb, var(--ink) 22%, transparent)",
                    boxShadow: active
                      ? "none"
                      : "inset 0 1px 0 color-mix(in srgb, var(--ink) 8%, transparent)",
                    animationDelay: `${0.3 + idx * 0.08}s`,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.2em",
                      fontWeight: 700, color: active ? "var(--paper-3)" : "var(--ink-3)",
                    }}>
                      {m.num}
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      {m.suggest && (
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.14em",
                          fontWeight: 700, color: "var(--vermillion)",
                          padding: "2px 6px",
                          border: "1px solid color-mix(in srgb, var(--vermillion) 50%, transparent)",
                          textTransform: "uppercase",
                        }}>
                          Suggested first
                        </span>
                      )}
                      <span style={{
                        fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.2em",
                        fontWeight: 600, color: active ? "var(--vermillion)" : "var(--ink-3)",
                        padding: "3px 7px",
                        border: `1px solid ${active ? "var(--vermillion)" : "color-mix(in srgb, var(--ink) 25%, transparent)"}`,
                      }}>
                        {active ? "Selected" : "Choose"}
                      </span>
                    </span>
                  </div>
                  <div style={{
                    fontFamily: "var(--serif)",
                    fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 100',
                    fontSize: 34,
                    letterSpacing: "-0.025em",
                    lineHeight: 1.05,
                    marginTop: 12,
                  }}>
                    {m.label}
                  </div>
                  <p style={{
                    fontFamily: "var(--sans)",
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    color: active ? "color-mix(in srgb, var(--paper) 85%, transparent)" : "var(--ink-3)",
                    marginTop: 6,
                    lineHeight: 1.35,
                  }}>
                    {m.tagline}
                  </p>
                  <p style={{
                    fontFamily: "var(--serif)",
                    fontVariationSettings: '"opsz" 12, "wght" 400, "SOFT" 50',
                    fontSize: 14,
                    lineHeight: 1.55,
                    color: active ? "var(--paper-2)" : "var(--ink-2)",
                    marginTop: 10,
                  }}>
                    {m.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        <Hairline />

        {/* ═══════════ BRIEFING REQUEST FORM ═══════════ */}
        <section style={S.formSection}>
          <div style={S.formHead}>
            <div>
              <SmallLabel>Step 2</SmallLabel>
              <p style={S.sectionLead}>
                {activeMode === "research"
                  ? "Tell us who you are interviewing with — then press Research company."
                  : "Same fields — then press Start Mock Interview."}
              </p>
            </div>
            <SmallLabel color="var(--ink-4)">~30 sec</SmallLabel>
          </div>

          <div data-form-grid style={S.formGrid}>
            <div data-form-field style={S.field}>
              <label htmlFor="company-input" style={S.fieldLabel}>
                <span style={S.fieldNum}>01</span>
                Company
                <span style={S.fieldRequired}>· required</span>
              </label>
              <input
                id="company-input"
                ref={inputRef}
                type="text"
                autoComplete="organization"
                placeholder="e.g. Stripe, Apple, Netflix…"
                value={company}
                onChange={e => setCompany(e.target.value)}
                onKeyDown={e => e.key === "Enter" && (activeMode === "research" ? fetchResearch() : startMockInterview())}
                style={S.input}
              />
            </div>
            <div data-form-field style={S.field}>
              <label htmlFor="role-input" style={S.fieldLabel}>
                <span style={S.fieldNum}>02</span>
                Role
                <span style={S.fieldRequired}>· optional</span>
              </label>
              <input
                id="role-input"
                type="text"
                autoComplete="organization-title"
                placeholder="e.g. Data Engineer, PM, SWE…"
                value={role}
                onChange={e => setRole(e.target.value)}
                onKeyDown={e => e.key === "Enter" && (activeMode === "research" ? fetchResearch() : startMockInterview())}
                style={S.input}
              />
            </div>
          </div>

          {/* Resume toggle */}
          <div style={{ marginTop: 4 }}>
            <button
              onClick={() => setShowResume(!showResume)}
              aria-expanded={showResume}
              style={S.credentialsToggle}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: 14, marginRight: 4, lineHeight: 1 }}>
                {showResume ? "▾" : "▸"}
              </span>
              <span>03 · Add your resume</span>
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)",
                fontWeight: 400, letterSpacing: "0.12em", marginLeft: 8,
                textTransform: "none",
              }}>
                — paste or upload .txt / .md / .pdf
              </span>
              <span style={{
                flex: 1, marginLeft: 10, marginRight: 10,
                borderBottom: "1px dotted color-mix(in srgb, var(--ink) 40%, transparent)",
                transform: "translateY(-3px)",
              }} />
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10,
                color: resume.trim() ? "var(--forest)" : "var(--ink-4)",
                fontWeight: 700, letterSpacing: "0.18em",
              }}>
                {resume.trim() ? "● ADDED" : "○ OPTIONAL"}
              </span>
            </button>
            {showResume && (
              <div style={{ marginTop: 12, animation: "fadeUp 0.3s ease both" }}>
                <input
                  ref={resumeFileRef}
                  type="file"
                  accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                  style={{ display: "none" }}
                  aria-label="Upload resume file"
                  onChange={(e) => {
                    ingestResumeFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <textarea
                  placeholder="Paste plain-text resume here, or tap Upload — text only leaves your browser when you call Gemini."
                  value={resume}
                  onChange={e => setResume(e.target.value.slice(0, MAX_RESUME_CHARS))}
                  rows={6}
                  style={S.textarea}
                />
                <div style={S.resumeToolbar}>
                  <button
                    type="button"
                    onClick={() => resumeFileRef.current?.click()}
                    className="hover-stamp"
                    style={S.resumeFileBtn}
                  >
                    Upload .txt / .md / .pdf
                  </button>
                  <span style={S.resumeToolbarHint}>
                    Max {MAX_RESUME_FILE_BYTES / 1024} KB text · {MAX_PDF_FILE_BYTES / (1024 * 1024)} MB PDF
                  </span>
                  <span style={S.resumeToolbarMeta}>
                    {resume.length.toLocaleString()} / {MAX_RESUME_CHARS.toLocaleString()} chars
                  </span>
                </div>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10,
                  color: "var(--ink-4)", marginTop: 8, letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}>
                  Stays in memory until you refresh · sent only inside your Gemini prompt when you run a tool
                </div>
              </div>
            )}
          </div>

          {/* Job posting toggle */}
          <div style={{ marginTop: 4 }}>
            <button
              onClick={() => setShowJd(!showJd)}
              aria-expanded={showJd}
              style={S.credentialsToggle}
            >
              <span style={{ fontFamily: "var(--mono)", fontSize: 14, marginRight: 4, lineHeight: 1 }}>
                {showJd ? "▾" : "▸"}
              </span>
              <span>04 · Add the job posting</span>
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)",
                fontWeight: 400, letterSpacing: "0.12em", marginLeft: 8,
                textTransform: "none",
              }}>
                — unlocks fit & gap analysis
              </span>
              <span style={{
                flex: 1, marginLeft: 10, marginRight: 10,
                borderBottom: "1px dotted color-mix(in srgb, var(--ink) 40%, transparent)",
                transform: "translateY(-3px)",
              }} />
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10,
                color: jd.trim() ? "var(--forest)" : "var(--ink-4)",
                fontWeight: 700, letterSpacing: "0.18em",
              }}>
                {jd.trim() ? "● ADDED" : "○ OPTIONAL"}
              </span>
            </button>
            {showJd && (
              <div style={{ marginTop: 12, animation: "fadeUp 0.3s ease both" }}>
                <textarea
                  placeholder="Paste the job posting here — the brief gains a Fit & gaps tab, and mock questions use the posting's own requirements."
                  value={jd}
                  onChange={e => setJd(e.target.value.slice(0, MAX_JD_CHARS))}
                  rows={6}
                  style={S.textarea}
                />
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10,
                  color: "var(--ink-4)", marginTop: 8, letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
                }}>
                  <span>Stays in memory until you refresh · sent only inside your Gemini prompt</span>
                  <span>{jd.length.toLocaleString()} / {MAX_JD_CHARS.toLocaleString()} chars</span>
                </div>
              </div>
            )}
          </div>

          {/* Difficulty (mock only) */}
          {activeMode === "mock" && (
            <div style={{ marginTop: 22, animation: "fadeUp 0.3s ease" }}>
              <SmallLabel>05 · Difficulty</SmallLabel>
              <div data-difficulty-row style={S.difficultyRow}>
                {DIFFICULTY_LEVELS.map(d => {
                  const sel = mockDifficulty === d.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => setMockDifficulty(d.id)}
                      aria-pressed={sel}
                      className="hover-stamp"
                      style={{
                        ...S.diffTile,
                        background: sel ? "var(--ink)" : "transparent",
                        color: sel ? "var(--paper)" : "var(--ink)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 18, color: sel ? "var(--vermillion)" : "var(--ink-2)" }}>{d.glyph}</span>
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.2em",
                          color: sel ? "var(--paper-3)" : "var(--ink-4)",
                        }}>
                          {sel ? "SELECTED" : ""}
                        </span>
                      </div>
                      <div style={{
                        fontFamily: "var(--serif)",
                        fontVariationSettings: '"opsz" 36, "wght" 600, "SOFT" 80',
                        fontSize: 22, marginTop: 8, lineHeight: 1,
                        letterSpacing: "-0.015em",
                      }}>
                        {d.label}
                      </div>
                      <div style={{
                        fontFamily: "var(--mono)", fontSize: 10, marginTop: 6,
                        color: sel ? "var(--paper-3)" : "var(--ink-3)",
                        textTransform: "uppercase", letterSpacing: "0.15em",
                      }}>
                        {d.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Action button ── */}
          <div style={{ marginTop: 24, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {activeMode === "research" ? (
              <button
                onClick={fetchResearch}
                disabled={researchLoading || !company.trim()}
                className="btn-press"
                style={{
                  ...S.actionBtn,
                  opacity: (researchLoading || !company.trim()) ? 0.45 : 1,
                  pointerEvents: (researchLoading || !company.trim()) ? "none" : "auto",
                }}
              >
                <span>{researchLoading ? "Working…" : "Research company"}</span>
                <span style={S.actionBtnArrow}>{researchLoading ? "◴" : "→"}</span>
              </button>
            ) : (
              <button
                onClick={mockStarted ? resetMock : startMockInterview}
                disabled={mockLoading || !company.trim()}
                className="btn-press"
                style={{
                  ...S.actionBtn,
                  opacity: (mockLoading || !company.trim()) ? 0.45 : 1,
                  pointerEvents: (mockLoading || !company.trim()) ? "none" : "auto",
                }}
              >
                <span>{mockStarted ? "Restart" : "Start Mock Interview"}</span>
                <span style={S.actionBtnArrow}>{mockLoading ? "◴" : mockStarted ? "↻" : "→"}</span>
              </button>
            )}
            {company.trim() && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.18em",
                color: "var(--ink-4)", textTransform: "uppercase",
              }}>
                Ready for <span style={{ color: "var(--vermillion)", fontWeight: 700 }}>{company.trim()}</span>
                {role.trim() && <> · <span style={{ color: "var(--ink-2)", fontWeight: 700 }}>{role.trim()}</span></>}
              </span>
            )}
          </div>
        </section>

        {/* Error notice */}
        {error && (
          <div role="alert" style={S.errorNotice}>
            <SmallLabel color="var(--vermillion)">⚠ Something went wrong</SmallLabel>
            <p style={{ fontFamily: "var(--serif)", fontSize: 15, color: "var(--ink)", marginTop: 4, fontStyle: "italic" }}>
              {error}
            </p>
          </div>
        )}

        <Hairline />

        {/* ═══════════ RESEARCH MODE ═══════════ */}
        {activeMode === "research" && (
          <section style={{ paddingTop: 28 }}>
            {researchLoading && <LoadingPanel subject={company} kind="dossier" hasResume={!!resume.trim()} hasJd={!!jd.trim()} />}

            {researchData && !researchLoading && (
              <article style={{ animation: "fadeUp 0.6s cubic-bezier(.2,.7,.2,1) both" }}>
                {/* File header */}
                <div style={S.fileHead}>
                  <div style={S.fileHeadLeft}>
                    <SmallLabel color="var(--vermillion)">Brief #{fileNo}</SmallLabel>
                    <SmallLabel>· Generated {dateStr}</SmallLabel>
                  </div>
                  <Stamp rotate={4} size={56} style={{ position: "relative", zIndex: 2 }}>
                    Live<br />Brief
                  </Stamp>
                </div>

                <Hairline thick />

                {/* Subject card */}
                <div style={S.subjectCard}>
                  <SmallLabel color="var(--ink-3)">Company</SmallLabel>
                  <h2 style={S.subjectName}>
                    {researchData.company_name}
                  </h2>
                  <p style={S.subjectTagline}>{researchData.tagline}</p>
                  <div style={S.subjectMeta}>
                    {researchData.founded && researchData.founded !== "N/A" && (
                      <LeaderRow label="Founded" value={researchData.founded} />
                    )}
                    {researchData.headquarters && (
                      <LeaderRow label="HQ" value={researchData.headquarters} />
                    )}
                    {researchData.industry && (
                      <LeaderRow label="Industry" value={researchData.industry} />
                    )}
                    {role.trim() && (
                      <LeaderRow label="For role" value={role.trim()} valueColor="var(--vermillion)" />
                    )}
                  </div>
                </div>

                {/* Section nav */}
                <div style={S.sectionNav}>
                  {visibleSections.map(s => {
                    const isActive = activeTab === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setActiveTab(s.id)}
                        aria-current={isActive || undefined}
                        className="tab-rule hover-stamp"
                        data-active={isActive}
                        style={{
                          ...S.sectionTab,
                          background: isActive ? "var(--paper-3)" : "transparent",
                          color: isActive ? "var(--ink)" : "var(--ink-3)",
                        }}
                      >
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700,
                          letterSpacing: "0.18em",
                          color: isActive ? "var(--vermillion)" : "var(--ink-4)",
                          minWidth: 16,
                        }}>
                          {s.num}
                        </span>
                        <span style={{
                          fontFamily: "var(--serif)",
                          fontVariationSettings: '"opsz" 24, "wght" 500, "SOFT" 60',
                          fontSize: 16,
                          letterSpacing: "-0.005em",
                        }}>
                          {s.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Body content */}
                <div style={S.bodyCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
                    <SmallLabel color="var(--vermillion)">
                      § {activeSectionMeta.meta?.num} · {activeSectionMeta.meta?.label}
                    </SmallLabel>
                    <SmallLabel color="var(--ink-4)">
                      {activeSectionMeta.idx >= 0 ? activeSectionMeta.idx + 1 : 0} of {visibleSections.length}
                    </SmallLabel>
                  </div>
                  <Hairline />
                  <div
                    key={activeTab}
                    className="dossier-body"
                    style={{ animation: "fadeUp 0.4s cubic-bezier(.2,.7,.2,1)", marginTop: 18 }}
                    dangerouslySetInnerHTML={{ __html: dossierBodyHtml }}
                  />
                </div>
              </article>
            )}

            {!searched && !researchLoading && (
              <EmptyState
                kind="dossier"
                onPick={(name) => setCompany(name)}
              />
            )}
          </section>
        )}

        {/* ═══════════ MOCK INTERVIEW ═══════════ */}
        {activeMode === "mock" && (
          <section style={{ paddingTop: 28 }}>
            {!mockStarted && !mockComplete && (
              <EmptyState kind="simulation" hasResume={!!resume.trim()} />
            )}

            {mockStarted && (
              <article style={{ animation: "fadeUp 0.5s cubic-bezier(.2,.7,.2,1)" }}>
                <div style={S.transcriptHead}>
                  <div style={S.transcriptHeadLeft}>
                    <SmallLabel color="var(--vermillion)">Mock Interview · in progress</SmallLabel>
                    <h3 style={S.transcriptTitle}>
                      Practicing with <span style={{ fontStyle: "italic" }}>{company}</span>
                      {role.trim() && <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}> · {role.trim()}</span>}
                    </h3>
                  </div>
                  <div style={S.transcriptHeadRight}>
                    <LeaderRow label="Difficulty" value={DIFFICULTY_LEVELS.find(d => d.id === mockDifficulty)?.label || mockDifficulty} />
                    <LeaderRow
                      label="Question"
                      value={`${Math.min(mockQuestionCount, 5)} of 5`}
                      valueColor="var(--vermillion)"
                    />
                    <div style={S.progressTrack}>
                      <div style={{
                        ...S.progressFill,
                        width: `${(Math.min(mockQuestionCount, 5) / 5) * 100}%`,
                      }} />
                    </div>
                    <button
                      onClick={() => {
                        if (voiceOn) window.speechSynthesis?.cancel();
                        setVoiceOn(v => !v);
                      }}
                      className="hover-stamp"
                      aria-pressed={voiceOn}
                      title="Read the interviewer's questions aloud"
                      style={{
                        ...S.voiceToggle,
                        color: voiceOn ? "var(--vermillion)" : "var(--ink-3)",
                        borderColor: voiceOn ? "color-mix(in srgb, var(--vermillion) 55%, transparent)" : "color-mix(in srgb, var(--ink) 22%, transparent)",
                      }}
                    >
                      {voiceOn ? "◉ Interviewer voice · on" : "○ Interviewer voice · off"}
                    </button>
                  </div>
                </div>

                <Hairline />

                <div style={S.transcript} aria-live="polite">
                  {mockMessages.length === 0 && mockLoading && (
                    <LoadingPanel kind="mock-init" subject={company} hasResume={!!resume.trim()} />
                  )}
                  {(mockMessages.length > 0 || !mockLoading) && (
                    <>
                      {mockMessages.map((msg, i) => {
                        const isInt = msg.role === "interviewer";
                        return (
                          <div
                            key={i}
                            data-transcript-turn
                            style={{
                              ...S.transcriptTurn,
                              gridTemplateColumns: isInt ? "100px 1fr" : "1fr 100px",
                              animation: `${isInt ? "slideLeft" : "slideRight"} 0.35s cubic-bezier(.2,.7,.2,1) ${i * 0.03}s both`,
                            }}
                          >
                            {isInt && (
                              <div data-transcript-speaker style={S.transcriptSpeaker}>
                                <SmallLabel color="var(--vermillion)">Interviewer</SmallLabel>
                                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-4)", marginTop: 2, letterSpacing: "0.16em" }}>
                                  Q{Math.floor(i / 2) + 1}
                                </div>
                              </div>
                            )}
                            <div style={{
                              ...S.transcriptBody,
                              borderLeft: isInt ? `2px solid var(--vermillion)` : "none",
                              borderRight: !isInt ? `2px solid var(--ink)` : "none",
                              paddingLeft: isInt ? 18 : 0,
                              paddingRight: !isInt ? 18 : 0,
                              textAlign: isInt ? "left" : "right",
                              color: isInt ? "var(--ink)" : "var(--ink-2)",
                              fontStyle: isInt ? "normal" : "italic",
                            }}>
                              {msg.text}
                            </div>
                            {!isInt && (
                              <div data-transcript-speaker data-side="right" style={{ ...S.transcriptSpeaker, textAlign: "right" }}>
                                <SmallLabel color="var(--ink)">You</SmallLabel>
                                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-4)", marginTop: 2, letterSpacing: "0.16em" }}>
                                  Answer
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {mockLoading && mockQuestionCount <= 5 && mockMessages.length > 0 && (
                        <div data-transcript-turn style={{ ...S.transcriptTurn, gridTemplateColumns: "100px 1fr" }}>
                          <div style={S.transcriptSpeaker}>
                            <SmallLabel color="var(--vermillion)">Interviewer</SmallLabel>
                          </div>
                          <div style={{ ...S.transcriptBody, borderLeft: `2px solid var(--vermillion)`, paddingLeft: 18, display: "flex", alignItems: "center", gap: 8 }}>
                            <SmallLabel color="var(--ink-3)">Thinking</SmallLabel>
                            {[0, 1, 2].map(i => (
                              <span key={i} style={{
                                width: 5, height: 5, borderRadius: "50%",
                                background: "var(--vermillion)",
                                display: "inline-block",
                                animation: `morse 1.1s ease ${i * 0.18}s infinite`,
                              }} />
                            ))}
                          </div>
                        </div>
                      )}

                      {mockLoading && mockQuestionCount > 5 && !mockComplete && (
                        <div style={{ marginTop: 8 }}>
                          <LoadingPanel subject={company} kind="report" />
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </>
                  )}
                </div>

                {!mockComplete && scoreFailed && !mockLoading && (
                  <>
                    <Hairline />
                    <div style={{ textAlign: "center", marginTop: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                      <SmallLabel color="var(--ink-3)">Your answers are safe — scoring just failed.</SmallLabel>
                      <button onClick={() => generateScorecard(mockMessages)} className="btn-press" style={S.actionBtn}>
                        <span>Retry scoring</span>
                        <span style={S.actionBtnArrow}>↻</span>
                      </button>
                    </div>
                  </>
                )}

                {!mockComplete && !scoreFailed && (
                  <>
                    <Hairline />
                    <div style={S.replyRow}>
                      <span style={{
                        fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.2em",
                        color: "var(--vermillion)", textTransform: "uppercase",
                        marginRight: 12, fontWeight: 700,
                      }}>
                        You ▸
                      </span>
                      <input
                        ref={mockInputRef}
                        type="text"
                        placeholder={
                          recState === "recording" ? "Listening — speak your answer…"
                          : recState === "transcribing" ? "Transcribing your answer…"
                          : mockQuestionCount >= 5 ? "Last one — type or speak your answer…"
                          : "Type your answer and press Enter — or tap Rec to speak…"
                        }
                        value={mockInput}
                        onChange={e => setMockInput(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && sendMockAnswer()}
                        disabled={mockLoading}
                        style={S.replyInput}
                      />
                      <button
                        onClick={recState === "recording" ? stopVoiceAnswer : startVoiceAnswer}
                        disabled={mockLoading || recState === "transcribing"}
                        className="btn-press"
                        aria-pressed={recState === "recording"}
                        aria-label={
                          recState === "recording" ? "Stop recording"
                          : recState === "transcribing" ? "Transcribing"
                          : "Answer by voice"
                        }
                        title={recState === "recording" ? "Stop recording" : "Answer by voice"}
                        style={{
                          ...S.micBtn,
                          background: recState === "recording" ? "var(--vermillion)" : "transparent",
                          color: recState === "recording" ? "var(--paper)" : "var(--ink)",
                          borderColor: recState === "recording" ? "var(--vermillion)" : "color-mix(in srgb, var(--ink) 28%, transparent)",
                          opacity: (mockLoading || recState === "transcribing") ? 0.4 : 1,
                          animation: recState === "recording" ? "softPulse 1.4s ease infinite" : "none",
                        }}
                      >
                        {recState === "recording" ? "■ Stop" : recState === "transcribing" ? "◴ …" : "● Rec"}
                      </button>
                      <button
                        onClick={sendMockAnswer}
                        disabled={mockLoading || !mockInput.trim()}
                        className="btn-press"
                        style={{
                          ...S.replyBtn,
                          opacity: (mockLoading || !mockInput.trim()) ? 0.4 : 1,
                          pointerEvents: (mockLoading || !mockInput.trim()) ? "none" : "auto",
                        }}
                      >
                        Send →
                      </button>
                    </div>
                  </>
                )}
              </article>
            )}

            {/* ═════ Scorecard / Evaluation Report ═════ */}
            {mockComplete && mockScorecard && (
              <article style={{ animation: "fadeUp 0.6s cubic-bezier(.2,.7,.2,1) both", marginTop: 24 }}>
                <div style={S.fileHead}>
                  <div style={S.fileHeadLeft}>
                    <SmallLabel color="var(--vermillion)">Your Report · #{fileNo}</SmallLabel>
                    <SmallLabel>· Generated {dateStr}</SmallLabel>
                  </div>
                  <Stamp rotate={5} color="var(--forest)" size={56}>
                    All<br />Done
                  </Stamp>
                </div>

                <Hairline thick />

                <div style={S.subjectCard}>
                  <SmallLabel color="var(--ink-3)">Summary</SmallLabel>
                  <h2 style={S.subjectName}>
                    How you did
                  </h2>
                  <p style={{
                    fontFamily: "var(--serif)",
                    fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
                    fontSize: 17, fontStyle: "italic", lineHeight: 1.7,
                    color: "var(--ink-2)", marginTop: 14, maxWidth: 720,
                  }}>
                    {mockScorecard.summary}
                  </p>
                </div>

                {/* Overall score band */}
                <div style={S.scoreBand}>
                  <div style={{ flex: 1 }}>
                    <SmallLabel color="var(--vermillion)">§ Overall Score</SmallLabel>
                    <div style={{ marginTop: 14 }}>
                      <ScoreBar score={mockScorecard.overall_score} delay={0.2} />
                    </div>
                  </div>
                </div>

                <Hairline />

                {/* Strengths / Improvements */}
                <div data-swot-grid style={S.swotGrid}>
                  <div data-swot-col style={S.swotCol}>
                    <div style={S.swotHead}>
                      <SmallLabel color="var(--forest)">§ What you did well</SmallLabel>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", letterSpacing: "0.16em" }}>
                        +
                      </span>
                    </div>
                    <Hairline color="var(--forest)" />
                    <ol style={S.swotList}>
                      {mockScorecard.strengths?.map((s, i) => (
                        <li key={i} style={S.swotItem}>
                          <span style={{
                            fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                            color: "var(--forest)", letterSpacing: "0.18em", minWidth: 24,
                            display: "inline-block",
                          }}>
                            {String(i + 1).padStart(2, "0")}.
                          </span>
                          <span style={{
                            fontFamily: "var(--serif)",
                            fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
                            fontSize: 15, lineHeight: 1.65, color: "var(--ink)",
                          }}>
                            {s}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div data-swot-col style={S.swotCol}>
                    <div style={S.swotHead}>
                      <SmallLabel color="var(--vermillion)">§ What to improve</SmallLabel>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-4)", letterSpacing: "0.16em" }}>
                        ↗
                      </span>
                    </div>
                    <Hairline color="var(--vermillion)" />
                    <ol style={S.swotList}>
                      {mockScorecard.improvements?.map((s, i) => (
                        <li key={i} style={S.swotItem}>
                          <span style={{
                            fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                            color: "var(--vermillion)", letterSpacing: "0.18em", minWidth: 24,
                            display: "inline-block",
                          }}>
                            {String(i + 1).padStart(2, "0")}.
                          </span>
                          <span style={{
                            fontFamily: "var(--serif)",
                            fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
                            fontSize: 15, lineHeight: 1.65, color: "var(--ink)",
                          }}>
                            {s}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>

                <Hairline />

                {/* Per-question breakdown */}
                {mockScorecard.per_question?.length > 0 && (
                  <div style={S.perQ}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
                      <SmallLabel color="var(--ink)">§ Question-by-question</SmallLabel>
                      <SmallLabel color="var(--ink-4)">{mockScorecard.per_question.length} questions</SmallLabel>
                    </div>
                    <div style={S.perQList}>
                      {mockScorecard.per_question.map((q, i) => (
                        <div key={i} style={S.perQItem}>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                            <span style={{
                              fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                              color: "var(--vermillion)", letterSpacing: "0.18em",
                            }}>
                              Q{i + 1}
                            </span>
                            <span style={{
                              fontFamily: "var(--serif)",
                              fontVariationSettings: '"opsz" 24, "wght" 500, "SOFT" 60',
                              fontSize: 17, color: "var(--ink)",
                              letterSpacing: "-0.005em",
                            }}>
                              {q.question_summary}
                            </span>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <ScoreBar score={q.score} delay={0.1 + i * 0.06} />
                          </div>
                          <p style={{
                            fontFamily: "var(--serif)",
                            fontVariationSettings: '"opsz" 12, "wght" 400, "SOFT" 50',
                            fontSize: 14, fontStyle: "italic",
                            color: "var(--ink-2)", lineHeight: 1.6, marginTop: 10,
                            paddingLeft: 14, borderLeft: "2px solid color-mix(in srgb, var(--ink) 18%, transparent)",
                          }}>
                            {q.feedback}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Final tip */}
                {mockScorecard.final_tip && (
                  <div style={S.proTip}>
                    <Stamp rotate={-4} color="var(--vermillion)" size={48} style={{
                      position: "absolute", top: -18, right: 16,
                    }}>
                      Key · Tip
                    </Stamp>
                    <SmallLabel color="var(--vermillion)">§ One key takeaway</SmallLabel>
                    <p style={{
                      fontFamily: "var(--serif)",
                      fontVariationSettings: '"opsz" 36, "wght" 500, "SOFT" 80',
                      fontSize: 22, lineHeight: 1.45, color: "var(--ink)",
                      marginTop: 14, fontStyle: "italic",
                      letterSpacing: "-0.012em",
                    }}>
                      &ldquo;{mockScorecard.final_tip}&rdquo;
                    </p>
                  </div>
                )}

                <div style={{ textAlign: "center", marginTop: 28 }}>
                  <button onClick={resetMock} className="btn-press" style={S.actionBtn}>
                    <span>Try Again</span>
                    <span style={S.actionBtnArrow}>↻</span>
                  </button>
                </div>
              </article>
            )}
          </section>
        )}

        {/* ═══════════ FOOTER MASTHEAD ═══════════ */}
        <footer style={S.footer}>
          <Hairline thick />
          <div data-footer-grid style={S.footerInner}>
            <div style={S.footerLeft}>
              <div>
                <span style={{
                  fontFamily: "var(--serif)",
                  fontVariationSettings: '"opsz" 144, "wght" 700, "SOFT" 100',
                  fontSize: 32, letterSpacing: "-0.025em",
                  color: "var(--ink)",
                }}>
                  PrepAI<span style={{ color: "var(--vermillion)" }}>//</span>Pro
                </span>
              </div>
              <p style={{
                fontFamily: "var(--serif)",
                fontVariationSettings: '"opsz" 12, "wght" 400, "SOFT" 30',
                fontSize: 13, fontStyle: "italic",
                color: "var(--ink-3)", marginTop: 4, maxWidth: 320,
                lineHeight: 1.5,
              }}>
                Built independently. Free to use. Your inputs stay in
                your browser — nothing is logged or stored on a server.
              </p>
            </div>
            <div>
              <SmallLabel>Made with</SmallLabel>
              <div style={{ marginTop: 8 }}>
                <LeaderRow label="Display font"  value="Fraunces" />
                <LeaderRow label="Body font"     value="Geist" />
                <LeaderRow label="Mono font"     value="JetBrains Mono" />
                <LeaderRow label="AI"            value="Gemini 2.5 Flash" />
                <LeaderRow label="Built by"      value="Prasanna Warad" valueColor="var(--vermillion)" />
              </div>
            </div>
            <div data-footer-right style={S.footerRight}>
              <div style={{
                fontFamily: "var(--serif)",
                fontVariationSettings: '"opsz" 144, "wght" 300, "SOFT" 100',
                fontSize: 96, lineHeight: 0.9,
                color: "var(--vermillion)",
                letterSpacing: "-0.05em",
                fontStyle: "italic",
              }}>
                ※
              </div>
              <SmallLabel color="var(--ink-4)">Thanks for visiting</SmallLabel>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

// ─────────── Empty / loading panels ───────────

function EmptyState({ kind, onPick, hasResume }) {
  return (
    <div style={S.emptyOuter}>
      <div style={S.emptyInner}>
        <div style={S.emptyHeadline}>
          <SmallLabel color="var(--vermillion)">Step 3</SmallLabel>
          <h3 style={S.emptyTitle}>
            {kind === "dossier"
              ? <>Enter a company above, then tap <span style={{ color: "var(--vermillion)" }}>Research company</span>.</>
              : <>Enter a company above, then tap <span style={{ color: "var(--vermillion)" }}>Start Mock Interview</span>.</>}
          </h3>
          <p style={S.emptyDek}>
            {kind === "dossier"
              ? "Open tabs for history, products & market, culture, latest news, and the interview playbook — plus STAR stories when you add a resume, and fit & gaps when you paste the job posting."
              : "Five chat turns, then a scorecard: overall score, strengths, improvements, and notes per question. Answer by typing or tap ● Rec to speak."}
            {kind === "simulation" && !hasResume && (
              <span style={{ display: "block", marginTop: 10, color: "var(--ink-3)" }}>
                <em>Tip:</em> add your resume above for questions tailored to your background.
              </span>
            )}
          </p>
        </div>

        {kind === "dossier" && (
          <div style={{ marginTop: 28 }}>
            <SmallLabel>Try one of these</SmallLabel>
            <div style={S.emptyChips}>
              {SUBJECT_HINTS.map((name, i) => (
                <button
                  key={name}
                  onClick={() => onPick?.(name)}
                  className="hover-stamp"
                  style={{ ...S.emptyChip, animationDelay: `${0.4 + i * 0.05}s` }}
                >
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
                    color: "var(--ink-4)", letterSpacing: "0.18em", marginRight: 8,
                  }}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span style={{
                    fontFamily: "var(--serif)",
                    fontVariationSettings: '"opsz" 24, "wght" 500, "SOFT" 60',
                    fontSize: 16,
                  }}>
                    {name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div data-empty-stamp style={S.emptyStampWrap} aria-hidden>
          <Stamp rotate={-12} size={120} style={{ fontSize: 18, padding: "26px 36px" }}>
            {"Add\nCompany"}
          </Stamp>
        </div>
      </div>
    </div>
  );
}

// ─────────── Engaging loading panel ───────────
function LoadingPanel({ subject, kind, hasResume, hasJd }) {
  const config = useMemo(() => {
    if (kind === "report") return {
      title: "Reviewing your interview",
      action: "Scoring your answers",
      eta: "Usually takes 5–10 seconds",
      steps: MOCK_REPORT_STEPS,
      stepEvery: 2200,
    };
    if (kind === "mock-init") return {
      title: "Setting up your interview",
      action: "Briefing the interviewer",
      eta: "Usually takes a few seconds",
      steps: MOCK_INIT_STEPS,
      stepEvery: 1400,
    };
    return {
      title: `Preparing your brief on ${subject}`,
      action: `Researching ${subject}`,
      eta: "Usually takes 8–15 seconds",
      steps: [
        ...RESEARCH_STEPS_BASE,
        ...(hasJd ? [RESEARCH_STEP_JD] : []),
        ...(hasResume ? [RESEARCH_STEP_STAR] : []),
      ],
      stepEvery: 2400,
    };
  }, [kind, subject, hasResume, hasJd]);

  const [stepIdx, setStepIdx] = useState(0);
  const [tipIdx, setTipIdx]   = useState(() => Math.floor(Math.random() * INTERVIEW_TIPS.length));

  useEffect(() => {
    const t = setInterval(() => {
      setStepIdx(i => Math.min(i + 1, config.steps.length - 1));
    }, config.stepEvery);
    return () => clearInterval(t);
  }, [config.steps.length, config.stepEvery]);

  useEffect(() => {
    const t = setInterval(() => {
      setTipIdx(i => (i + 1) % INTERVIEW_TIPS.length);
    }, 4500);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={S.loadingPanel} role="status" aria-live="polite">
      <div style={S.loadingHead}>
        <SmallLabel color="var(--vermillion)">§ {config.action}</SmallLabel>
        <SmallLabel color="var(--ink-4)">{config.eta}</SmallLabel>
      </div>
      <Hairline />

      <div data-loading-grid style={S.loadingGrid}>
        {/* Left: status & steps */}
        <div style={S.loadingMain}>
          <h3 style={S.loadingTitle}>
            {config.title}<span className="cursor-blink" />
          </h3>

          <ol style={S.stepList}>
            {config.steps.map((step, i) => {
              const status = i < stepIdx ? "done" : i === stepIdx ? "active" : "pending";
              return (
                <li key={i} style={{
                  ...S.stepItem,
                  opacity: status === "pending" ? 0.45 : 1,
                  transition: "opacity 0.4s",
                }}>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 16,
                    color:
                      status === "done"   ? "var(--forest)" :
                      status === "active" ? "var(--vermillion)" :
                                            "var(--ink-4)",
                    width: 20, display: "inline-flex",
                    justifyContent: "center", alignItems: "center",
                    fontWeight: 700,
                    animation: status === "active" ? "softPulse 1.4s ease infinite" : "none",
                  }}>
                    {status === "done" ? "✓" : status === "active" ? "◐" : "○"}
                  </span>
                  <span style={{
                    fontFamily: "var(--serif)",
                    fontVariationSettings: '"opsz" 24, "wght" 500, "SOFT" 60',
                    fontSize: 17,
                    color: status === "pending" ? "var(--ink-3)" : "var(--ink)",
                    textDecoration: status === "done" ? "line-through" : "none",
                    textDecorationColor: "color-mix(in srgb, var(--ink-4) 60%, transparent)",
                    textDecorationThickness: "1px",
                    transition: "all 0.4s",
                  }}>
                    {step}
                  </span>
                  {status === "active" && (
                    <span style={{
                      flex: 1, marginLeft: 10, height: 1,
                      background: "color-mix(in srgb, var(--ink) 18%, transparent)",
                      position: "relative", overflow: "hidden",
                      alignSelf: "center",
                    }}>
                      <span style={{
                        position: "absolute", left: 0, top: 0, bottom: 0,
                        width: "30%",
                        background: "var(--vermillion)",
                        animation: "shimmerSlide 1.8s ease-in-out infinite",
                      }} />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        {/* Right: rotating interview tip */}
        <aside style={S.loadingTip}>
          <SmallLabel color="var(--ink-3)">§ Tip while you wait</SmallLabel>
          <p key={tipIdx} style={S.tipText}>
            “{INTERVIEW_TIPS[tipIdx]}”
          </p>
          <div style={S.tipDots}>
            {INTERVIEW_TIPS.map((_, i) => (
              <span key={i} style={{
                width: i === tipIdx ? 18 : 4,
                height: 2,
                background: i === tipIdx ? "var(--vermillion)" : "color-mix(in srgb, var(--ink) 25%, transparent)",
                transition: "all 0.5s cubic-bezier(.2,.7,.2,1)",
                display: "inline-block",
              }} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─────────── Style object ───────────

const S = {
  shell: {
    minHeight: "100vh",
    background: "transparent",
    color: "var(--ink)",
    fontFamily: "var(--sans)",
    position: "relative",
    overflowX: "hidden",
  },

  edgeRibbon: {
    position: "fixed",
    left: 0,
    top: 0,
    bottom: 0,
    width: 28,
    borderRight: "var(--hair)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: 5,
  },
  edgeRibbonText: {
    transform: "rotate(-90deg)",
    whiteSpace: "nowrap",
    fontFamily: "var(--mono)",
    fontSize: 9,
    letterSpacing: "0.5em",
    color: "color-mix(in srgb, var(--ink) 35%, transparent)",
    fontWeight: 500,
    textTransform: "uppercase",
  },

  topBar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: "color-mix(in srgb, var(--paper) 88%, transparent)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  },
  topBarInner: {
    maxWidth: 1180,
    margin: "0 auto",
    padding: "10px 36px 10px 56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  monogram: {
    width: 26, height: 26,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "var(--paper-2)", color: "var(--ink)",
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 700, "SOFT" 100',
    fontSize: 16,
    fontStyle: "italic",
    lineHeight: 1,
    paddingTop: 1,
  },
  topBarMid: {
    display: "flex", alignItems: "center", gap: 8,
  },

  container: {
    maxWidth: 1180,
    margin: "0 auto",
    padding: "32px 36px 0 56px",
    position: "relative",
  },

  hero: {
    paddingBottom: 40,
    paddingTop: 8,
  },
  heroGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)",
    gap: 56,
    alignItems: "start",
  },
  heroLeft: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  heroTitle: {
    fontFamily: "var(--serif)",
    fontSize: "clamp(56px, 9vw, 120px)",
    fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 100',
    lineHeight: 0.92,
    letterSpacing: "-0.035em",
    color: "var(--ink)",
    margin: "8px 0",
  },
  heroRule: {
    width: "70%",
    height: 2,
    background: "var(--ink)",
    margin: "16px 0 14px",
    transformOrigin: "left center",
    animation: "drawRule 1s cubic-bezier(.2,.7,.2,1) 0.9s both",
  },
  heroDek: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
    fontSize: 16,
    lineHeight: 1.65,
    color: "var(--ink-2)",
    maxWidth: 580,
    marginTop: 18,
    animation: "fadeUp 0.6s cubic-bezier(.2,.7,.2,1) 1.1s both",
  },

  heroSteps: {
    listStyle: "none",
    padding: 0,
    margin: "14px 0 0",
    maxWidth: 560,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  heroStep: {
    display: "flex",
    gap: 14,
    alignItems: "flex-start",
    fontFamily: "var(--sans)",
    fontSize: 14,
    lineHeight: 1.5,
    color: "var(--ink-2)",
    animation: "fadeUp 0.5s cubic-bezier(.2,.7,.2,1) both",
  },
  heroStepKey: {
    flexShrink: 0,
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--mono)",
    fontSize: 12,
    fontWeight: 700,
    color: "var(--vermillion)",
    border: "1px solid color-mix(in srgb, var(--vermillion) 45%, transparent)",
    background: "color-mix(in srgb, var(--vermillion) 6%, transparent)",
  },
  heroStepText: { flex: 1, minWidth: 0 },
  heroStepTitle: {
    color: "var(--ink)",
    fontWeight: 600,
    fontFamily: "var(--sans)",
  },

  heroRight: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
    paddingTop: 4,
    animation: "fadeUp 0.6s cubic-bezier(.2,.7,.2,1) 0.6s both",
  },
  metaBox: {
    border: "var(--hair)",
    padding: "14px 16px",
    background: "color-mix(in srgb, var(--paper-2) 60%, transparent)",
  },
  priceTag: {
    border: "2px solid var(--ink)",
    padding: "16px 18px",
    background: "var(--paper-2)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    position: "relative",
    transform: "rotate(-1.2deg)",
  },
  priceTagSmall: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    letterSpacing: "0.22em",
    color: "var(--ink-3)",
    textTransform: "uppercase",
    fontWeight: 600,
  },
  priceTagPrice: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 800, "SOFT" 100',
    fontSize: 56,
    color: "var(--vermillion)",
    fontStyle: "italic",
    lineHeight: 1,
    letterSpacing: "-0.04em",
  },

  tocSection: {
    padding: "28px 0",
  },
  tocHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 18,
    paddingBottom: 8,
    borderBottom: "var(--hair-soft)",
  },

  sectionLead: {
    fontFamily: "var(--sans)",
    fontSize: 15,
    fontWeight: 500,
    lineHeight: 1.45,
    color: "var(--ink-2)",
    marginTop: 6,
    maxWidth: 520,
  },
  modeGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, 1fr)",
    gap: 16,
  },
  modeTile: {
    border: "1.5px solid var(--ink)",
    padding: "22px 22px 24px",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "var(--sans)",
    animation: "fadeUp 0.5s cubic-bezier(.2,.7,.2,1) both",
    minHeight: 200,
    display: "flex",
    flexDirection: "column",
  },

  formSection: {
    padding: "28px 0",
  },
  formHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 18,
    paddingBottom: 8,
    borderBottom: "var(--hair-soft)",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 0,
    border: "var(--hair)",
    borderBottom: "none",
  },
  field: {
    padding: "14px 18px",
    borderRight: "var(--hair-soft)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  fieldLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--mono)",
    fontSize: 10,
    letterSpacing: "0.18em",
    fontWeight: 600,
    color: "var(--ink)",
    textTransform: "uppercase",
  },
  fieldNum: {
    color: "var(--vermillion)",
    fontWeight: 700,
  },
  fieldRequired: {
    marginLeft: "auto",
    color: "var(--ink-4)",
    fontWeight: 400,
    letterSpacing: "0.15em",
  },
  input: {
    background: "transparent",
    border: "none",
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 36, "wght" 500, "SOFT" 60',
    fontSize: 22,
    color: "var(--ink)",
    padding: "4px 0 6px",
    letterSpacing: "-0.012em",
    width: "100%",
  },
  textarea: {
    width: "100%",
    background: "var(--paper-2)",
    border: "var(--hair)",
    padding: "14px 16px",
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--ink)",
    lineHeight: 1.65,
    letterSpacing: "0.005em",
  },

  resumeToolbar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 10,
    paddingTop: 10,
    borderTop: "var(--hair-soft)",
  },
  resumeFileBtn: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    padding: "8px 14px",
    border: "1px solid color-mix(in srgb, var(--vermillion) 55%, transparent)",
    color: "var(--vermillion)",
    background: "color-mix(in srgb, var(--vermillion) 8%, transparent)",
    cursor: "pointer",
  },
  resumeToolbarHint: {
    flex: "1 1 180px",
    fontFamily: "var(--sans)",
    fontSize: 11,
    color: "var(--ink-4)",
    lineHeight: 1.4,
  },
  resumeToolbarMeta: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--ink-3)",
    letterSpacing: "0.08em",
    marginLeft: "auto",
  },

  credentialsToggle: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "14px 18px",
    border: "var(--hair)",
    borderTop: "none",
    background: "transparent",
    cursor: "pointer",
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.16em",
    color: "var(--ink)",
    textTransform: "uppercase",
    transition: "background 0.18s",
  },

  difficultyRow: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
    marginTop: 10,
  },
  diffTile: {
    border: "1.5px solid var(--ink)",
    padding: "12px 14px 14px",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "var(--sans)",
    transition: "all 0.18s",
  },

  actionBtn: {
    background: "var(--vermillion)",
    color: "var(--ink)",
    fontFamily: "var(--mono)",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    padding: "16px 28px",
    border: "2px solid var(--ink)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 14,
    boxShadow: "0 0 0 0 var(--ink)",
  },
  actionBtnArrow: {
    fontFamily: "var(--serif)",
    fontSize: 22,
    fontStyle: "italic",
    letterSpacing: 0,
    transform: "translateY(-1px)",
  },

  errorNotice: {
    border: "1.5px solid var(--vermillion)",
    background: "color-mix(in srgb, var(--vermillion) 8%, transparent)",
    padding: "14px 18px",
    margin: "20px 0",
    animation: "fadeUp 0.3s ease",
  },

  // ── File header (used by dossier + scorecard)
  fileHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: 14,
    gap: 24,
  },
  fileHeadLeft: {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
  },

  subjectCard: {
    padding: "32px 0 28px",
    position: "relative",
  },
  subjectName: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 100',
    fontSize: "clamp(40px, 6vw, 76px)",
    lineHeight: 0.96,
    letterSpacing: "-0.035em",
    color: "var(--ink)",
    margin: "8px 0 4px",
  },
  subjectTagline: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 36, "wght" 400, "SOFT" 80',
    fontStyle: "italic",
    fontSize: 22,
    lineHeight: 1.4,
    color: "var(--ink-2)",
    maxWidth: 760,
    marginTop: 10,
    marginBottom: 22,
    letterSpacing: "-0.005em",
  },
  subjectMeta: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
    gap: "10px 28px",
    paddingTop: 14,
    borderTop: "var(--hair-soft)",
  },

  sectionNav: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    margin: "20px 0 0",
    paddingBottom: 0,
    borderBottom: "var(--hair)",
  },
  sectionTab: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 18px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    transition: "background 0.18s, color 0.18s",
    fontFamily: "var(--sans)",
    position: "relative",
  },

  bodyCard: {
    padding: "26px 0 32px",
    background: "transparent",
    maxWidth: 760,
  },

  // ── Empty state
  emptyOuter: {
    padding: "20px 0 40px",
  },
  emptyInner: {
    position: "relative",
    minHeight: 320,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  emptyHeadline: {
    maxWidth: 720,
    animation: "fadeUp 0.5s cubic-bezier(.2,.7,.2,1) both",
  },
  emptyTitle: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 500, "SOFT" 100',
    fontSize: "clamp(36px, 5vw, 64px)",
    lineHeight: 1,
    letterSpacing: "-0.03em",
    color: "var(--ink)",
    margin: "10px 0 18px",
  },
  emptyDek: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
    fontSize: 17,
    lineHeight: 1.65,
    color: "var(--ink-2)",
    maxWidth: 600,
  },
  emptyChips: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 12,
  },
  emptyChip: {
    display: "inline-flex",
    alignItems: "center",
    padding: "10px 16px",
    border: "var(--hair)",
    background: "transparent",
    cursor: "pointer",
    transition: "background 0.18s, color 0.18s",
    color: "var(--ink)",
    animation: "fadeUp 0.4s cubic-bezier(.2,.7,.2,1) both",
  },
  emptyStampWrap: {
    position: "absolute",
    top: 0,
    right: 0,
    pointerEvents: "none",
    transform: "translate(30%, -10%)",
  },

  loadingPanel: {
    padding: "16px 0 32px",
    animation: "fadeIn 0.4s ease",
  },
  loadingHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 10,
    paddingBottom: 4,
  },
  loadingGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
    gap: 40,
    alignItems: "start",
    paddingTop: 22,
  },
  loadingMain: {
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  loadingTitle: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 80',
    fontSize: "clamp(28px, 3.6vw, 40px)",
    lineHeight: 1.05,
    letterSpacing: "-0.022em",
    color: "var(--ink)",
  },
  stepList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 11,
  },
  stepItem: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "4px 0",
  },
  loadingTip: {
    border: "1.5px solid var(--ink)",
    background: "color-mix(in srgb, var(--paper-2) 70%, transparent)",
    padding: "20px 22px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    minHeight: 200,
  },
  tipText: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 36, "wght" 500, "SOFT" 80',
    fontStyle: "italic",
    fontSize: 22,
    lineHeight: 1.4,
    color: "var(--ink)",
    letterSpacing: "-0.012em",
    flex: 1,
    animation: "tipFade 0.5s cubic-bezier(.2,.7,.2,1) both",
  },
  tipDots: {
    display: "flex",
    gap: 4,
    alignItems: "center",
    paddingTop: 6,
    borderTop: "1px dotted color-mix(in srgb, var(--ink) 25%, transparent)",
    flexWrap: "wrap",
  },

  // ── Transcript / Mock interview
  transcriptHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 24,
    flexWrap: "wrap",
    paddingBottom: 18,
  },
  transcriptHeadLeft: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  transcriptTitle: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 80',
    fontSize: "clamp(28px, 4vw, 44px)",
    letterSpacing: "-0.025em",
    color: "var(--ink)",
    lineHeight: 1.05,
  },
  transcriptHeadRight: {
    minWidth: 240,
  },
  progressTrack: {
    height: 4,
    background: "color-mix(in srgb, var(--ink) 14%, transparent)",
    marginTop: 10,
    position: "relative",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--vermillion)",
    transition: "width 0.6s cubic-bezier(.2,.7,.2,1)",
  },
  transcript: {
    padding: "28px 0",
    display: "flex",
    flexDirection: "column",
    gap: 28,
    minHeight: 220,
    maxHeight: 600,
    overflowY: "auto",
  },
  transcriptTurn: {
    display: "grid",
    gap: 14,
    alignItems: "start",
  },
  transcriptSpeaker: {
    paddingTop: 4,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  transcriptBody: {
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
    fontSize: 17,
    lineHeight: 1.7,
    letterSpacing: "0.002em",
  },
  replyRow: {
    display: "flex",
    alignItems: "center",
    padding: "14px 0",
    gap: 8,
  },
  replyInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    fontFamily: "var(--serif)",
    fontVariationSettings: '"opsz" 14, "wght" 400, "SOFT" 50',
    fontSize: 17,
    fontStyle: "italic",
    color: "var(--ink)",
    padding: "8px 0",
  },
  replyBtn: {
    background: "var(--paper-2)",
    color: "var(--ink)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    padding: "12px 22px",
    border: "1px solid color-mix(in srgb, var(--ink) 28%, transparent)",
    cursor: "pointer",
    boxShadow: "0 0 24px color-mix(in srgb, var(--vermillion) 18%, transparent)",
  },
  micBtn: {
    background: "transparent",
    color: "var(--ink)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    padding: "12px 16px",
    border: "1px solid color-mix(in srgb, var(--ink) 28%, transparent)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  voiceToggle: {
    marginTop: 10,
    width: "100%",
    background: "transparent",
    color: "var(--ink-3)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    padding: "7px 10px",
    border: "1px solid color-mix(in srgb, var(--ink) 22%, transparent)",
    cursor: "pointer",
  },

  // ── Scorecard
  scoreBand: {
    display: "flex",
    gap: 28,
    alignItems: "stretch",
    padding: "26px 0",
  },
  swotGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 0,
    padding: "26px 0",
    borderLeft: "var(--hair-soft)",
  },
  swotCol: {
    padding: "0 24px",
    borderRight: "var(--hair-soft)",
  },
  swotHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  swotList: {
    listStyle: "none",
    padding: 0,
    marginTop: 14,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  swotItem: {
    display: "grid",
    gridTemplateColumns: "32px 1fr",
    alignItems: "baseline",
  },

  perQ: {
    padding: "26px 0",
  },
  perQList: {
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  perQItem: {
    paddingBottom: 22,
    borderBottom: "var(--hair-soft)",
  },

  proTip: {
    position: "relative",
    border: "2px solid var(--vermillion)",
    background: "color-mix(in srgb, var(--vermillion) 5%, transparent)",
    padding: "22px 28px 24px",
    margin: "20px 0",
  },

  // ── Footer
  footer: {
    marginTop: 56,
  },
  footerInner: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr 0.6fr",
    gap: 36,
    padding: "32px 0 60px",
    alignItems: "start",
  },
  footerLeft: { display: "flex", flexDirection: "column", gap: 4 },
  footerRight: {
    textAlign: "right",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 8,
  },
};

// ─────────── Mobile / responsive overrides via media queries ───────────
// Inject responsive styles by attaching a global stylesheet on first render
if (typeof document !== "undefined" && !document.getElementById("__prepai_responsive")) {
  const tag = document.createElement("style");
  tag.id = "__prepai_responsive";
  tag.textContent = `
    @media (max-width: 980px) {
      [data-hero-grid] { grid-template-columns: 1fr !important; gap: 32px !important; }
      [data-mode-grid] { grid-template-columns: 1fr !important; }
      [data-form-grid] { grid-template-columns: 1fr !important; }
      [data-form-grid] [data-form-field]:first-child { border-right: none !important; border-bottom: 1px solid color-mix(in srgb, var(--ink) 28%, transparent) !important; }
      [data-swot-grid] { grid-template-columns: 1fr !important; gap: 24px !important; padding: 20px 0 !important; border-left: none !important; }
      [data-swot-col] { border-right: none !important; padding: 0 !important; }
      [data-footer-grid] { grid-template-columns: 1fr !important; gap: 28px !important; }
      [data-footer-right] { text-align: left !important; align-items: flex-start !important; }
      [data-difficulty-row] { grid-template-columns: 1fr !important; }
      [data-transcript-turn] { grid-template-columns: 1fr !important; }
      [data-transcript-speaker][data-side="right"] { text-align: left !important; }
      [data-empty-stamp] { display: none !important; }
      [data-loading-grid] { grid-template-columns: 1fr !important; gap: 24px !important; }
    }
    @media (max-width: 880px) {
      aside[aria-hidden] { display: none !important; }
      main { padding: 24px 20px 0 20px !important; }
    }
    @media (max-width: 720px) {
      [data-top-bar-mid] { display: none !important; }
    }
    @media (max-width: 560px) {
      h1, h2, h3 { hyphens: auto; }
    }
  `;
  document.head.appendChild(tag);
}
