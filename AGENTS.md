# TruthLens — Agent & Developer Guide

## System Overview
TruthLens is a multimodal AI-assisted media verification and synthetic forensics intelligence platform engineered for newsrooms, publishers, and content moderation desks. The platform ingests multimodal media (direct video file uploads, public YouTube links, web articles, raw text, and audio streams), extracts audial, visual, and textual evidence, assesses claims against grounded real-world sources via Google Search, and delivers structured credibility reports.

### Architecture Topology
- **Frontend**: React 18 + TypeScript SPA built with Vite. Implements mobile-first video feed player (`Phone`), detailed investigation modal (`ReportModal`), keyframe visualizer (`keyframes`), dedicated YouTube analyzer (`VideoUpload`), article stylometry inspector (`ArticleLab`), dossier history log (`History`), Command Hub analytics (`Overview`), and BYOK configuration (`Settings`).
- **Backend API**: Node.js (ES Modules) Express server on Google Cloud Run (`backend/server.js`). Features modular libraries (`backend/lib/`) for streaming byte-range video proxying from Cloud Storage, upload rate limiting, GenAI/Vertex orchestration, and Firestore persistence.
- **Storage & State**:
  - **Google Cloud Storage (GCS)**: Stores raw media files (`uploads/<sha256>`, `audio/<sha256>`) in a private bucket with HTTP byte-range streaming proxy.
  - **Google Cloud Firestore**: Persists post metadata (`posts/{id}`), intermediate cached extractions (`extractions/{sourceId}`), finalized analysis reports (`reports/{id}`), and daily IP rate limits (`upload_limits/{ip_date}`).
  - **Google GenAI / Vertex AI**: Multimodal vision, audio transcription, OCR chyron detection, stylometry forensics, and Google Search grounded fact-checking.
- **Packaging & Deployment**: Multi-stage `Dockerfile` (builds Vite frontend into static assets served at `/public`, runs Express) deployed via `deploy.sh` to Cloud Run with `--no-cpu-throttling`.

---

## Repository Structure
```
truthlens/
├── backend/
│   ├── lib/
│   │   ├── ai.js              # Gen AI / Vertex SDK clients, model helpers, error sanitization
│   │   ├── config.js          # Environment variables, feature flags, constants
│   │   ├── db.js              # Firestore & Cloud Storage client initialization
│   │   ├── pipelines.js       # Video, audio, and article multimodal analysis pipelines
│   │   └── utils.js           # Media hashing, YouTube canonicalization, article scraping
│   ├── package.json           # Backend dependencies (@google/genai, @google-cloud/*, express)
│   └── server.js              # Express API endpoints, video byte-range streaming, upload handler
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ArticleLab.tsx    # Web article & AI text stylometry forensic UI
│   │   │   ├── History.tsx       # Dossier Log with multi-format filters & search
│   │   │   ├── Overview.tsx      # Command Hub analytics dashboard with dynamic SVG charts
│   │   │   ├── Phone.tsx         # Mobile video player feed & shortcut controls
│   │   │   ├── ReportModal.tsx   # Detailed investigation dossier modal & source links
│   │   │   ├── Settings.tsx      # BYOK keys, Gemini model picker, search grounding toggle
│   │   │   └── VideoUpload.tsx   # Video dropzone & dedicated YouTube analysis section
│   │   ├── api.ts                # Typed client API layer & quota mode configurations
│   │   ├── App.tsx               # Primary application state, routing, and header/footer
│   │   ├── keyframes.ts          # Video keyframe extraction via HTML5 Canvas
│   │   ├── main.tsx              # React 18 DOM mount
│   │   ├── styles.css            # Design system, glassmorphism tokens, responsive layouts
│   │   ├── types.ts              # Shared domain TypeScript types
│   │   └── ui.tsx                # Badges, verdict themes, SVG icon primitives
│   ├── index.html             # HTML shell
│   ├── package.json           # React, Vite, TypeScript
│   ├── tsconfig.json          # Strict TS configuration
│   └── vite.config.ts         # Dev server proxying /api to port 8080
│
├── ARCHITECTURE.md            # GCP services cloud architecture & security diagram (Mermaid)
├── PROCESS_FLOW.md            # Multimodal verification & caching process flow diagram (Mermaid)
├── Dockerfile                 # Multi-stage production build container
├── deploy.sh                  # Idempotent GCP deployment script (APIs, GCS, Firestore, Cloud Run)
├── AGENTS.md                  # Instructions for AI agents (Codex, Antigravity, Claude)
├── CLAUDE.md                  # Entrypoint reference for Claude Code
└── README.md                  # User and deployment documentation
```

---

## Core Operational Commands

### Local Development
```bash
# Authenticate Google Cloud application default credentials
gcloud auth application-default login

# Backend (runs on http://localhost:8080 - automatically reads root .env or backend/.env)
cd backend
npm install
node server.js

# Frontend (runs on http://localhost:5173 with proxy to :8080)
cd ../frontend
npm install
npm run dev
```

### Verification & Syntax Checking
```bash
# Check backend syntax
node --check backend/server.js && node --check backend/lib/pipelines.js

# Build frontend production bundle
npm run build --prefix frontend
```

### Deployment
```bash
# Deploy to Google Cloud Run
bash deploy.sh
```

---

## Key Conventions and Guardrails

1. **Security & API Keys**:
   - Never log, persist, or store user API keys in Firestore, GCS, or server logs.
   - User-supplied keys (`x-ai-key` and `x-ai-provider: gemini|vertex`) must always take precedence over server fallback keys (`GEMINI_API_KEY`).
   - Sanitize all error messages returned to clients using `publicAiError(err, key)` so raw credentials are never leaked.

2. **Multimodal Analysis Guardrails**:
   - Distinguish strictly between confidence of evidence vs factual certainty. Confidence in reports represents the strength and consistency of available evidence, not mathematical proof.
   - When forensic authenticity/deepfake analysis is not actively executed, reports must explicitly disclose limitations in `limitations`.
   - Do not claim a media item is a deepfake or authentic without verified forensic signals or primary ground truth.

3. **Quota & Rate Limit Protection (RPM, TPM, TPD & Cost)**:
   - Do not add unthrottled automatic retries on 429 quota errors; rate limits must surface immediately with actionable diagnostics to prevent user quota exhaustion.
   - Guard against RPM and TPM spikes: cap concurrent Gemini executions per container via concurrency slot semaphore (`acquireSlot()`), strictly enforce video duration limits (max 120s), and cap claims extracted (`MAX_CLAIMS = 5`).
   - Bound output token limits (`maxOutputTokens: 1500-2500`) and enforce strict JSON schemas to avoid token waste.
   - Employ two-tier caching: decouple heavy video/audio multimodal extraction (`extractions/{sourceId}`) from lightweight text-only search grounding so claim re-checks consume zero video tokens.
   - **Demo Mode Rate Limits**: Limit uploads to 10 per day per media type per IP address. When exceeded, return HTTP 429 `{ limitReached: true }` and display the Demo Limit popup.

4. **Deduplication & Zero-Cost Historical Browsing**:
   - Ingested files must be deduplicated via SHA-256 content hashing; identical files must return existing records without re-uploading or triggering redundant analyses.
   - URLs must be canonicalized (stripping tracking parameters and normalizing platform paths) to ensure deterministic source ID generation.
   - **Historical Report Browsing Must Be Zero-Cost**: Opening an existing report or clicking "View Report" from the Explore Feed or History MUST ONLY fetch cached Firestore data (`GET /api/reports/:id`). It must NEVER trigger an AI analysis request.
   - Re-analysis must only happen via an explicit, intentional user action inside the Report modal with user confirmation.

5. **Original Source Traceability**:
   - The original source URL (`url`) for YouTube videos, web articles, and external media must be saved to `reports/{id}` in Firestore.
   - The dossier modal (`ReportModal.tsx`) and dossier history cards (`History.tsx`) must display the clickable original source link, a copy-to-clipboard button, and a direct external launch action.

6. **Async & Container Reliability**:
   - Cloud Run requires `--no-cpu-throttling` when processing background jobs after sending HTTP responses.
   - Keep uploads bounded (enforce max size in both frontend and backend raw parser, e.g., 25 MB for direct Cloud Run payloads, or use GCS Direct Signed Uploads for high-volume media).
