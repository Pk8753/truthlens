# Claude Code Guidance — TruthLens

Refer to [AGENTS.md](file:///c:/Users/khanm/code/ai-builder-cup/truthlens/AGENTS.md) for complete architecture, conventions, security rules, and engineering standards.

## Quick Reference Commands
- **Backend syntax check**: `node --check backend/server.js`
- **Frontend build test**: `npm run build --prefix frontend`
- **Start backend**: `node backend/server.js` (Requires `GOOGLE_CLOUD_PROJECT` & `BUCKET`)
- **Start frontend**: `npm run dev --prefix frontend`
- **Deploy**: `bash deploy.sh`

## Core Guidelines
- **API Key Safety**: Never store, log, or persist visitor API keys in Firestore or Cloud Storage.
- **Error Sanitization**: Ensure API keys are redacted from error output before sending responses to the client.
- **Multimodal Transparency**: Distinguish clearly between evidence-based verification and forensic authenticity. Reports must explicitly detail pipeline limitations.
- **Quota & Cost Guardrails**: Protect RPM, TPM, and TPD. Never auto-retry 429 quota exhaustion errors. Use two-tier caching to separate heavy video extraction from text fact-checking.
- **Deduplication & Zero-Cost Browsing**: Opening historical reports must strictly read cached records and never make GenAI calls. Re-analysis must only trigger from explicit user action within the report view. Deduplicate all uploads via SHA-256 and URLs via canonical normalization.
- **Frontend Code Quality**: Maintain TypeScript types and ensure UI states (loading, error, empty, active) are handled cleanly without placeholders.

