# DocuMind AI

**DocuMind AI** is a full-stack, bilingual (**English & Nepali Devanagari**) document intelligence platform featuring hybrid Retrieval-Augmented Generation (RAG), split-pane document reading and chat, optical character recognition (OCR), cross-document research synthesis, an interactive study studio, and installable Progressive Web App (PWA) support.

---

## Key Features

### 1. Document Studio & Multimodal Chat
- **Split-Pane Workspace**: Inspect documents alongside an AI chat stream with clickable `[Source N]` page citations that jump directly to the cited page and excerpt.
- **Text, Image & Original PDF Views**: Switch between extracted text, table views, generated summaries/outlines, visual image + OCR view, and inline PDF view.
- **Highlight-to-Act**: Highlight any passage in the document reader to trigger **Explain**, **Summarise**, or **Rewrite** directly in chat.
- **Multimodal Image Q&A**: Attach `PNG`, `JPEG`, `WebP`, or `GIF` images (up to 4 MB) directly inside the Studio chat composer, or query consented uploaded image documents visually.
- **Voice Input & Read-Aloud**: Speech-to-text transcription (`gemini-3.5-transcribe` / browser Web Speech fallback) and text-to-speech playback controls.
- **Quick Upload & Remove**: Drag-and-drop or select multiple files (up to 25 MB each), monitor processing status, retry OCR, and remove files directly from Studio or the Document Library.

### 2. Supported File Formats (32 Extensions)
- **Documents & E-Books**: `.pdf`, `.docx`, `.doc`, `.odt`, `.rtf`, `.epub`, `.pptx` (including speaker notes)
- **Spreadsheets & Structured Data**: `.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`, `.html`, `.htm`, `.txt`, `.md`, `.json`, `.xml`, `.yaml`, `.yml`, `.log`, `.ini`, `.toml`, `.sql`
- **Images & Vector Diagrams**: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.tiff`, `.tif`, `.svg`
- **OCR Engine**: Cloud Vision OCR via Gemini when consented, with local `tesseract.js` (`eng` + `nep`) OCR fallback. Never silently marks an unreadable scan as ready.

### 3. Hybrid Search, RAG & Bilingual Nepali Support
- **Hybrid Retrieval**: Combines SQLite **FTS5** keyword search with vector cosine similarity (`gemini-embedding-2` or local Ollama embeddings).
- **Nepali Devanagari Unicode**: Detects English, Nepali, and mixed-language documents cleanly and supports Unicode PDF export rendering.

### 4. Online, Offline & Automatic AI Modes
- **Automatic Mode (Default)**: Uses Online Gemini when explicit cloud consent is granted and falls back to Local Ollama when configured and reachable.
- **Online Mode (Gemini)**: Uses `@google/genai` server-side (`gemini-4-hydrogen` with automatic fallback to `gemini-3.1-flash-lite` during high-demand spikes, `gemini-embedding-2`, `gemini-3.5-transcribe`).
- **Offline Mode (Ollama)**: Runs strictly against your local Ollama endpoint (default `http://127.0.0.1:11434`) without sending private documents to the cloud.
- **Workspace Usage Metering**: Tracks per-user Gemini API requests, input/output tokens, and `429` quota events in SQLite (`gemini_usage_logs`) with billing transparency in **Settings & Account**.

### 5. Research Assistant & Study Studio
- **Document Research Assistant**: Cross-document passage search, comparison matrices, contradiction detection, reference extraction, and synthesized research reports.
- **AI Study Assistant**: Generates MCQs with automated grading & weak-topic tracking, interactive flip flashcards, short/long Q&A sets, revision notes, chapter notes, and study plans.
- **Multi-Format Exports**: Export summaries, study sets, and research reports to **PDF**, **DOCX**, **Markdown**, **TXT**, or **CSV**.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend** | React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, `vite-plugin-pwa` |
| **Backend** | Node.js, Express, `tsx`, `multer`, `express-rate-limit`, `cookie-parser` |
| **Database & Search** | SQLite (`better-sqlite3` with WAL mode & FTS5 full-text search) |
| **AI SDK & Local LLM** | `@google/genai` (server-side only), Ollama REST API |
| **Document Parsers & OCR** | `pdfjs-dist`, `mammoth`, `xlsx`, `jszip`, `tesseract.js` |
| **Document Exports** | `pdfkit`, `docx` |

---

## Project Structure

```text
.
├── index.html                  # App HTML entry point & SEO metadata
├── metadata.json               # App capabilities & microphone permissions
├── package.json                # Dependencies and npm scripts
├── server.ts                   # Express + Vite dev/prod server entry point (port 3000)
├── vite.config.ts              # Vite, React, Tailwind v4, and PWA manifest config
├── .env.example                # Environment variable template
├── server/
│   ├── ai.ts                   # Gemini SDK client, retry/fallback router, Ollama client & usage metering
│   ├── auth.ts                 # scrypt password hashing, HTTP-only sessions & guest isolation
│   ├── db.ts                   # SQLite schema, WAL, FTS5 tables, and audit/usage logs
│   ├── exports.ts              # PDF, DOCX, Markdown, TXT, CSV export generators
│   ├── ingestion.ts            # 32-format text/table extraction, OCR & chunk indexing
│   ├── rag.ts                  # Hybrid FTS5 + embedding retrieval & multimodal RAG
│   └── routes.ts               # REST API routes (/api/*)
├── src/
│   ├── App.tsx                 # Main shell, theme toggle, navigation & consent modals
│   ├── types.ts                # Shared TypeScript interfaces
│   ├── lib/api.ts              # Typed API client, XHR upload progress & error classifiers
│   └── components/
│       ├── AuthModal.tsx       # Sign in & create account dialog
│       ├── CloudConsentModal.tsx # Explicit per-document / workspace Cloud AI prompt
│       ├── OfflineIndicator.tsx
│       ├── PWAInstallButton.tsx
│       ├── ToastProvider.tsx   # Actionable toast notification system
│       ├── VoiceControls.tsx   # Microphone capture & speech playback
│       └── Views/
│           ├── StudioView.tsx          # Split document reader + multimodal AI chat
│           ├── DocumentsView.tsx       # Drag-and-drop upload, folders, retry & removal
│           ├── ResearchView.tsx        # Hybrid passage search, comparison & reports
│           ├── StudyView.tsx           # Quizzes, flashcards, notes & weak-topic analytics
│           └── SettingsProfileView.tsx # AI modes, Ollama config, Gemini usage & audit logs
└── tests/
    └── documind.test.ts        # Node test suite (auth, Unicode, ingestion, RAG, exports)
```

---

## Environment Configuration

Copy `.env.example` to `.env` before running locally (never commit `.env` to GitHub):

```bash
cp .env.example .env
```

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | For Online AI | Your Google Gemini API key (server-side only; never exposed to the browser) |
| `APP_URL` | Optional | Public URL where the app is hosted |
| `SESSION_SECRET` | Recommended in Prod | Secret used to sign HTTP-only session cookies |
| `OLLAMA_BASE_URL` | Optional | Local Ollama URL for Offline mode (defaults to `http://127.0.0.1:11434`) |
| `SQLITE_DB_PATH` | Optional | Custom SQLite database file path (defaults to `./data/documind.db`) |

---

## Getting Started (Local Development)

### Prerequisites
- **Node.js** `>= 20` (tested on Node 22)
- **npm**
- Optional: [Ollama](https://ollama.com) running locally if you want 100% offline inference (e.g. `ollama pull llama3.2`)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run in Development Mode
Starts the Express API server and Vite middleware on port `3000`:
```bash
npm run dev
```
Open `http://localhost:3000` in your browser.

### 3. Type Check & Build for Production
```bash
npm run lint
npm run build
npm start
```

### 4. Run Automated Tests
```bash
npx tsx --test tests/documind.test.ts
```

---

## Uploading This Project to Your GitHub Account

If you do not yet see this project in your GitHub account, export/download the project workspace or push it from your local terminal to a new GitHub repository:

```bash
# 1. Verify sensitive/local files (.env*, data/, node_modules/, dist/) are ignored in .gitignore

# 2. Initialize Git (if not already initialized) and commit
git init
git add .
git commit -m "Initial commit: DocuMind AI"

# 3. Create an empty repository on GitHub, then link and push
git branch -M main
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
git push -u origin main
```

---

## Security & Privacy Design

- **Server-Side API Keys**: `GEMINI_API_KEY` is read strictly on the Node.js server from `process.env` and is never bundled into frontend assets.
- **Explicit Cloud Consent**: Uploaded documents remain local until the user explicitly grants Cloud AI consent per document or in workspace defaults.
- **Prompt Injection Defense**: Retrieved document chunks are isolated inside `<untrusted_document_content>` boundaries with system-level grounding instructions.
- **Sandboxed File Previewing**: Inline `.svg` and `.html` files streamed via `/api/documents/:id/raw` include `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy` (`default-src 'none'`).
- **Workspace Isolation**: Guest and authenticated accounts use HTTP-only signed session cookies (`scrypt` salted password hashes for registered accounts), and all SQLite queries scope reads/writes strictly to `user_id`.

---

## License

Apache-2.0
