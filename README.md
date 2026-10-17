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
bash deploy.sh
```
The script uses the active `gcloud` project and deploys to `us-central1` by default. It enables the required APIs, creates the default Firestore database and video bucket only when they do not already exist, grants the Cloud Run service account the required roles, then deploys the service. Override defaults with `PROJECT_ID`, `REGION`, `BUCKET`, or `SERVICE`, for example `PROJECT_ID=my-project REGION=us-east1 bash deploy.sh`.
Open the service URL, click the gear icon, paste a Gemini key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), and use **Test with server**.

## Configuration
| Variable | Purpose |
|---|---|
| `BUCKET` | Cloud Storage bucket for uploaded videos (required) |
| `MODEL` | Server fallback model when no model is sent; default `gemini-3.8-flash`. The frontend model selection takes precedence. |
| `GEMINI_API_KEY` | Optional server fallback key; a visitor's own key always takes priority |

Choose the analysis model in **Settings → Analysis model**. The selection is saved in this browser and used for both key checks and analyses. The available choices are Gemini 3.8 Flash, Gemini 2.5 Flash, Gemini 2.5 Flash Lite, Gemini 3 Flash, Gemini 3.1 Flash Lite, and Gemini 3.5 Flash Lite. Model access depends on the selected provider and project.

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
