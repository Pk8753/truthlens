# TruthLens — MerlionMinds Project

AI-powered video verification. Pick a video from the feed (or paste a public YouTube URL), and Gemini extracts the factual claims, checks them against live sources, and returns a credibility report with links.

## Features
- Phone-style Explore Feed with upload, playback and one-tap analysis
- Analyse by URL (public YouTube)
- Specialist agents (health, engineering/science, general) with Google Search grounding
- Five verdicts: Supported, Contradicted, Misleading, Mixed, Insufficient Evidence
- Reports cached in Firestore, browsable in History
- Bring-your-own key (Gemini or Vertex AI express key) via Settings; keys are never stored server-side

## Architecture
React + TypeScript (Vite) frontend, served by one Express service on Cloud Run. Firestore stores posts and reports. A private Cloud Storage bucket holds videos, streamed through the API. Gemini does the analysis.

```
backend/   Express API (server.js)
frontend/  React + Vite UI
Dockerfile Builds the frontend and bundles it into the API image
```

## Run locally
```bash
gcloud auth application-default login
cd backend && npm install
export GOOGLE_CLOUD_PROJECT=your-project BUCKET=your-bucket
node server.js                      # API on :8080
cd ../frontend && npm install && npm run dev   # UI on :5173 (proxies /api)
```

## Deploy to Google Cloud Run
```bash
PROJECT_ID=$(gcloud config get-value project)
BUCKET=${PROJECT_ID}-truthlens-videos
SA=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com
gcloud firestore databases create --location=us-central1
gcloud storage buckets create gs://$BUCKET --location=us-central1 --uniform-bucket-level-access
for R in datastore.user storage.objectAdmin; do
  gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:$SA --role=roles/$R
done

gcloud run deploy truthlens --source . --region us-central1 --allow-unauthenticated \
  --max-instances 2 --memory 1Gi --no-cpu-throttling --timeout=300 \
  --set-env-vars BUCKET=$BUCKET
```
Open the service URL, click the gear icon, paste a Gemini key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), and use **Test with server**.

## Configuration
| Variable | Purpose |
|---|---|
| `BUCKET` | Cloud Storage bucket for uploaded videos (required) |
| `MODEL` | Gemini model, default `gemini-2.5-flash` |
| `GEMINI_API_KEY` | Optional server fallback key; a visitor's own key always takes priority |

## Notes and limits
- `--no-cpu-throttling` is required so analysis continues after the API replies.
- Keep clips short (under ~18 MB, 2 minutes). Uploads are capped at 30 MB by Cloud Run.
- Only public YouTube URLs are supported; the server never fetches arbitrary URLs.
- The service is open to anyone with the URL and has no rate limiting. Keep it private for demos, or add authentication before sharing.
- Confidence reflects the strength of the evidence, not certainty that a claim is true or false.

## Cleanup
```bash
gcloud run services delete truthlens --region us-central1 --quiet
gcloud storage rm -r gs://$BUCKET
```

## Push to GitHub
```bash
git init && git add . && git commit -m "TruthLens"
git branch -M main
git remote add origin https://github.com/YOUR_USER/truthlens.git
git push -u origin main
```
Never commit API keys. Add secrets as Cloud Run environment variables instead.
