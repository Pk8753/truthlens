# TruthLens transcript and key-frame report patch

## Files in this bundle
- `frontend/src/App.tsx` — adds a “Transcript & key frames” section at the bottom of each completed report. It displays the transcript returned by the backend and, for videos stored in the feed, extracts up to four real representative frames in the browser from the app's same-origin `/api/video/:id` endpoint.
- `backend/server.js` — asks Gemini to return a best-effort near-verbatim transcript (up to 5,000 characters), stores it with the report, keeps the existing two-call flow, and increments `PIPELINE_VERSION` so old completed reports are regenerated.
- `AGENTS.md` — persistent project instructions for Codex and Antigravity.
- `CLAUDE.md` — directs Claude Code to the shared project instructions.

## Apply the patch
From the existing repository root, replace:

- `frontend/src/App.tsx`
- `backend/server.js`

Then run the checks below from the repository root or the corresponding subdirectories. Existing `package.json`, package lockfiles, CSS, Dockerfile, and deploy scripts are intentionally not included or overwritten by this patch.

## Checks
- Backend syntax: `node --check backend/server.js`
- Frontend build: run the existing build script shown by `frontend/package.json` (for example, `npm run build` if that script exists).

## Behaviour and limitations
- Analysis continues to use at most two Gemini requests when claims are found, and one when no checkable spoken claims are found. No automatic retry is added for quota errors.
- The transcript is an AI-generated, best-effort transcription; inspect it for recognition mistakes.
- Uploaded/feed videos use the browser to create up to four small JPEG screenshots in memory while the report is open. Those images are not sent to Gemini and are not persisted in Firestore.
- For public YouTube URL analyses, the transcript is displayed, but actual screenshot extraction is not attempted because this patch does not download the YouTube video. The UI calls that out instead of misrepresenting the standard YouTube thumbnail as an extracted key frame.
- This change improves observability and gives a reviewer source text/frames to inspect. It does not add OCR, visual claim verification, or deepfake-forensics.
- No live Gemini request, browser end-to-end test, or Cloud Run deployment was performed as part of creating this patch.
