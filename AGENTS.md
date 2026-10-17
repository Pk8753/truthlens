# TruthLens — Agent & Developer Guide

## System Overview
TruthLens is a multimodal AI-assisted video verification and synthetic media analysis platform engineered for newsrooms, publishers, and content moderation desks. The application ingests video content (via direct file upload or public video URLs), extracts audial, visual, and textual evidence, assesses claims against grounded real-world sources, and delivers structured credibility reports.

### Architecture Topology
- **Frontend**: React 18 + TypeScript SPA built with Vite. Implements mobile-first video feed player, analysis modal, keyframe visualizer, URL investigator, and investigative history.
- **Backend API**: Node.js (ES Modules) Express server on Google Cloud Run (`backend/server.js`). Handles video streaming with HTTP byte-range requests from Cloud Storage, file uploads, Gemini/Vertex AI orchestration, and Firestore persistence.
- **Storage & State**:
  - **Google Cloud Storage (GCS)**: Stores raw video files (`uploads/<sha256>`, `demo/`) in private bucket with streaming via signed/proxied endpoints.
  - **Google Cloud Firestore**: Persists post metadata (`posts/{id}`) and analysis reports (`reports/{id}`).
  - **Google GenAI / Vertex AI**: Multimodal reasoning, claim extraction, and Google Search grounded fact-checking.
- **Packaging & Deployment**: Multi-stage `Dockerfile` (builds Vite frontend into static assets served at `/public`, runs Express) deployed via `deploy.sh` to Cloud Run with `--no-cpu-throttling`.

---

## Repository Structure
```
truthlens/
├── backend/
│   ├── package.json       # Backend dependencies (@google/genai, @google-cloud/*, express)
│   └── server.js          # Unified Express API, video streaming, and AI pipeline
├── frontend/
│   ├── index.html         # HTML shell
│   ├── package.json       # React, Vite, TypeScript
│   ├── tsconfig.json      # Strict TS configuration
│   ├── vite.config.ts     # Dev server proxying /api to port 8080
│   └── src/
│       ├── App.tsx        # Core UI, feed scroller, video frames extractor, modals
│       ├── main.tsx       # React root mount
│       └── styles.css     # Design system, glassmorphism, responsive styles
├── Dockerfile             # Multi-stage production build container
├── deploy.sh              # Idempotent GCP deployment script (APIs, GCS, Firestore, Cloud Run)
├── AGENTS.md              # Instructions for AI agents (Codex, Antigravity, Claude)
├── CLAUDE.md              # Entrypoint reference for Claude Code
└── README.md              # User and deployment documentation
```

---

## Core Operational Commands

### Local Development
```bash
# Authenticate Google Cloud application default credentials
gcloud auth application-default login

# Backend (runs on http://localhost:8080)
cd backend
npm install
export GOOGLE_CLOUD_PROJECT="your-project-id"
export BUCKET="your-project-id-truthlens-videos"
node server.js

# Frontend (runs on http://localhost:5173 with proxy to :8080)
cd ../frontend
npm install
npm run dev
```

### Verification & Syntax Checking
```bash
# Check backend syntax
node --check backend/server.js

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
   - Sanitize error messages returned to clients using `clean(err, key)` so raw credentials are never leaked.

2. **Multimodal Analysis Guardrails**:
   - Distinguish strictly between confidence of evidence vs factual certainty. Confidence in reports represents the strength and consistency of available evidence, not mathematical proof.
   - When forensic authenticity/deepfake analysis is not actively executed, reports must explicitly disclose limitations in `limitations` (e.g. "Visual-only claims, on-screen text, and audio/video forensic authenticity were not assessed").
   - Do not claim a video is a deepfake or authentic without verified forensic signals or primary ground truth.

3. **Quota & Rate Limit Protection (RPM, TPM, TPD & Cost)**:
   - Do not add unthrottled automatic retries on 429 quota errors; rate limits must surface immediately with actionable diagnostics to prevent user quota exhaustion.
   - Guard against RPM and TPM spikes: cap concurrent Gemini executions per container (`p-limit`), strictly enforce video duration limits (max 120s), and cap claims extracted (`MAX_CLAIMS = 5`).
   - Bound output token limits (`maxOutputTokens: 1500-2000`) and enforce strict JSON schemas to avoid token waste.
   - Employ two-tier caching: decouple heavy video multimodal extraction from lightweight text-only search grounding so claim re-checks consume zero video tokens.

4. **Deduplication & Zero-Cost Historical Browsing**:
   - Ingested files must be deduplicated via SHA-256 content hashing; identical files must return existing records without re-uploading or triggering redundant analyses.
   - URLs must be canonicalized (stripping tracking parameters and normalizing platform paths) to ensure deterministic source ID generation.
   - **Historical Report Browsing Must Be Zero-Cost**: Opening an existing report or clicking "View Report" from the Explore Feed or History MUST ONLY fetch cached Firestore data (`GET /api/reports/:id`). It must NEVER trigger an AI analysis request.
   - Re-analysis must only happen via an explicit, intentional user action inside the Report modal with user confirmation.

5. **Async & Container Reliability**:
   - Cloud Run requires `--no-cpu-throttling` when processing background jobs after sending HTTP responses.
   - Keep uploads bounded (enforce max size in both frontend and backend raw parser, e.g., 25-30 MB for direct Cloud Run payloads, or use GCS Direct Signed Uploads for high-volume media).

