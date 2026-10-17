# TruthLens — MerlionMinds Project

AI-powered multimodal video verification and synthetic media analysis platform engineered for newsrooms, publishers, and content moderation desks. Ingest videos via direct file upload or public YouTube URLs to extract claims, detect deepfakes, assess on-screen text (OCR), and verify evidence against live sources using Google Search grounding.

---

## Features
- **Phone-Style Explore Feed**: Mobile-first video feed with instant playback, thumbnail keyframes, and one-tap investigation.
- **Multimodal Video Intelligence**: Analyzes audible speech transcripts, on-screen text & chyrons (OCR), visual scenes, and checkable claims.
- **Synthetic Media & Deepfake Forensics**: Scans for lip-sync lag, facial warping, synthetic voice cadence, and temporal splicing with risk classifications (Low to Critical).
- **Live Grounded Fact-Checking**: Verifies claims against authoritative primary sources using Google Search grounding.
- **Two-Tier Caching & Deduplication**:
  - SHA-256 media hashing and YouTube URL canonicalization prevent duplicate uploads and redundant analyses.
  - Intermediate video extraction is cached (`extractions/{sourceId}`); browsing historical reports consumes **zero AI quota and zero tokens**.
  - On-demand **"Refresh Fact-Check"** (text-only grounding re-search) and **"Full Re-Scan"** options available directly from report view.
- **Bring-Your-Own-Key (BYOK)**: Supports Gemini API keys and Vertex AI keys entered directly in browser Settings; keys are never stored server-side.

---

## Architecture
```
truthlens/
├── backend/          # Express API (Node.js ES modules) & Gemini/Vertex AI pipeline
├── frontend/         # React 18 + TypeScript + Vite UI
├── .env.example      # Template for local environment configuration
├── Dockerfile        # Container build packaging frontend into Express static bundle
├── deploy.sh         # Idempotent Cloud Run & GCP infrastructure deployer
├── AGENTS.md         # Developer & agent guidelines
└── CLAUDE.md         # Claude Code cheatsheet
```

---

## Running TruthLens Locally

You can run the entire TruthLens stack on your local machine without deploying to Cloud Run. The backend connects directly to Google Cloud Firestore and Cloud Storage using your local Google Cloud credentials.

### 1. Prerequisites
- **Node.js**: v20 or newer (`node -v`)
- **Google Cloud SDK**: `gcloud` CLI installed and authorized
- **GCP Resources**: An active Google Cloud project with:
  - Cloud Storage API enabled
  - Firestore in Native mode (`(default)` database)
  - Cloud Storage bucket for video uploads

### 2. Authenticate with Google Cloud
Authenticate your local environment with Application Default Credentials (ADC) so the backend can read/write to Firestore and GCS:
```bash
gcloud auth application-default login
```
Set your active project:
```bash
gcloud config set project YOUR_PROJECT_ID
```

*(If your GCS bucket does not exist yet, create one in your project's region:)*
```bash
gcloud storage buckets create gs://YOUR_PROJECT_ID-truthlens-videos --location=us-central1
```

### 3. Configure Local Environment (`.env`)
Copy `.env.example` to `.env` in the repository root (or in `backend/.env`):
```bash
cp .env.example .env
```

Open `.env` and configure your GCP parameters:
```ini
# Google Cloud Project ID
PROJECT_ID=your-google-cloud-project-id
GOOGLE_CLOUD_PROJECT=your-google-cloud-project-id

# Google Cloud Storage bucket for uploaded videos
BUCKET=your-google-cloud-project-id-truthlens-videos

# Firestore Database ID (defaults to "(default)")
FIRESTORE_DATABASE_ID=(default)

# Fallback Gemini API Key (optional - users can enter their own key in the UI)
GEMINI_API_KEY=

# Default Fallback Model
MODEL=gemini-3.8-flash

# API Server Port
PORT=8080
```

> **Note**: The backend automatically loads `.env` upon startup. No third-party packages or manual export commands are required.

### 4. Start the Backend API
In your first terminal:
```bash
cd backend
npm install
node server.js
```
The server will start on `http://localhost:8080` and log your active Project, Bucket, and Database configuration:
```
TruthLens backend listening on http://localhost:8080
  Project:   your-project-id
  Bucket:    your-project-id-truthlens-videos
  Firestore: (default)
  Fallback:  gemini-3.8-flash
```

### 5. Start the Frontend UI
In a second terminal:
```bash
cd frontend
npm install
npm run dev
```
The Vite development server will start on `http://localhost:5173` and automatically proxy all `/api` requests to the local Express backend on `:8080`.

### 6. Verify Local Setup
1. Open [http://localhost:5173](http://localhost:5173) in your browser.
2. Click the **Gear icon** in the top-right header.
3. Paste a Gemini API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
4. Click **Test with server** to confirm connectivity.
5. Ingest a video via the **Explore Feed**, the **Add a Video** drag-and-drop uploader, or paste a public YouTube link in **Analyse by URL**.

---

## Deploy to Google Cloud Run

To package and deploy TruthLens to production on Google Cloud Run:
```bash
bash deploy.sh
```
The deploy script:
- Enables `run.googleapis.com`, `firestore.googleapis.com`, `storage.googleapis.com`, and `cloudbuild.googleapis.com`.
- Creates the default Firestore database and GCS video bucket if they do not exist.
- Binds IAM roles (`roles/datastore.user`, `roles/storage.objectAdmin`) to the service account.
- Deploys the container with `--no-cpu-throttling` (ensuring background multimodal jobs continue uninterrupted).

Override defaults as needed:
```bash
PROJECT_ID=my-project REGION=us-central1 BUCKET=my-custom-bucket bash deploy.sh
```

---

## Configuration Reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROJECT_ID` | Yes | `(ADC project)` | Google Cloud Project ID for Firestore and GCS |
| `BUCKET` | Yes | — | Private GCS bucket name for uploaded video storage |
| `FIRESTORE_DATABASE_ID` | No | `(default)` | Firestore database ID |
| `GEMINI_API_KEY` | No | — | Server fallback API key; visitors' keys entered in UI Settings always take precedence |
| `MODEL` | No | `gemini-3.8-flash` | Server fallback model when no model header is sent |
| `PORT` | No | `8080` | Express API port |

---

## Notes & Quota Guidelines
- **Zero-Cost Historical Browsing**: Opening an existing report or viewing records from the Explore Feed or History only fetches cached Firestore records. It consumes zero Gemini API tokens.
- **Two-Tier Caching**: The heavy video token cost is incurred only on the initial multimodal extraction. Re-running fact-checks from the report view executes text-only grounding against current news without re-reading the video.
- **Upload Limits**: Video uploads are supported up to 25 MB (clips under 2 minutes work best). Duplicates are recognized by SHA-256 hash.

---

## Cleanup
To remove all deployed resources and Cloud Storage buckets:
```bash
gcloud run services delete truthlens --region us-central1 --quiet
gcloud storage rm -r gs://$BUCKET
```
