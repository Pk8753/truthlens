import fs from 'fs';

// Auto-load .env config for local development if present
if (typeof process.loadEnvFile === 'function') {
  if (fs.existsSync('.env')) {
    try { process.loadEnvFile('.env'); } catch { }
  } else if (fs.existsSync('../.env')) {
    try { process.loadEnvFile('../.env'); } catch { }
  }
}

export const PROJECT_ID = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
export const BUCKET = process.env.BUCKET;
export const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
export const MODEL = process.env.MODEL || 'gemini-3.5-flash';
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const PIPELINE_VERSION = 'multimodal-intelligence-v5';
export const MAX_CLAIMS = 5;

// Per-day upload limits (10 videos + 10 audio)
export const DAILY_UPLOAD_LIMIT = 10;

// Config flags – toggled via env vars (default: audio disabled)
export const FEATURE_AUDIO_ENABLED = process.env.FEATURE_AUDIO_ENABLED === 'true';

// Free-tier safe concurrency & request pacing (15 RPM = 1 req every 4s)
export const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 1;
export const MIN_REQUEST_INTERVAL_MS = Number(process.env.MIN_REQUEST_INTERVAL_MS) || 4200;

// Map legacy/custom UI model IDs cleanly to valid AI Studio production models
export const MODEL_ALIASES = {
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
};

export const VERDICTS = 'Supported | Contradicted | Misleading | Mixed | Insufficient Evidence';
export const VALID_VERDICTS = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);
