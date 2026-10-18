# TruthLens — Multimodal Media Verification & Synthetic Forensics

TruthLens is an AI-assisted multimodal media verification and deepfake forensic intelligence platform engineered for newsrooms, factual journalists, publishers, and content moderation desks. Ingest media via direct video upload, public YouTube URLs, web articles, or raw text to extract atomic checkable claims, inspect on-screen text (OCR), detect synthetic media artifacts, and verify facts with live Google Search grounding.

---

## Key Capabilities

- **Explore Feed & Mobile-First Player**: Mobile-first video feed player with keyboard navigation, keyframe extractions, chyron inspection, and one-tap dossier inspection.
- **Multimodal Video Intelligence**: Analyzes spoken audio transcripts, on-screen text & chyrons (OCR), temporal scenes, and checkable claims in a single automated workflow.
- **Dedicated YouTube URL Analysis**: Instant analysis of public YouTube videos and Shorts without requiring local file downloads.
- **Article & AI Text Forensics (Article Lab)**: Investigates online articles by URL or pasted copy to assess AI authorship stylometry, clickbait sensationalism scores, and quote attributions.
- **Audio Lab (Configurable)**: Acoustic voice cloning detection, cadence naturalness scoring, and spoken claim extraction (toggleable via configuration).
- **Deepfake & Synthetic Media Forensics**: Evaluates lip-sync divergence, facial warping, synthetic voice cadence, and generative anomalies with risk tier classifications (Low, Moderate, High, Critical).
- **Live Grounded Fact-Checking**: Corroborates claims against authoritative primary reporting using Google Search grounding.
- **Preserved Source References**: Every dossier report permanently stores and displays original article URLs or YouTube video links with one-click copy and direct launch actions.
- **Zero-Cost Historical Browsing & Two-Tier Caching**:
  - Media deduplication via SHA-256 content hashing and YouTube URL canonicalization.
  - Intermediate extraction results (`extractions/{sourceId}`) decouple heavy media processing from text-only search grounding.
  - Browsing existing reports in the Dossier Log or Explore Feed fetches cached Firestore data, consuming **zero AI quota and zero tokens**.
  - On-demand **"Refresh Fact-Check"** (re-ground claims without re-processing media) and **"Full Re-Scan"** (complete forensic re-extraction).
- **Command Hub Analytics**: Executive metrics, verdict breakdowns (Verified, Contradicted, Misleading, Inconclusive), synthetic risk distribution charts, format breakdown bars, and 7-day velocity metrics.
- **Demo Mode Quota Guards**: Built-in daily upload limits (10 uploads/day) with informative user notifications to safeguard shared quota resources.
- **Bring-Your-Own-Key (BYOK) Security**: Secure client-side credential management for Gemini API keys and Vertex AI credentials; keys are never stored on the server or persisted in Firestore/GCS.

---

## Architecture & Codebase Design

The TruthLens codebase is modularized across clear frontend and backend domains:

```
truthlens/
├── backend/
│   ├── lib/
│   │   ├── ai.js              # Gen AI / Vertex SDK clients, model selectors, rate limiting
│   │   ├── config.js          # Environment variables, feature flags, constants
│   │   ├── db.js              # Google Cloud Firestore & Cloud Storage initialization
│   │   ├── pipelines.js       # Video, audio, and article multimodal analysis pipelines
│   │   └── utils.js           # Media hashing, YouTube URL canonicalizer, web scraping
│   ├── package.json           # Backend dependencies (@google/genai, @google-cloud/*, express)
│   └── server.js              # Express API server, HTTP byte-range streaming, upload handler
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ArticleLab.tsx    # Article URL scraper & text stylometry forensic UI
│   │   │   ├── History.tsx       # Dossier Log with multi-format filters & search
│   │   │   ├── Overview.tsx      # Command Hub analytics dashboard with dynamic charts
│   │   │   ├── Phone.tsx         # Mobile video player feed & shortcut controls
│   │   │   ├── ReportModal.tsx   # Detailed investigation dossier modal & source links
│   │   │   ├── Settings.tsx      # BYOK keys, Gemini model picker, search grounding toggle
│   │   │   └── VideoUpload.tsx   # Video dropzone & YouTube analysis section
│   │   ├── api.ts                # Typed client API layer & quota mode configurations
│   │   ├── App.tsx               # Primary application state, routing, and header/footer
│   │   ├── keyframes.ts          # Video frame extraction via HTML5 Canvas
│   │   ├── main.tsx              # React 18 DOM mount
│   │   ├── styles.css            # Design system, glassmorphism tokens, responsive layouts
│   │   └── ui.tsx                # Badges, verdict themes, SVG icon primitives
│   ├── package.json              # React 18, Vite, TypeScript
│   ├── tsconfig.json             # TypeScript configuration
│   └── vite.config.ts            # Vite bundler with /api proxy to port 8080
│
├── Dockerfile                 # Multi-stage production container build
├── deploy.sh                  # Idempotent Google Cloud Run & GCP deployer
├── ARCHITECTURE.md            # GCP services cloud architecture & security diagram (Mermaid)
├── PROCESS_FLOW.md            # Multimodal verification & caching process flow diagram (Mermaid)
├── AGENTS.md                  # System architecture, quota rules, and agent standards
├── CLAUDE.md                  # Claude Code cheatsheet
└── README.md                  # Project documentation
```

> **Visual Diagrams**:
> - Detailed GCP service topology & security boundary: **[ARCHITECTURE.md](./ARCHITECTURE.md)**
> - Full end-to-end verification lifecycle & decision tree: **[PROCESS_FLOW.md](./PROCESS_FLOW.md)**

### Verification Pipeline Topology

```
                  ┌──────────────────────────────────────────────┐
                  │          Input: Video / YouTube / Article    │
                  └──────────────────────┬───────────────────────┘
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
         Direct Media Upload                        URL / Web Ingestion
       (SHA-256 Deduplication)                     (URL Canonicalization)
                    │                                         │
                    └────────────────────┬────────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │ Check Existing Extraction / Report    │
                     └───────────────────┬───────────────────┘
                                         │
                         ┌───────────────┴───────────────┐
                         ▼                               ▼
                 [Cached Report]                [New Investigation]
                 Instant Display                         │
                (Zero Token Cost)                        ▼
                                         ┌───────────────────────────────┐
                                         │ Step 1: Multimodal Extraction │
                                         │   - Spoken Speech Transcript  │
                                         │   - On-Screen Chyrons (OCR)   │
                                         │   - Synthetic Media Forensics │
                                         │   - Checkable Claim Isolation │
                                         └───────────────┬───────────────┘
                                                         │
                                                         ▼
                                         ┌───────────────────────────────┐
                                         │ Step 2: Live Grounding Search │
                                         │   - Google Search Verification│
                                         │   - Authoritative Citations   │
                                         │   - Per-Claim Verdicts        │
                                         └───────────────┬───────────────┘
                                                         │
                                                         ▼
                                         ┌───────────────────────────────┐
                                         │ Firestore: reports/{id}       │
                                         │ Original source links saved   │
                                         └───────────────────────────────┘
```

---

## Running TruthLens Locally

The TruthLens stack runs locally without deploying to Cloud Run. The backend connects directly to Google Cloud Firestore and Cloud Storage using Google Cloud Application Default Credentials (ADC).

### 1. Prerequisites
- **Node.js**: v20 or newer (`node -v`)
- **Google Cloud SDK**: `gcloud` CLI installed and authorized
- **GCP Resources**:
  - Cloud Storage API enabled
  - Firestore in Native mode (`(default)` database)
  - Cloud Storage bucket for video uploads

### 2. Authenticate with Google Cloud
Authenticate your local environment with Application Default Credentials (ADC):
```bash
gcloud auth application-default login
```
Set your active project:
```bash
gcloud config set project YOUR_PROJECT_ID
```

*(Create a private GCS bucket if one does not exist yet:)*
```bash
gcloud storage buckets create gs://YOUR_PROJECT_ID-truthlens-videos --location=us-central1
```

### 3. Configure Local Environment (`.env`)
Create a `.env` file in the root directory (or in `backend/.env`):
```ini
# Google Cloud Project ID
PROJECT_ID=your-google-cloud-project-id
GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id

# Google Cloud Storage bucket for uploaded media
BUCKET=your-google-cloud-project-id-truthlens-videos

# Firestore Database ID (defaults to "(default)")
FIRESTORE_DATABASE_ID=(default)

# Fallback Gemini API Key (optional - users can provide keys in UI Settings)
GEMINI_API_KEY=

# Default Fallback Model
MODEL=gemini-3.8-flash

# Feature Flags
FEATURE_AUDIO_ENABLED=false

# API Server Port
PORT=8080
```

### 4. Start Backend Server
In your first terminal:
```bash
cd backend
npm install
node server.js
```
The server will start on `http://localhost:8080`.

### 5. Start Frontend Dev Server
In a second terminal:
```bash
cd frontend
npm install
npm run dev
```
The Vite development server will start on `http://localhost:5173` with automatic reverse proxying for all `/api` endpoints.

---

## Production Deployment to Google Cloud Run

To build and deploy TruthLens to production on Google Cloud Run:
```bash
bash deploy.sh
```

The idempotent deployment script:
1. Enables required GCP APIs: `run.googleapis.com`, `firestore.googleapis.com`, `storage.googleapis.com`, and `cloudbuild.googleapis.com`.
2. Verifies or creates the Firestore database and GCS bucket.
3. Grants required IAM roles (`roles/datastore.user`, `roles/storage.objectAdmin`).
4. Builds the multi-stage Docker container (packaging the Vite static build inside Express).
5. Deploys to Cloud Run with `--no-cpu-throttling` to ensure background multimodal analysis tasks execute reliably to completion.

---

## Configuration Reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROJECT_ID` | Yes | `(ADC project)` | Google Cloud Project ID for Firestore and GCS |
| `BUCKET` | Yes | — | Private GCS bucket name for uploaded media storage |
| `FIRESTORE_DATABASE_ID` | No | `(default)` | Firestore database ID |
| `GEMINI_API_KEY` | No | — | Server fallback API key; client-supplied BYOK keys always take precedence |
| `MODEL` | No | `gemini-3.8-flash` | Server fallback model when no client model header is provided |
| `FEATURE_AUDIO_ENABLED` | No | `false` | Enables or disables the Audio Lab acoustic forensics module |
| `PORT` | No | `8080` | Express API port |

---

## Safety, Quota & Verification Guardrails

1. **Zero Credential Persistence**:
   User-entered API keys (`x-ai-key`) are strictly held in client browser memory / session storage. Keys are never logged, stored in Firestore, written to GCS, or transmitted to third parties.
2. **Quota & Rate Limit Protection**:
   - Concurrency is throttled per container via an active slot semaphore (`acquireSlot()`).
   - Rate limit errors (HTTP 429) immediately return descriptive diagnostics rather than causing unthrottled infinite retry loops.
   - intermediate video extractions are cached to ensure historical report browsing is zero-cost.
   - Demo upload limits (10 uploads/day) safeguard shared quota resources.
3. **Forensic Integrity Disclaimers**:
   Reports clearly separate evidence-grounded claim checks from physical deepfake assertions. When visual forensics are not conclusive, limitations are explicitly published in the investigation dossier.
4. **Original Source Traceability**:
   Original source links (articles, YouTube videos) are saved directly in report records and displayed in dossier modals and history logs to enable full editorial auditability.
