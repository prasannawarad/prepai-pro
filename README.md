# PrepAI Pro — AI Interview Intelligence Platform

![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Gemini](https://img.shields.io/badge/Gemini_2.0_Flash-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

🔗 **[Live Demo → prepai-pro.netlify.app](https://prepai-pro.netlify.app)**

**PrepAI Pro** is a high-performance, single-component React application designed to bridge the gap between company research and interview performance. Powered by the **Gemini 2.0 Flash API**, it provides candidates with deep company insights and a high-stakes mock interview environment.

---

## 🚀 What It Does

PrepAI Pro transforms the interview preparation process into a structured, AI-driven workflow. It eliminates the need for manual research by generating deep-dive reports on companies and allows candidates to test their knowledge in a realistic, multi-turn interview simulation.

---

## ✨ Key Features

### 🔍 MODE 1: Company Research
- **Deep Intel**: Instantly fetch structured history, work culture, and recent news for any company.
- **Tailored Tips**: Get actionable interview advice specific to the company and your targeted role.
- **STAR Story Generator**: Paste your resume to have the AI automatically extract your best experiences and map them to the company's core values using the STAR (Situation, Task, Action, Result) method.
- **Tabbed Interface**: Navigate through *History, Culture, News, Tips,* and *STAR Stories* via a clean, interactive UI.

### 🎙️ MODE 2: Mock Interview
- **Difficulty Scaling**: Choose from *Warm-up* (easy), *Standard* (medium), or *Pressure* (hard) levels.
- **Realistic 5-Question Simulation**: A multi-turn conversation where the AI acts as an interviewer from the target company.
- **Adaptive Feedback**: Receive inline encouraging and corrective feedback after every answer.
- **Comprehensive Scorecard**: Get a final grade (1-10), a per-question breakdown, a summary of strengths/improvements, and a "Pro Tip" for your next real interview.

---

## 🧠 Gen AI Patterns Demonstrated

PrepAI Pro leverages advanced Prompt Engineering and LLM orchestration patterns:

| Pattern | Description | Implementation in PrepAI |
| :--- | :--- | :--- |
| **Prompt Chaining** | Sequential logic where one output informs the next stage. | Research → STAR Generator → Interview Context → Final Evaluation |
| **Conversation History** | Maintaining state across multiple LLM turns. | Multi-turn mock interviews with full context retention. |
| **Structured Output** | Enforcing JSON schemas for UI rendering. | Strict JSON parsing with error recovery for research and scorecards. |
| **Context Injection** | Augmenting base prompts with user-specific data. | Injecting Resume text into Gemini prompts for personalized STAR stories. |
| **Temperature Tuning** | Adjusting "creativity" per task. | 0.7 for Research, 0.8 for Interviews (variety), 0.5 for Scoring (precision). |

---

## 🏗️ Architecture

```text
[ USER INPUT ] 
      │
      ▼
[ React UI (App.jsx) ] <───> [ inline CSS System ]
      │
      ├─► [ Research Engine ] ─────► [ Gemini 2.0 Flash API (JSON) ]
      │                                       │
      ├─► [ Mock Interviewer ] <───[ multi-turn dialogue ]───┘
      │
      └─► [ Scoring Aggregator ] ──► [ Evaluation Report ]
```

---

## 🛠️ Tech Stack

- **Frontend**: React 18, Vite
- **AI Core**: Gemini 2.0 Flash API (Free Tier)
- **Styling**: Vanilla CSS-in-JS (React state-based theme)
- **Fonts**: [Google Fonts](https://fonts.google.com/) (Space Mono + Manrope)
- **State Management**: React Hooks (useState, useRef, useEffect, useCallback)

---

## 📂 Project Structure

```bash
prepai-pro/
├── index.html          # Entry HTML & Google Fonts imports
├── src/
│   ├── main.jsx        # App entry & rendering
│   ├── App.jsx         # Core component (Logic, UI, Styles)
│   └── index.css       # Global resets
├── package.json        # Dependencies & scripts
└── README.md           # Project documentation
```

---

## 🚦 Getting Started

### Prerequisites
- Node.js (v18+)
- A **Gemini API Key** (Get one for free at [Google AI Studio](https://aistudio.google.com/))

### Installation
1. Clone the repository or download the files.
2. Navigate to the project folder:
   ```bash
   cd prepai-pro
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

### Running Locally
Run the development server:
```bash
npm run dev
```

---

## 📸 Screenshots
*(Add screenshots here)*

---

## 🗺️ Roadmap
- [ ] **Video/Audio Support**: Real-time speech-to-text for a hands-free mock interview experience.
- [ ] **Resume PDF Parsing**: Direct PDF upload instead of pasting text.
- [ ] **LinkedIn Integration**: Real-time news scraping for even fresher company updates.
- [ ] **Panel Interview Mode**: Multiple AI characters with different personas (e.g., Technical, HR, Manager).
- [ ] **Report Export**: Option to download the final scorecard as a PDF.

---

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Built by [Prasanna Warad](https://linkedin.com/in/prasannawarad)**  
*MS ITM @ The University of Texas at Dallas*
