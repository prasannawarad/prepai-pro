import { useState, useRef, useEffect, useCallback } from "react";

// ─── Constants ───
const RESEARCH_SECTIONS = [
  { id: "history", label: "History", icon: "📜", color: "#E8A838" },
  { id: "culture", label: "Culture", icon: "🏢", color: "#4ECDC4" },
  { id: "news", label: "News", icon: "📰", color: "#FF6B6B" },
  { id: "interview_tips", label: "Tips", icon: "🎯", color: "#A78BFA" },
  { id: "star_stories", label: "STAR Stories", icon: "⭐", color: "#F472B6" },
];

const DIFFICULTY_LEVELS = [
  { id: "easy", label: "Warm-up", icon: "🟢", desc: "Behavioral & intro questions" },
  { id: "medium", label: "Standard", icon: "🟡", desc: "Technical + situational" },
  { id: "hard", label: "Pressure", icon: "🔴", desc: "Curveballs & deep dives" },
];

const MODES = [
  { id: "research", label: "Company Intel", icon: "🔍", desc: "Deep company research & STAR stories" },
  { id: "mock", label: "Mock Interview", icon: "🎙️", desc: "Practice with AI interviewer" },
];

function parseMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/^### (.*$)/gm, '<h4 style="margin:14px 0 6px;font-size:15px;color:#E2E8F0">$1</h4>')
    .replace(/^## (.*$)/gm, '<h3 style="margin:16px 0 8px;font-size:17px;color:#E2E8F0">$1</h3>')
    .replace(/^- (.*$)/gm, '<li style="margin:4px 0;margin-left:18px;list-style:disc">$1</li>')
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

// ─── Gemini API helper ───
async function callGemini(apiKey, prompt, temperature = 0.7, tools = null) {
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 4096 },
  };
  if (tools) requestBody.tools = tools;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );
  const data = await response.json();
  if (data.error) {
    if (data.error.code === 400 || data.error.code === 403)
      throw new Error("Invalid API key. Check your Gemini key.");
    throw new Error(data.error.message || "API error");
  }
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!rawText) throw new Error("No response from Gemini.");
  return rawText;
}

async function callGeminiJSON(apiKey, prompt, temperature = 0.7, tools = null) {
  const raw = await callGemini(apiKey, prompt, temperature, tools);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ─── Main Component ───
export default function PrepAIPro() {
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

  const [apiKey, setApiKey] = useState(API_KEY);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [resume, setResume] = useState("");
  const [activeMode, setActiveMode] = useState("research");
  const [activeTab, setActiveTab] = useState("history");

  // Research state
  const [researchData, setResearchData] = useState(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Mock interview state
  const [mockDifficulty, setMockDifficulty] = useState("medium");
  const [mockStarted, setMockStarted] = useState(false);
  const [mockMessages, setMockMessages] = useState([]);
  const [mockInput, setMockInput] = useState("");
  const [mockLoading, setMockLoading] = useState(false);
  const [mockQuestionCount, setMockQuestionCount] = useState(0);
  const [mockComplete, setMockComplete] = useState(false);
  const [mockScorecard, setMockScorecard] = useState(null);

  const [error, setError] = useState("");
  const [showResume, setShowResume] = useState(false);

  const inputRef = useRef(null);
  const chatEndRef = useRef(null);
  const mockInputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mockMessages]);

  useEffect(() => {
    if (mockStarted && !mockLoading) mockInputRef.current?.focus();
  }, [mockStarted, mockLoading]);



  // ─── Research Mode ───
  const fetchResearch = async () => {
    if (!company.trim()) {
      return;
    }
    setResearchLoading(true);
    setError("");
    setResearchData(null);
    setSearched(true);
    setActiveTab("history");

    const resumeContext = resume.trim()
      ? `\n\nThe candidate's resume:\n${resume.trim()}\n\nUse this resume to generate personalized STAR stories in the star_stories field.`
      : "";

    const prompt = `You are an expert career coach and company research analyst. Research "${company.trim()}"${role.trim() ? ` for the role: ${role.trim()}` : ""}.${resumeContext}

Respond ONLY in valid JSON (no markdown fences). Keys:
{
  "company_name": "Official name",
  "tagline": "One-line description",
  "founded": "Year or N/A",
  "headquarters": "City, Country",
  "industry": "Primary industry",
  "history": "3-4 paragraph markdown history: founding, milestones, growth, market position.",
  "culture": "3-4 paragraph markdown culture: values, management style, work-life balance, DEI, perks, what it's really like.",
  "news": "Markdown-formatted section with 5-6 MOST RECENT news and developments from the last 30 days. Include specific dates. Use bullet points starting with -. Focus on the very latest news, earnings, product launches, leadership changes, partnerships, and market movements.",
  "interview_tips": "Markdown with 7-8 specific actionable tips for this company.${role.trim() ? ` Tailored to ${role.trim()}.` : ""}",
  "star_stories": "${resume.trim()
        ? "Markdown with 4-5 personalized STAR (Situation, Task, Action, Result) stories derived from the candidate's resume experiences. Each story should be mapped to a company value or common interview theme. Format each with a bold title, the company value it maps to, and the full STAR narrative."
        : "Markdown explaining: Paste your resume in the Resume field and re-search to get personalized STAR stories mapped to this company's values."}"
}`;

    try {
      const parsed = await callGeminiJSON(apiKey, prompt, 0.7, [{ google_search: {} }]);
      setResearchData(parsed);
    } catch (err) {
      console.error(err);
      setError(err instanceof SyntaxError ? "Failed to parse response. Try again." : err.message);
    } finally {
      setResearchLoading(false);
    }
  };

  // ─── Mock Interview Mode ───
  const startMockInterview = async () => {
    if (!company.trim()) {
      setError("Enter a company name to start.");
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
${resume.trim() ? `Candidate resume:\n${resume.trim()}\n` : ""}

Start the mock interview. Greet the candidate briefly, then ask your FIRST interview question. 
- For "easy": behavioral/intro questions
- For "medium": mix of technical and situational
- For "hard": pressure questions, curveballs, deep dives

Keep it natural and conversational. Ask ONE question at a time. Do NOT provide feedback yet.
Respond ONLY with your interviewer dialogue (no JSON, no labels).`;

    try {
      const response = await callGemini(apiKey, prompt, 0.8);
      setMockMessages([{ role: "interviewer", text: response }]);
      setMockQuestionCount(1);
    } catch (err) {
      setError(err.message);
      setMockStarted(false);
    } finally {
      setMockLoading(false);
    }
  };

  const sendMockAnswer = async () => {
    if (!mockInput.trim() || mockLoading) return;
    const userAnswer = mockInput.trim();
    setMockInput("");

    const updatedMessages = [...mockMessages, { role: "candidate", text: userAnswer }];
    setMockMessages(updatedMessages);
    setMockLoading(true);

    const newCount = mockQuestionCount + 1;

    // After 5 questions, generate scorecard
    if (newCount > 5) {
      const scorecardPrompt = `You conducted a mock interview for ${company.trim()}${role.trim() ? ` (${role.trim()})` : ""}. Difficulty: ${mockDifficulty}.

Here is the full interview transcript:
${updatedMessages.map(m => `${m.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${m.text}`).join("\n\n")}

Provide a final evaluation. Respond ONLY in valid JSON:
{
  "overall_score": (number 1-10),
  "summary": "2-3 sentence overall assessment",
  "strengths": ["strength1", "strength2", "strength3"],
  "improvements": ["area1", "area2", "area3"],
  "per_question": [
    {"question_summary": "brief question", "score": (1-10), "feedback": "specific feedback"}
  ],
  "final_tip": "One powerful closing piece of advice"
}`;

      try {
        const scorecard = await callGeminiJSON(apiKey, scorecardPrompt, 0.5);
        setMockScorecard(scorecard);
        setMockComplete(true);
      } catch (err) {
        setError("Failed to generate scorecard. " + err.message);
      } finally {
        setMockLoading(false);
      }
      return;
    }

    // Continue interview
    const conversationHistory = updatedMessages
      .map(m => `${m.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${m.text}`)
      .join("\n\n");

    const nextPrompt = `You are an interviewer at ${company.trim()}${role.trim() ? ` for ${role.trim()}` : ""}. Difficulty: ${mockDifficulty}.
${resume.trim() ? `Candidate resume:\n${resume.trim()}\n` : ""}

Interview so far:
${conversationHistory}

Give brief, encouraging feedback on their last answer (1-2 sentences), then ask the NEXT interview question. This is question ${newCount} of 5.
${newCount === 5 ? "This is the FINAL question — make it count." : ""}
Keep it natural. Respond only with your interviewer dialogue.`;

    try {
      const response = await callGemini(apiKey, nextPrompt, 0.8);
      setMockMessages(prev => [...prev, { role: "interviewer", text: response }]);
      setMockQuestionCount(newCount);
    } catch (err) {
      setError(err.message);
    } finally {
      setMockLoading(false);
    }
  };

  const resetMock = () => {
    setMockStarted(false);
    setMockMessages([]);
    setMockQuestionCount(0);
    setMockComplete(false);
    setMockScorecard(null);
  };

  // ─── Render Helpers ───
  const visibleSections = resume.trim()
    ? RESEARCH_SECTIONS
    : RESEARCH_SECTIONS.filter(s => s.id !== "star_stories");

  const ScoreBar = ({ score, max = 10 }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: "#1E293B", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${(score / max) * 100}%`,
          height: "100%",
          borderRadius: 3,
          background: score >= 7 ? "linear-gradient(90deg, #4ADE80, #22C55E)" :
            score >= 5 ? "linear-gradient(90deg, #FBBF24, #F59E0B)" :
              "linear-gradient(90deg, #F87171, #EF4444)",
          transition: "width 0.8s ease",
        }} />
      </div>
      <span style={{ fontSize: 14, fontWeight: 700, color: "#E2E8F0", minWidth: 30 }}>{score}/{max}</span>
    </div>
  );

  return (
    <div style={S.wrapper}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Manrope:wght@300;400;500;600;700;800&display=swap');
        :root {
          --bg: #0A0D16;
          --surface: #111627;
          --surface2: #1A2035;
          --border: #232B45;
          --text: #B0BFCF;
          --text-bright: #F1F5F9;
          --accent: #E8A838;
          --accent2: #4ECDC4;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::selection { background: var(--accent); color: var(--bg); }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes typing { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }
        .hover-lift { transition: all 0.2s ease; cursor: pointer; }
        .hover-lift:hover { transform: translateY(-2px); }
        .hover-glow:hover { box-shadow: 0 0 20px rgba(232,168,56,0.15); }
        input:focus, textarea:focus { border-color: var(--accent) !important; outline: none; }
        textarea { resize: vertical; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
      `}</style>

      <div style={S.container}>
        {/* ─── Header ─── */}
        <div style={S.header}>
          <div style={S.logoRow}>
            <div style={S.logoMark}>P</div>
            <div>
              <h1 style={S.title}>PrepAI<span style={{ color: "var(--accent)", fontWeight: 800 }}>Pro</span></h1>
              <p style={S.subtitle}>AI Interview Intelligence Platform</p>
            </div>
            <span style={S.badge}>FREE</span>
          </div>
        </div>

        {/* ─── API Key ─── */}


        {/* ─── Mode Selector ─── */}
        <div style={S.modeRow}>
          {MODES.map(m => (
            <button key={m.id} className="hover-lift"
              onClick={() => setActiveMode(m.id)}
              style={{
                ...S.modeBtn,
                background: activeMode === m.id ? "var(--surface2)" : "transparent",
                borderColor: activeMode === m.id ? "var(--accent)" : "var(--border)",
                color: activeMode === m.id ? "var(--text-bright)" : "var(--text)",
              }}>
              <span style={{ fontSize: 22 }}>{m.icon}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 400 }}>{m.desc}</div>
              </div>
            </button>
          ))}
        </div>

        {/* ─── Shared Inputs ─── */}
        <div style={S.inputCard}>
          <div style={S.inputGrid}>
            <div style={S.inputGroup}>
              <label style={S.label}>Company</label>
              <input ref={inputRef} type="text" placeholder="e.g. Stripe, Airbnb..."
                value={company} onChange={e => setCompany(e.target.value)}
                onKeyDown={e => e.key === "Enter" && (activeMode === "research" ? fetchResearch() : null)}
                style={S.input} />
            </div>
            <div style={S.inputGroup}>
              <label style={S.label}>Role <span style={{ opacity: 0.5 }}>(optional)</span></label>
              <input type="text" placeholder="e.g. Data Engineer, SWE..."
                value={role} onChange={e => setRole(e.target.value)}
                onKeyDown={e => e.key === "Enter" && (activeMode === "research" ? fetchResearch() : null)}
                style={S.input} />
            </div>
          </div>

          {/* Resume toggle */}
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setShowResume(!showResume)}
              style={{ ...S.linkBtn, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>{showResume ? "▾" : "▸"}</span>
              <span>{showResume ? "Hide" : "Add"} Resume for Personalized Prep</span>
              {resume.trim() && <span style={S.activeDot} />}
            </button>
            {showResume && (
              <textarea placeholder="Paste your resume text here... This enables personalized STAR stories and resume-aware mock interviews."
                value={resume} onChange={e => setResume(e.target.value)}
                rows={5}
                style={{ ...S.input, marginTop: 8, width: "100%", lineHeight: 1.6, fontSize: 13 }} />
            )}
          </div>

          {/* Action button */}
          <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {activeMode === "research" ? (
              <button onClick={fetchResearch}
                disabled={researchLoading || !company.trim()}
                className="hover-lift hover-glow"
                style={{ ...S.btnPrimary, opacity: (researchLoading || !company.trim()) ? 0.4 : 1 }}>
                {researchLoading ? "Researching..." : "Research Company →"}
              </button>
            ) : (
              <>
                <div style={{ display: "flex", gap: 6 }}>
                  {DIFFICULTY_LEVELS.map(d => (
                    <button key={d.id} className="hover-lift"
                      onClick={() => setMockDifficulty(d.id)}
                      style={{
                        ...S.diffBtn,
                        background: mockDifficulty === d.id ? "var(--surface2)" : "transparent",
                        borderColor: mockDifficulty === d.id ? "var(--accent)" : "var(--border)",
                        color: mockDifficulty === d.id ? "var(--text-bright)" : "var(--text)",
                      }}>
                      <span>{d.icon}</span> {d.label}
                    </button>
                  ))}
                </div>
                <button onClick={mockStarted ? resetMock : startMockInterview}
                  disabled={mockLoading || !company.trim()}
                  className="hover-lift hover-glow"
                  style={{ ...S.btnPrimary, opacity: (mockLoading || !company.trim()) ? 0.4 : 1 }}>
                  {mockStarted ? "Restart Interview" : "Start Mock Interview →"}
                </button>
              </>
            )}

          </div>
        </div>

        {/* Error */}
        {error && (
          <div style={S.errorCard}>
            <span>⚠️</span>
            <p style={{ color: "#FCA5A5", fontSize: 14 }}>{error}</p>
          </div>
        )}

        {/* ═══════ RESEARCH MODE ═══════ */}
        {activeMode === "research" && (
          <>
            {researchLoading && (
              <div style={S.loadingBox}>
                <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      width: 8, height: 8, borderRadius: "50%", background: "var(--accent)",
                      animation: `pulse 1.2s ease ${i * 0.2}s infinite`
                    }} />
                  ))}
                </div>
                <p style={{ fontSize: 14, color: "#7B8BA8" }}>Researching {company}...</p>
              </div>
            )}

            {researchData && !researchLoading && (
              <div style={{ animation: "fadeUp 0.5s ease" }}>
                <div style={S.companyCard}>
                  <h2 style={S.companyName}>{researchData.company_name}</h2>
                  <p style={S.companyTagline}>{researchData.tagline}</p>
                  <div style={S.metaRow}>
                    {researchData.founded && researchData.founded !== "N/A" && (
                      <span style={S.metaChip}>🗓 {researchData.founded}</span>
                    )}
                    {researchData.headquarters && <span style={S.metaChip}>📍 {researchData.headquarters}</span>}
                    {researchData.industry && <span style={S.metaChip}>🏷 {researchData.industry}</span>}
                  </div>
                </div>

                <div style={S.tabRow}>
                  {visibleSections.map(s => (
                    <button key={s.id} className="hover-lift"
                      onClick={() => setActiveTab(s.id)}
                      style={{
                        ...S.tab,
                        background: activeTab === s.id ? s.color + "18" : "transparent",
                        borderColor: activeTab === s.id ? s.color : "transparent",
                        color: activeTab === s.id ? s.color : "var(--text)",
                      }}>
                      <span style={{ fontSize: 16 }}>{s.icon}</span>
                      <span>{s.label}</span>
                    </button>
                  ))}
                </div>

                <div style={S.contentCard}>
                  <div key={activeTab} style={{ animation: "fadeUp 0.3s ease" }}
                    dangerouslySetInnerHTML={{ __html: parseMarkdown(researchData[activeTab] || "No data.") }} />
                </div>
              </div>
            )}

            {!searched && !researchLoading && (
              <div style={S.emptyState}>
                <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.5 }}>🔍</div>
                <h3 style={S.emptyTitle}>Ready to prep?</h3>
                <p style={S.emptyText}>Enter a company name and get AI-powered research, culture insights, and personalized STAR stories.</p>
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  {["Google", "Stripe", "Netflix", "Snowflake"].map(name => (
                    <button key={name} className="hover-lift"
                      onClick={() => setCompany(name)}
                      style={S.chipBtn}>{name}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ═══════ MOCK INTERVIEW MODE ═══════ */}
        {activeMode === "mock" && (
          <>
            {!mockStarted && !mockComplete && (
              <div style={S.emptyState}>
                <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.5 }}>🎙️</div>
                <h3 style={S.emptyTitle}>Mock Interview</h3>
                <p style={S.emptyText}>
                  Practice 5 interview questions with AI feedback. Choose difficulty, enter company details above, and hit start.
                  {!resume.trim() && " Add your resume for personalized questions."}
                </p>
              </div>
            )}

            {mockStarted && (
              <div style={S.chatContainer}>
                <div style={S.chatHeader}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={S.chatAvatar}>🎙️</div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text-bright)" }}>
                        {company} Interviewer
                      </div>
                      <div style={{ fontSize: 11, color: "#7B8BA8" }}>
                        {mockDifficulty === "easy" ? "Warm-up" : mockDifficulty === "medium" ? "Standard" : "Pressure"} · Question {Math.min(mockQuestionCount, 5)} of 5
                      </div>
                    </div>
                  </div>
                  <div style={S.progressBar}>
                    <div style={{ ...S.progressFill, width: `${(Math.min(mockQuestionCount, 5) / 5) * 100}%` }} />
                  </div>
                </div>

                <div style={S.chatBody}>
                  {mockMessages.map((msg, i) => (
                    <div key={i} style={{
                      ...S.chatBubble,
                      alignSelf: msg.role === "candidate" ? "flex-end" : "flex-start",
                      background: msg.role === "candidate" ? "var(--accent)" + "22" : "var(--surface2)",
                      borderColor: msg.role === "candidate" ? "var(--accent)" + "44" : "var(--border)",
                      animation: `slideIn 0.3s ease ${i * 0.05}s both`,
                      maxWidth: "85%",
                    }}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, marginBottom: 4,
                        color: msg.role === "candidate" ? "var(--accent)" : "var(--accent2)",
                        textTransform: "uppercase", letterSpacing: "0.05em"
                      }}>
                        {msg.role === "candidate" ? "You" : "Interviewer"}
                      </div>
                      <div style={{ fontSize: 14, lineHeight: 1.65, color: "var(--text-bright)" }}>
                        {msg.text}
                      </div>
                    </div>
                  ))}

                  {mockLoading && (
                    <div style={{ ...S.chatBubble, alignSelf: "flex-start", background: "var(--surface2)", borderColor: "var(--border)" }}>
                      <div style={{ display: "flex", gap: 4, padding: "4px 0" }}>
                        {[0, 1, 2].map(i => (
                          <div key={i} style={{
                            width: 6, height: 6, borderRadius: "50%", background: "var(--accent2)",
                            animation: `typing 1s ease ${i * 0.15}s infinite`
                          }} />
                        ))}
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {!mockComplete && (
                  <div style={S.chatInputRow}>
                    <input ref={mockInputRef} type="text"
                      placeholder={mockQuestionCount >= 5 ? "Type your final answer..." : "Type your answer..."}
                      value={mockInput}
                      onChange={e => setMockInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && sendMockAnswer()}
                      disabled={mockLoading}
                      style={{ ...S.input, flex: 1, fontSize: 14 }} />
                    <button onClick={sendMockAnswer}
                      disabled={mockLoading || !mockInput.trim()}
                      className="hover-lift"
                      style={{ ...S.btnPrimary, opacity: (mockLoading || !mockInput.trim()) ? 0.4 : 1, padding: "10px 20px" }}>
                      Send
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Scorecard */}
            {mockComplete && mockScorecard && (
              <div style={{ animation: "fadeUp 0.5s ease", marginTop: 20 }}>
                <div style={S.scorecardHeader}>
                  <div style={{ fontSize: 48, marginBottom: 8 }}>📊</div>
                  <h2 style={{ ...S.companyName, fontSize: 24 }}>Interview Scorecard</h2>
                  <p style={{ fontSize: 14, color: "#7B8BA8", maxWidth: 500, margin: "8px auto 0", lineHeight: 1.5 }}>
                    {mockScorecard.summary}
                  </p>
                </div>

                <div style={{ ...S.contentCard, marginBottom: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Overall Score
                  </h3>
                  <ScoreBar score={mockScorecard.overall_score} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                  <div style={S.contentCard}>
                    <h3 style={{ fontSize: 13, fontWeight: 700, color: "#4ADE80", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      ✓ Strengths
                    </h3>
                    {mockScorecard.strengths?.map((s, i) => (
                      <div key={i} style={{
                        fontSize: 13, color: "var(--text)", marginBottom: 6, paddingLeft: 12,
                        borderLeft: "2px solid #4ADE8044", lineHeight: 1.5
                      }}>
                        {s}
                      </div>
                    ))}
                  </div>
                  <div style={S.contentCard}>
                    <h3 style={{ fontSize: 13, fontWeight: 700, color: "#FBBF24", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      ↗ Improve
                    </h3>
                    {mockScorecard.improvements?.map((s, i) => (
                      <div key={i} style={{
                        fontSize: 13, color: "var(--text)", marginBottom: 6, paddingLeft: 12,
                        borderLeft: "2px solid #FBBF2444", lineHeight: 1.5
                      }}>
                        {s}
                      </div>
                    ))}
                  </div>
                </div>

                {mockScorecard.per_question?.length > 0 && (
                  <div style={S.contentCard}>
                    <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--accent2)", marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Per-Question Breakdown
                    </h3>
                    {mockScorecard.per_question.map((q, i) => (
                      <div key={i} style={{
                        marginBottom: 16, paddingBottom: 16,
                        borderBottom: i < mockScorecard.per_question.length - 1 ? "1px solid var(--border)" : "none"
                      }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-bright)", marginBottom: 6 }}>
                          Q{i + 1}: {q.question_summary}
                        </div>
                        <ScoreBar score={q.score} />
                        <p style={{ fontSize: 12, color: "#7B8BA8", marginTop: 6, lineHeight: 1.5 }}>
                          {q.feedback}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {mockScorecard.final_tip && (
                  <div style={{ ...S.contentCard, borderColor: "var(--accent)" + "44", marginTop: 12 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 20 }}>💡</span>
                      <div>
                        <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", marginBottom: 4, textTransform: "uppercase" }}>
                          Pro Tip
                        </h3>
                        <p style={{ fontSize: 14, color: "var(--text-bright)", lineHeight: 1.6 }}>
                          {mockScorecard.final_tip}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ textAlign: "center", marginTop: 20 }}>
                  <button onClick={resetMock} className="hover-lift hover-glow" style={S.btnPrimary}>
                    Try Again →
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div style={S.footer}>
          <p>Built by <strong>Prasanna Warad</strong> · Powered by <strong>Gemini 2.5 Flash</strong></p>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───
const S = {
  wrapper: {
    minHeight: "100vh",
    background: "var(--bg)",
    fontFamily: "'Manrope', sans-serif",
    color: "var(--text)",
    padding: "28px 16px",
  },
  container: { maxWidth: 860, margin: "0 auto" },

  header: { textAlign: "center", marginBottom: 24 },
  logoRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 4 },
  logoMark: {
    width: 40, height: 40, borderRadius: 10,
    background: "linear-gradient(135deg, #E8A838, #D97706)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 20, color: "#0A0D16",
  },
  title: {
    fontFamily: "'Space Mono', monospace", fontSize: 28, fontWeight: 700,
    color: "var(--text-bright)", letterSpacing: "-0.02em",
  },
  subtitle: { fontSize: 13, color: "#5A6B80", fontWeight: 400, letterSpacing: "0.02em" },
  badge: {
    fontSize: 10, fontWeight: 800, padding: "3px 8px",
    background: "rgba(74,222,128,0.12)", color: "#4ADE80",
    borderRadius: 4, border: "1px solid rgba(74,222,128,0.25)",
    letterSpacing: "0.1em", fontFamily: "'Space Mono', monospace",
  },

  modeRow: { display: "flex", gap: 10, marginBottom: 16 },
  modeBtn: {
    flex: 1, display: "flex", alignItems: "center", gap: 12,
    padding: "14px 18px", borderRadius: 12,
    border: "1.5px solid var(--border)", background: "transparent",
    fontFamily: "'Manrope', sans-serif", cursor: "pointer",
    transition: "all 0.2s",
  },

  inputCard: {
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 12, padding: "20px", marginBottom: 20,
  },
  inputGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  inputGroup: { flex: 1 },
  label: {
    display: "block", fontSize: 11, fontWeight: 700,
    color: "#5A6B80", textTransform: "uppercase",
    letterSpacing: "0.08em", marginBottom: 5,
    fontFamily: "'Space Mono', monospace",
  },
  input: {
    width: "100%", padding: "10px 14px",
    background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: 8, color: "var(--text-bright)", fontSize: 14,
    fontFamily: "'Manrope', sans-serif",
  },

  btnPrimary: {
    padding: "10px 24px",
    background: "linear-gradient(135deg, #E8A838, #D97706)",
    border: "none", borderRadius: 8,
    color: "#0A0D16", fontSize: 14, fontWeight: 700,
    fontFamily: "'Manrope', sans-serif",
    cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.2s",
  },
  linkBtn: {
    background: "none", border: "none",
    color: "#5A6B80", fontSize: 12, cursor: "pointer",
    fontFamily: "'Manrope', sans-serif", textDecoration: "underline",
  },
  diffBtn: {
    display: "flex", alignItems: "center", gap: 5,
    padding: "7px 12px", borderRadius: 6,
    border: "1px solid var(--border)", background: "transparent",
    fontSize: 12, fontWeight: 600, fontFamily: "'Manrope', sans-serif",
    cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
  },
  activeDot: {
    width: 6, height: 6, borderRadius: "50%", background: "#4ADE80",
    display: "inline-block",
  },

  errorCard: {
    display: "flex", alignItems: "center", gap: 10,
    background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
    borderRadius: 10, padding: "12px 16px", marginBottom: 16,
  },

  loadingBox: { textAlign: "center", padding: "40px 20px" },

  companyCard: {
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 12, padding: "24px", marginBottom: 16,
  },
  companyName: {
    fontFamily: "'Space Mono', monospace", fontSize: 24,
    fontWeight: 700, color: "var(--text-bright)", marginBottom: 4,
  },
  companyTagline: { fontSize: 14, color: "#7B8BA8", fontWeight: 400, marginBottom: 14 },
  metaRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  metaChip: {
    fontSize: 12, padding: "4px 10px",
    background: "var(--surface2)", border: "1px solid var(--border)",
    borderRadius: 16, color: "#7B8BA8",
  },

  tabRow: { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" },
  tab: {
    display: "flex", alignItems: "center", gap: 5,
    padding: "8px 14px", borderRadius: 8,
    border: "1.5px solid transparent", fontSize: 13, fontWeight: 600,
    fontFamily: "'Manrope', sans-serif", background: "transparent",
    cursor: "pointer", transition: "all 0.2s",
  },

  contentCard: {
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 12, padding: "24px",
    lineHeight: 1.75, fontSize: 14, color: "var(--text)",
  },

  emptyState: { textAlign: "center", padding: "50px 20px" },
  emptyTitle: {
    fontFamily: "'Space Mono', monospace", fontSize: 20,
    color: "var(--text-bright)", fontWeight: 700, marginBottom: 8,
  },
  emptyText: {
    fontSize: 14, color: "#5A6B80", maxWidth: 460,
    margin: "0 auto 20px", lineHeight: 1.6,
  },
  chipBtn: {
    padding: "7px 16px", background: "var(--surface)",
    border: "1px solid var(--border)", borderRadius: 16,
    color: "var(--text)", fontSize: 13,
    fontFamily: "'Manrope', sans-serif", cursor: "pointer",
    transition: "all 0.2s",
  },

  // Chat styles
  chatContainer: {
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 12, overflow: "hidden",
  },
  chatHeader: {
    padding: "14px 20px", borderBottom: "1px solid var(--border)",
    background: "var(--surface2)",
  },
  chatAvatar: {
    width: 36, height: 36, borderRadius: 8,
    background: "linear-gradient(135deg, var(--accent2), #2DD4BF)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 18,
  },
  progressBar: {
    height: 3, background: "var(--border)", borderRadius: 2,
    marginTop: 10, overflow: "hidden",
  },
  progressFill: {
    height: "100%", background: "linear-gradient(90deg, var(--accent), var(--accent2))",
    borderRadius: 2, transition: "width 0.5s ease",
  },
  chatBody: {
    padding: "20px", minHeight: 300, maxHeight: 500,
    overflowY: "auto", display: "flex", flexDirection: "column", gap: 12,
  },
  chatBubble: {
    padding: "12px 16px", borderRadius: 10,
    border: "1px solid var(--border)",
  },
  chatInputRow: {
    display: "flex", gap: 10, padding: "14px 20px",
    borderTop: "1px solid var(--border)", background: "var(--surface2)",
  },

  scorecardHeader: {
    textAlign: "center", padding: "24px 20px",
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: 12, marginBottom: 16,
  },

  footer: {
    textAlign: "center", marginTop: 36, padding: "14px",
    fontSize: 11, color: "#3D4A5E",
    borderTop: "1px solid var(--border)",
    fontFamily: "'Space Mono', monospace",
  },
};
