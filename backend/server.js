import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';

// Auto-load .env config for local development if present
if (typeof process.loadEnvFile === 'function') {
  if (fs.existsSync('.env')) {
    try { process.loadEnvFile('.env'); } catch { }
  } else if (fs.existsSync('../.env')) {
    try { process.loadEnvFile('../.env'); } catch { }
  }
}

const PROJECT_ID = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const BUCKET = process.env.BUCKET;
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
const MODEL = process.env.MODEL || 'gemini-3.5-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PIPELINE_VERSION = 'multimodal-intelligence-v5';
const MAX_CLAIMS = 5;

// Free-tier safe concurrency & request pacing (15 RPM = 1 req every 4s)
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 1;
const MIN_REQUEST_INTERVAL_MS = Number(process.env.MIN_REQUEST_INTERVAL_MS) || 4200;

// Map legacy/custom UI model IDs cleanly to valid AI Studio production models
const MODEL_ALIASES = {
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
};

const inFlight = new Map();
let activeJobs = 0;
const jobQueue = [];
let lastApiCallTime = 0;
let rateLimitChain = Promise.resolve();

function acquireSlot() {
  return new Promise(resolve => {
    if (activeJobs < MAX_CONCURRENT_JOBS) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  activeJobs--;
  if (jobQueue.length > 0) {
    activeJobs++;
    const next = jobQueue.shift();
    next();
  }
}

// Global Token-Bucket Pacer: Prevents burst 429 errors on AI Studio Free Tier
async function paceRequest(isVertex = false) {
  if (isVertex) return; // Vertex AI pay-as-you-go does not need free-tier pacing
  rateLimitChain = rateLimitChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastApiCallTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastApiCallTime = Date.now();
  });
  return rateLimitChain;
}

const db = new Firestore({
  ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
  databaseId: FIRESTORE_DATABASE_ID,
  ignoreUndefinedProperties: true
});
const gcs = new Storage({
  ...(PROJECT_ID ? { projectId: PROJECT_ID } : {})
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((_, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
process.on('unhandledRejection', e => console.error('unhandled:', String(e?.message || e).slice(0, 300)));

// Express 4 async handler error wrapper
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (routePath, ...hs) => orig(routePath, ...hs.map(fn => fn?.constructor?.name === 'AsyncFunction'
    ? (req, res, next) => fn(req, res, next).catch(e => {
      console.error(m, routePath, String(e?.message || e).slice(0, 300));
      if (!res.headersSent) res.status(500).json({ error: 'Server error: ' + String(e?.message || e).slice(0, 200) });
    })
    : fn));
}

const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const keyOf = req => req.get('x-ai-key') || GEMINI_API_KEY;
const isVertexOf = req => req.get('x-ai-provider') === 'vertex';
const quotaModeOf = req => {
  const m = req.get('x-quota-mode') || req.body?.quotaMode || 'single_pass';
  return ['single_pass', 'two_pass'].includes(m) ? m : 'single_pass';
};
const useSearchOf = req => {
  const h = req.get('x-use-search');
  if (h !== undefined) return h !== 'false';
  if (req.body?.useSearch !== undefined) return Boolean(req.body.useSearch);
  return true;
};
const clientFor = req => {
  const k = keyOf(req);
  return k ? new GoogleGenAI(isVertexOf(req) ? { vertexai: true, apiKey: k } : { apiKey: k }) : null;
};
const modelOf = req => {
  const requested = req.get('x-ai-model');
  if (!requested) return MODEL_ALIASES[MODEL] || 'gemini-2.5-flash';
  return MODEL_ALIASES[requested] || null;
};
const clean = (e, k) => {
  let m = String(e?.message || e);
  if (k) m = m.split(k).join('***');
  return m.slice(0, 300);
};

const PUB = `https://storage.googleapis.com/${BUCKET}/`;
const nameOf = p => p.gcsName || (p.videoUrl?.startsWith(PUB) ? decodeURIComponent(p.videoUrl.slice(PUB.length)) : null);
const VERDICTS = 'Supported | Contradicted | Misleading | Mixed | Insufficient Evidence';
const VALID_VERDICTS = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);

async function toPart(src, isVertex) {
  if (src.youtube) return { fileData: { fileUri: src.youtube, mimeType: 'video/mp4' } };
  if (isVertex && BUCKET && src.name) {
    return { fileData: { fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'video/mp4' } };
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 20 * 1024 * 1024) throw new Error('Video is larger than 20 MB for inline free-tier processing. Use a shorter clip.');
  return { inlineData: { mimeType: src.mime === 'video/quicktime' ? 'video/mov' : (src.mime || 'video/mp4'), data: b.toString('base64') } };
}

async function toAudioPart(src, isVertex) {
  if (src.url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(src.url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Failed to fetch remote audio (HTTP ${resp.status})`);
    const mime = (resp.headers.get('content-type') || 'audio/mp3').split(';')[0];
    const arrayBuffer = await resp.arrayBuffer();
    const b = Buffer.from(arrayBuffer);
    if (b.length > 20 * 1024 * 1024) throw new Error('Remote audio file exceeds 20 MB limit.');
    return { inlineData: { mimeType: mime, data: b.toString('base64') } };
  }
  if (isVertex && BUCKET && src.name) {
    return { fileData: { fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'audio/mp3' } };
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 20 * 1024 * 1024) throw new Error('Audio file exceeds 20 MB limit.');
  return { inlineData: { mimeType: src.mime || 'audio/mp3', data: b.toString('base64') } };
}

function parseJsonResponse(response) {
  const raw = response?.text;
  if (!raw) throw new Error('The AI returned an empty response. Please try again.');
  try { return JSON.parse(raw); }
  catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch { }
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch { }
    }
    throw new Error('The AI returned an invalid structured response. Please retry.');
  }
}

function isQuotaError(e) {
  const s = `${e?.status || ''} ${e?.code || ''} ${e?.message || ''}`.toLowerCase();
  return /429|resource_exhausted|rate.?limit|quota|too many requests/.test(s);
}

function publicAiError(e, key) {
  if (isQuotaError(e)) {
    return 'Gemini Free-Tier Quota reached (RPM/RPD). Enable "Single-Pass Quota Saver" or switch model to Gemini 2.5 Flash Lite in Settings.';
  }
  const status = Number(e?.status || e?.code);
  if (status === 401 || status === 403) {
    return 'The AI key or provider configuration was rejected. Check your key, enabled APIs, and billing status.';
  }
  return clean(e, key);
}

// Resilient Generate with Pacing + Model Auto-Fallback (2.5-flash -> 2.5-flash-lite)
async function generate(ai, model, contents, config = {}, isVertex = false) {
  await paceRequest(isVertex);
  try {
    return await ai.models.generateContent({
      model,
      contents,
      config: { candidateCount: 1, temperature: 0.1, ...config }
    });
  } catch (e) {
    // If primary model hits 429 quota and isn't already on lite fallback, switch to lite pool after brief pause
    if (isQuotaError(e) && model !== FALLBACK_MODEL) {
      console.warn(`Quota reached on ${model}. Auto-falling back to ${FALLBACK_MODEL} after 4.5s cooldown...`);
      await new Promise(r => setTimeout(r, 4500));
      await paceRequest(isVertex);
      return await ai.models.generateContent({
        model: FALLBACK_MODEL,
        contents,
        config: { candidateCount: 1, temperature: 0.1, ...config }
      });
    }
    throw e;
  }
}

function extractGroundingSources(response) {
  const grounding = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return [...new Map(
    grounding.filter(g => g?.web?.uri).map(g => [g.web.uri, { uri: g.web.uri, title: g.web.title || g.web.uri }])
  ).values()].slice(0, 8);
}

async function verifyClaimsWithGrounding(ai, model, promptText, useSearch = true, isVertex = false) {
  let verifyResponse;
  let searchAvailable = useSearch;

  if (useSearch) {
    try {
      // Note: Do NOT combine responseMimeType: 'application/json' with googleSearch tool on AI Studio Free Tier
      verifyResponse = await generate(ai, model, [{
        role: 'user',
        parts: [{ text: `${promptText}\n\nIMPORTANT: Return ONLY raw valid JSON matching the schema with no markdown commentary.` }]
      }], {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 2048
      }, isVertex);
    } catch (e) {
      console.warn('Google Search Grounding unavailable or quota reached. Falling back to internal knowledge base:', e?.message);
      searchAvailable = false;
    }
  }

  if (!verifyResponse) {
    verifyResponse = await generate(ai, model, [{
      role: 'user',
      parts: [{ text: `${promptText}\n\nNOTE: Verify each claim using your authoritative knowledge base. Return ONLY valid JSON.` }]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }, isVertex);
  }

  const rep = parseJsonResponse(verifyResponse);
  const sources = extractGroundingSources(verifyResponse);
  return { rep, sources, searchAvailable };
}

// ----------------------------------------------------
// 1. VIDEO FORENSIC PIPELINE (Supports 1-Pass & 2-Pass)
// ----------------------------------------------------
async function analyseVideo(ai, src, model, isVertex, options = {}) {
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;
  let ext = null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  // SINGLE-PASS QUOTA SAVER: 1 API call for both multimodal extraction + claim verification
  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const media = await toPart(src, isVertex);
    const singlePassPrompt = `MULTIMODAL FORENSIC VIDEO & FACT-CHECKING ANALYSIS.
Analyze this video across audio speech, visual frames, on-screen text, and factual accuracy in a single pass.

1. AUDIAL & VISUAL EXTRACTION:
- Provide a concise transcript of audible speech (max 3000 chars).
- Extract up to 6 notable on-screen text/chyron overlays with timestamps.

2. SYNTHETIC MEDIA & DEEPFAKE FORENSICS:
- Inspect for visual/audio manipulation: lip-sync desync, facial boundary warping, unnatural blinking, or synthetic voice cloning.
- Assign risk: "low" | "moderate" | "high" | "critical".

3. FACT-CHECKING & CLAIM VERIFICATION:
- Extract at most ${MAX_CLAIMS} checkable factual claims from speech or on_screen_text and immediately verify each claim.

Return ONLY valid JSON with this exact shape:
{
  "creator": string,
  "title": string,
  "transcript": string,
  "ocrText": [{"timestamp": string, "text": string}],
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {
      "text": string,
      "origin": "speech" | "on_screen_text",
      "timestamp": string,
      "category": "health" | "engineering" | "general" | "politics" | "breaking_news",
      "verdict": one of [${VERDICTS}],
      "explanation": string
    }
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

    let response;
    let searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [media, { text: singlePassPrompt }] }], {
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 2500
        }, isVertex);
        searchUsed = true;
      } catch {
        searchUsed = false;
      }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [media, { text: singlePassPrompt }] }], {
        responseMimeType: 'application/json',
        maxOutputTokens: 2500
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);

    if (extractionRef) {
      await extractionRef.set({
        ...resData,
        pipelineVersion: PIPELINE_VERSION,
        sourceId,
        mediaType: 'video',
        updatedAt: Date.now()
      }, { merge: true }).catch(() => { });
    }

    return normalizeVideoReport(resData, resData, sources, searchUsed, true);
  }

  // TWO-PASS PIPELINE (Or Refresh Fact-Check Only from Cached Extraction)
  if (!ext) {
    const media = await toPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [
        media,
        {
          text: `MULTIMODAL FORENSIC VIDEO EXTRACTION.
1. Transcribe audible speech (max 3500 chars).
2. Extract notable on-screen text/chyrons with timestamps.
3. Evaluate synthetic media / deepfake risk ("low" | "moderate" | "high" | "critical").
4. Extract up to ${MAX_CLAIMS} atomic checkable factual claims.

Return ONLY JSON:
{
  "creator": string,
  "title": string,
  "transcript": string,
  "ocrText": [{"timestamp": string, "text": string}],
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "claims": [
    {"text": string, "origin": "speech" | "on_screen_text", "timestamp": string, "category": string}
  ]
}`
        }
      ]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'video';
    ext.updatedAt = Date.now();

    if (extractionRef) {
      await extractionRef.set(ext, { merge: true }).catch(() => { });
    }
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeVideoReport(ext, {
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from spoken audio or on-screen text.',
      claims: [],
      misleading: [],
      nextSteps: ['Verify if the video is primarily opinion, entertainment, or artistic content.']
    }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Origin: ${c.origin || 'speech'}${c.timestamp ? ` @ ${c.timestamp}` : ''}] ${c.text}`).join('\n');
  const promptText = `Verify each claim independently:
${compactClaims}

Return JSON:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeVideoReport(ext, rep, sources, searchAvailable, false);
}

function normalizeVideoReport(ext, rep, sources, searchAvailable, isSinglePass) {
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];

  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: ['speech', 'on_screen_text'].includes(c?.origin || rawClaims[i]?.origin) ? (c?.origin || rawClaims[i]?.origin) : 'speech',
    timestamp: String(c?.timestamp || rawClaims[i]?.timestamp || '').slice(0, 20),
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || 'No claim-level explanation returned.').slice(0, 1000)
  }));

  return {
    mediaType: 'video',
    creator: String(ext.creator || '').slice(0, 120),
    title: String(ext.title || '').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Math.round(Number(rep.confidence) || 0))),
    explanation: String(rep.explanation || 'Analysis complete.').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5).map(x => String(x).slice(0, 300)) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3).map(x => String(x).slice(0, 300)) : [],
    limitations: [
      String(rep.limitations || ''),
      `Executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass Deep Forensic'} mode with ${searchAvailable ? 'live Google Search grounding' : 'internal model knowledge'}.`
    ].filter(Boolean).join(' '),
    transcript: typeof ext.transcript === 'string' ? ext.transcript.trim().slice(0, 4500) : '',
    ocrText: Array.isArray(ext.ocrText) ? ext.ocrText.slice(0, 8).map(o => ({
      timestamp: String(o.timestamp || '').slice(0, 20),
      text: String(o.text || '').slice(0, 300)
    })) : [],
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No forensic anomalies detected.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
    },
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

// ----------------------------------------------------
// 2. AUDIO FORENSIC PIPELINE (Supports 1-Pass & 2-Pass)
// ----------------------------------------------------
async function analyseAudio(ai, src, model, isVertex, options = {}) {
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;
  let ext = null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const audioPart = await toAudioPart(src, isVertex);
    const singlePrompt = `AUDIO FORENSIC, VOICE CLONE & FACT-CHECKING ANALYSIS.
Analyze this audio in a single pass for voice synthesis markers, transcription, and factual claim verification.

Return ONLY valid JSON:
{
  "title": string,
  "speaker": string,
  "transcript": string,
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string],
    "cadenceScore": integer 0-100,
    "voiceCloningDetected": boolean
  },
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {"text": string, "timestamp": string, "category": string, "verdict": one of [${VERDICTS}], "explanation": string}
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

    let response;
    let searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [audioPart, { text: singlePrompt }] }], {
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 2200
        }, isVertex);
        searchUsed = true;
      } catch {
        searchUsed = false;
      }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [audioPart, { text: singlePrompt }] }], {
        responseMimeType: 'application/json',
        maxOutputTokens: 2200
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);
    if (extractionRef) {
      await extractionRef.set({ ...resData, pipelineVersion: PIPELINE_VERSION, sourceId, mediaType: 'audio', updatedAt: Date.now() }, { merge: true }).catch(() => { });
    }
    return normalizeAudioReport(resData, resData, sources, searchUsed, true);
  }

  if (!ext) {
    const audioPart = await toAudioPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [
        audioPart,
        {
          text: `AUDIO FORENSIC & SYNTHETIC VOICE EXTRACTION.
Evaluate prosody, breathing, voice cloning markers, transcribe speech, and extract up to ${MAX_CLAIMS} claims.
Return ONLY JSON:
{
  "title": string,
  "speaker": string,
  "transcript": string,
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string],
    "cadenceScore": integer 0-100,
    "voiceCloningDetected": boolean
  },
  "claims": [{"text": string, "timestamp": string, "category": string}]
}`
        }
      ]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'audio';
    ext.updatedAt = Date.now();
    if (extractionRef) {
      await extractionRef.set(ext, { merge: true }).catch(() => { });
    }
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeAudioReport(ext, {
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from spoken audio.',
      claims: [],
      misleading: []
    }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Timestamp: ${c.timestamp || 'N/A'}] ${c.text}`).join('\n');
  const promptText = `Verify these spoken claims:
${compactClaims}

Return JSON:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeAudioReport(ext, rep, sources, searchAvailable, false);
}

function normalizeAudioReport(ext, rep, sources, searchAvailable, isSinglePass) {
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];

  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: 'speech',
    timestamp: String(c?.timestamp || rawClaims[i]?.timestamp || '').slice(0, 20),
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  }));

  return {
    mediaType: 'audio',
    creator: String(ext.speaker || 'Unknown Speaker').slice(0, 120),
    title: String(ext.title || 'Audio Recording').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    limitations: `Audio forensics executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass'} mode (${searchAvailable ? 'Live Search Grounded' : 'Model Knowledge'}).`,
    transcript: String(ext.transcript || '').trim().slice(0, 4500),
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No acoustic anomalies detected.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : [],
      cadenceScore: Number(ext.syntheticMedia?.cadenceScore) || 85,
      voiceCloningDetected: Boolean(ext.syntheticMedia?.voiceCloningDetected)
    },
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

// ----------------------------------------------------
// 3. ARTICLE / TEXT FORENSIC PIPELINE (Cached + 1-Pass / 2-Pass)
// ----------------------------------------------------
async function analyseArticle(ai, input, model, isVertex, options = {}) {
  const { text, url, title, author } = input;
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const sourceText = String(text || '').trim().slice(0, 10000);
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;

  let ext = null;
  if (extractionRef && !forceRescan) {
    const cachedDoc = await extractionRef.get();
    if (cachedDoc.exists) {
      const data = cachedDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  if (!ext && !sourceText) {
    throw new Error('Please provide article text or a valid article URL to inspect.');
  }

  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const singlePrompt = `ARTICLE FORENSIC, AI STYLOMETRY & FACT-CHECKING ANALYSIS.
Analyze this article in a single pass for synthetic AI authorship, clickbait sensationalism, direct quotes, and factual verification.

Metadata:
Title: ${title || 'Unknown'} | Author: ${author || 'Unknown'} | URL: ${url || 'N/A'}

Content:
${sourceText}

Return ONLY valid JSON:
{
  "detectedTitle": string,
  "detectedAuthor": string,
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "aiProbability": integer 0-100,
    "sensationalismScore": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "quotes": [{"speaker": string, "quote": string}],
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {"text": string, "category": string, "verdict": one of [${VERDICTS}], "explanation": string}
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

    let response;
    let searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [{ text: singlePrompt }] }], {
          tools: [{ googleSearch: {} }],
          maxOutputTokens: 2200
        }, isVertex);
        searchUsed = true;
      } catch {
        searchUsed = false;
      }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [{ text: singlePrompt }] }], {
        responseMimeType: 'application/json',
        maxOutputTokens: 2200
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);
    if (extractionRef) {
      await extractionRef.set({ ...resData, pipelineVersion: PIPELINE_VERSION, sourceId, mediaType: 'article', updatedAt: Date.now() }, { merge: true }).catch(() => { });
    }
    return normalizeArticleReport(resData, resData, { title, author }, sources, searchUsed, true);
  }

  if (!ext) {
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [{
        text: `ARTICLE & TEXT FORENSIC EXTRACTION.
Title: ${title || 'Unknown'} | Author: ${author || 'Unknown'}
Content:
${sourceText}

Return ONLY JSON:
{
  "detectedTitle": string,
  "detectedAuthor": string,
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "aiProbability": integer 0-100,
    "sensationalismScore": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "quotes": [{"speaker": string, "quote": string}],
  "claims": [{"text": string, "category": string}]
}`
      }]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'article';
    ext.updatedAt = Date.now();
    if (extractionRef) {
      await extractionRef.set(ext, { merge: true }).catch(() => { });
    }
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeArticleReport(ext, {
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from this article.',
      claims: []
    }, { title, author }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Category: ${c.category || 'general'}] ${c.text}`).join('\n');
  const promptText = `Verify each article claim against primary authoritative reporting:
${compactClaims}

Return JSON:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeArticleReport(ext, rep, { title, author }, sources, searchAvailable, false);
}

function normalizeArticleReport(ext, rep, metaInput, sources, searchAvailable, isSinglePass) {
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];

  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: 'article_text',
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  }));

  return {
    mediaType: 'article',
    creator: String(metaInput.author || ext.detectedAuthor || 'Unknown Journalist').slice(0, 120),
    title: String(metaInput.title || ext.detectedTitle || 'Untitled Article').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    quotes: Array.isArray(ext.quotes) ? ext.quotes.slice(0, 3) : [],
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3) : [],
    limitations: `Article analysis executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass'} mode (${searchAvailable ? 'Live Search Grounded' : 'Model Knowledge'}).`,
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      aiProbability: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.aiProbability) || 10)),
      sensationalismScore: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.sensationalismScore) || 20)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No stylistic generative artifacts observed.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
    },
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

// ----------------------------------------------------
// Background Job Executor with Semaphore
// ----------------------------------------------------
async function job(id, ai, type, src, meta, k, model, isVertex, options) {
  await acquireSlot();
  try {
    let r;
    if (type === 'audio') {
      r = await analyseAudio(ai, src, model, isVertex, options);
    } else if (type === 'article') {
      r = await analyseArticle(ai, src, model, isVertex, options);
    } else {
      r = await analyseVideo(ai, src, model, isVertex, options);
    }
    await db.doc(`reports/${id}`).set({
      ...r,
      ...meta,
      id,
      mediaType: type,
      model,
      status: 'done',
      updatedAt: Date.now()
    });
  } catch (e) {
    const m = publicAiError(e, k);
    console.error(`Analysis failed for ${type} ${id}:`, m);
    await db.doc(`reports/${id}`).set({
      id,
      ...meta,
      mediaType: type,
      model,
      status: 'error',
      error: m,
      updatedAt: Date.now(),
      pipelineVersion: PIPELINE_VERSION
    });
  } finally {
    releaseSlot();
    inFlight.delete(id);
  }
}

// Helper: YouTube ID extraction & normalization
const ytId = u => {
  try {
    const x = new URL(String(u || '').trim());
    if (!['http:', 'https:'].includes(x.protocol)) return null;
    const h = x.hostname.replace(/^(www\.|m\.)/, '');
    const ok = v => (/^[\w-]{11}$/.test(v || '') ? v : null);
    if (h === 'youtu.be') return ok(x.pathname.slice(1).split(/[?#]/)[0]);
    if (h === 'youtube.com') {
      if (x.pathname === '/watch') return ok(x.searchParams.get('v'));
      const m = x.pathname.match(/^\/(shorts|embed)\/([\w-]{11})/);
      if (m) return ok(m[2]);
    }
  } catch { }
  return null;
};

// Simple web text extractor for article URLs
async function fetchArticleContent(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL protocol.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const resp = await fetch(targetUrl, {
    headers: { 'User-Agent': 'TruthLens-Bot/1.0 (+https://truthlens.ai)' },
    signal: controller.signal
  });
  clearTimeout(timeout);
  if (!resp.ok) throw new Error(`Could not fetch article (HTTP ${resp.status})`);
  const html = await resp.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Web Article';

  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, text: text.slice(0, 10000) };
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

app.get('/api/posts', async (_, res) => {
  const ps = (await db.collection('posts').orderBy('createdAt', 'desc').get()).docs.map(d => d.data()).filter(p => nameOf(p));
  res.json(ps.map(({ gcsName, ...p }) => ({ ...p, videoUrl: `/api/video/${p.id}` })));
});

app.get('/api/video/:id', async (req, res) => {
  const p = (await db.doc(`posts/${req.params.id}`).get()).data(), name = p && nameOf(p);
  if (!name) return res.sendStatus(404);
  try {
    const f = gcs.bucket(BUCKET).file(name), [m] = await f.getMetadata(), size = +m.size;
    let start = 0, end = size - 1;
    const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      if (r[1] !== '') { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], size - 1); }
      else start = Math.max(size - +r[2], 0);
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set({
      'Content-Type': m.contentType || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'private, max-age=3600'
    });
    f.createReadStream({ start, end }).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.sendStatus(404);
  }
});

app.get('/api/audio/:id', async (req, res) => {
  const a = (await db.doc(`audios/${req.params.id}`).get()).data();
  if (!a || !a.gcsName) return res.sendStatus(404);
  try {
    const f = gcs.bucket(BUCKET).file(a.gcsName), [m] = await f.getMetadata(), size = +m.size;
    let start = 0, end = size - 1;
    const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      if (r[1] !== '') { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], size - 1); }
      else start = Math.max(size - +r[2], 0);
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set({
      'Content-Type': m.contentType || 'audio/mp3',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'private, max-age=3600'
    });
    f.createReadStream({ start, end }).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.sendStatus(404);
  }
});

const VIDEO_TYPES = { 'video/mp4': 'iso', 'video/quicktime': 'iso', 'video/webm': 'webm' };
const AUDIO_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg' };
const sniffVideo = b => (b.length < 12 ? null : b.subarray(4, 8).toString() === 'ftyp' ? 'iso' : (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ? 'webm' : null);

app.post('/api/upload', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'Storage is not configured on the server.' });
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!VIDEO_TYPES[mime] || !Buffer.isBuffer(b) || !b.length) return res.status(400).json({ error: 'Upload an MP4, WebM or MOV video (max 25 MB).' });
  if (sniffVideo(b) !== VIDEO_TYPES[mime]) return res.status(400).json({ error: 'The file content does not match a valid video.' });

  const id = hash(b);
  const ref = db.doc(`posts/${id}`);
  const old = await ref.get();
  if (old.exists) {
    const { gcsName, ...p } = old.data();
    return res.json({ ...p, videoUrl: `/api/video/${id}`, duplicate: true });
  }

  const gcsName = `uploads/${id}`;
  await gcs.bucket(BUCKET).file(gcsName).save(b, { contentType: mime });
  const q = req.query;
  const post = {
    id,
    creator: String(q.creator || 'Uploader').slice(0, 60),
    title: String(q.title || 'Untitled').slice(0, 120),
    caption: String(q.caption || '').slice(0, 300),
    gcsName,
    mime,
    createdAt: Date.now()
  };
  await ref.set(post);
  res.json({ ...post, gcsName: undefined, videoUrl: `/api/video/${id}` });
});

app.post('/api/upload/audio', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'Storage is not configured on the server.' });
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!AUDIO_TYPES[mime] && !mime.startsWith('audio/')) return res.status(400).json({ error: 'Please upload an MP3, WAV, or M4A audio file (max 25 MB).' });
  if (!Buffer.isBuffer(b) || !b.length) return res.status(400).json({ error: 'Empty audio buffer.' });

  const id = hash(b);
  const ref = db.doc(`audios/${id}`);
  const old = await ref.get();
  if (old.exists) {
    return res.json({ ...old.data(), audioUrl: `/api/audio/${id}`, duplicate: true });
  }

  const gcsName = `audio/${id}`;
  await gcs.bucket(BUCKET).file(gcsName).save(b, { contentType: mime || 'audio/mp3' });
  const q = req.query;
  const audioDoc = {
    id,
    creator: String(q.creator || 'Audio Source').slice(0, 60),
    title: String(q.title || 'Audio Recording').slice(0, 120),
    gcsName,
    mime: mime || 'audio/mp3',
    createdAt: Date.now()
  };
  await ref.set(audioDoc);
  res.json({ ...audioDoc, audioUrl: `/api/audio/${id}` });
});

app.post(['/api/analyse', '/api/analyse/video'], async (req, res) => {
  const { postId, url, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  let sourceId, src, meta;
  if (postId) {
    const p = (await db.doc(`posts/${String(postId)}`).get()).data(), name = p && nameOf(p);
    if (!name) return res.status(404).json({ error: 'Video not found.' });
    sourceId = p.id;
    src = { name, mime: p.mime || 'video/mp4' };
    meta = { creator: p.creator, title: p.title, postId: p.id };
  } else {
    const v = ytId(String(url || ''));
    if (!v) return res.status(400).json({ error: 'Only public YouTube links are supported (youtube.com or youtu.be).' });
    const canon = `https://www.youtube.com/watch?v=${v}`;
    sourceId = hash(canon);
    src = { youtube: canon };
    meta = { url: canon };
  }
  meta = { ...meta, sourceId, mediaType: 'video' };

  const id = hash(`${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) {
    return res.json({ id, cached: true, report: old });
  }

  if (inFlight.has(id) || (!forceRescan && old?.status === 'processing' && Date.now() - Number(old.updatedAt || 0) < 180000)) {
    return res.json({ id, cached: false, processing: true });
  }

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({
    id,
    sourceId,
    model,
    mediaType: 'video',
    status: 'processing',
    ...meta,
    updatedAt: Date.now(),
    pipelineVersion: PIPELINE_VERSION
  });

  res.json({ id, cached: false, processing: true });
  const isVertex = isVertexOf(req);
  const quotaMode = quotaModeOf(req);
  const useSearch = useSearchOf(req);
  void job(id, ai, 'video', src, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => {
    inFlight.delete(id);
    console.error('Video background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.post('/api/analyse/audio', async (req, res) => {
  const { audioId, url, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  let sourceId, src, meta;
  if (audioId) {
    const a = (await db.doc(`audios/${String(audioId)}`).get()).data();
    if (!a || !a.gcsName) return res.status(404).json({ error: 'Audio record not found.' });
    sourceId = a.id;
    src = { name: a.gcsName, mime: a.mime || 'audio/mp3' };
    meta = { creator: a.creator, title: a.title, audioId: a.id };
  } else if (url) {
    sourceId = hash(String(url).trim());
    src = { url: String(url).trim() };
    meta = { url: String(url).trim(), title: 'Remote Audio Stream' };
  } else {
    return res.status(400).json({ error: 'Please provide an audioId or audio URL.' });
  }
  meta = { ...meta, sourceId, mediaType: 'audio' };

  const id = hash(`audio:${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) {
    return res.json({ id, cached: true, report: old });
  }

  if (inFlight.has(id)) return res.json({ id, cached: false, processing: true });

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({
    id,
    sourceId,
    model,
    mediaType: 'audio',
    status: 'processing',
    ...meta,
    updatedAt: Date.now(),
    pipelineVersion: PIPELINE_VERSION
  });

  res.json({ id, cached: false, processing: true });
  const isVertex = isVertexOf(req);
  const quotaMode = quotaModeOf(req);
  const useSearch = useSearchOf(req);
  void job(id, ai, 'audio', src, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => {
    inFlight.delete(id);
    console.error('Audio background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.post('/api/analyse/article', async (req, res) => {
  let { url, text, title, author, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  if (url && !text && !refreshFactCheckOnly) {
    try {
      const scraped = await fetchArticleContent(url);
      text = scraped.text;
      if (!title) title = scraped.title;
    } catch (e) {
      return res.status(400).json({ error: `Could not fetch article URL: ${e.message}` });
    }
  }

  if (!refreshFactCheckOnly && (!text || String(text).trim().length < 50)) {
    return res.status(400).json({ error: 'Article content must be at least 50 characters.' });
  }

  const sourceId = hash(url ? url.trim() : String(text || '').trim().slice(0, 1000));
  const id = hash(`article:${sourceId}:${model}`);
  const meta = { url, title: title || 'Article Investigation', creator: author || 'Unknown Author', sourceId, mediaType: 'article' };
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) {
    return res.json({ id, cached: true, report: old });
  }

  if (inFlight.has(id)) return res.json({ id, cached: false, processing: true });

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({
    id,
    sourceId,
    model,
    mediaType: 'article',
    status: 'processing',
    ...meta,
    updatedAt: Date.now(),
    pipelineVersion: PIPELINE_VERSION
  });

  res.json({ id, cached: false, processing: true });
  const isVertex = isVertexOf(req);
  const quotaMode = quotaModeOf(req);
  const useSearch = useSearchOf(req);
  void job(id, ai, 'article', { text, url, title, author }, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => {
    inFlight.delete(id);
    console.error('Article background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.get('/api/dashboard/stats', async (_, res) => {
  try {
    const docs = (await db.collection('reports').orderBy('updatedAt', 'desc').limit(100).get()).docs.map(d => d.data());
    const total = docs.length;
    const byType = { video: 0, audio: 0, article: 0 };
    const byVerdict = { Supported: 0, Contradicted: 0, Misleading: 0, Mixed: 0, 'Insufficient Evidence': 0 };
    const byRisk = { low: 0, moderate: 0, high: 0, critical: 0 };

    let criticalCount = 0;
    for (const r of docs) {
      const type = r.mediaType || 'video';
      byType[type] = (byType[type] || 0) + 1;
      if (r.verdict && byVerdict[r.verdict] !== undefined) {
        byVerdict[r.verdict]++;
      }
      const risk = r.syntheticMedia?.risk || 'low';
      if (byRisk[risk] !== undefined) byRisk[risk]++;
      if (risk === 'high' || risk === 'critical') criticalCount++;
    }

    const threatRate = total ? Math.round((criticalCount / total) * 100) : 0;
    const recent = docs.slice(0, 6);

    res.json({
      total,
      byType,
      byVerdict,
      byRisk,
      threatRate,
      recent,
      queueDepth: jobQueue.length,
      activeJobs
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Could not compute dashboard stats' });
  }
});

app.get('/api/reports', async (req, res) => {
  const type = req.query.type;
  const q = db.collection('reports').orderBy('updatedAt', 'desc').limit(50);
  const docs = (await q.get()).docs.map(d => d.data());
  const filtered = type ? docs.filter(r => (r.mediaType || 'video') === type) : docs;
  res.json(filtered);
});

app.get('/api/reports/:id', async (req, res) => {
  const d = await db.doc(`reports/${req.params.id}`).get();
  d.exists ? res.json(d.data()) : res.status(404).json({ error: 'not found' });
});

app.post('/api/check-key', async (req, res) => {
  const model = modelOf(req);
  if (!model) return res.status(400).json({ ok: false, error: 'Unsupported Gemini model.' });
  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ ok: false, needKey: true, error: 'No key provided.' });
  try {
    await generate(ai, model, 'Reply with OK', { maxOutputTokens: 10 }, isVertexOf(req));
    res.json({ ok: true, resolvedModel: model });
  } catch (e) {
    res.status(isQuotaError(e) ? 429 : 400).json({ ok: false, error: publicAiError(e, keyOf(req)) });
  }
});

app.post('/api/seed', async (_, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'No bucket configured.' });
  const [files] = await gcs.bucket(BUCKET).getFiles({ prefix: 'demo/' });
  let n = 0;
  for (const f of files.filter(f => /\.(mp4|mov|webm)$/i.test(f.name))) {
    const [a, b] = f.name.replace(/^demo\/|\.\w+$/g, '').split('__').map(s => s.replace(/[-_]/g, ' '));
    await db.doc(`posts/${hash(f.name)}`).set({
      id: hash(f.name),
      creator: b ? a : 'Demo Creator',
      title: b || a,
      caption: '',
      gcsName: f.name,
      mime: f.metadata.contentType || 'video/mp4',
      createdAt: Date.now() + n++
    }, { merge: true });
  }
  res.json({ seeded: n });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateDirs = [
  path.resolve('public'),
  path.resolve(__dirname, 'public'),
  path.resolve('frontend/dist'),
  path.resolve(__dirname, '../frontend/dist')
];
const staticDir = candidateDirs.find(d => fs.existsSync(path.join(d, 'index.html')));

const PORT = process.env.PORT || 8080;

if (staticDir) {
  app.use(express.static(staticDir));
  app.get('*', (_, res) => {
    res.sendFile(path.join(staticDir, 'index.html'), err => {
      if (err && !res.headersSent) {
        res.status(500).send('Error loading frontend assets.');
      }
    });
  });
} else {
  app.get('*', (_, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>TruthLens API Server</title></head>
        <body style="font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; padding: 40px; line-height: 1.6;">
          <h2>TruthLens Backend API Running</h2>
          <p>The backend API is active on <code>http://localhost:${PORT}/api</code>.</p>
        </body>
      </html>
    `);
  });
}

app.listen(PORT, () => {
  console.log(`TruthLens backend listening on http://localhost:${PORT}`);
  console.log(`  Project:   ${PROJECT_ID || '(using default ADC project)'}`);
  console.log(`  Bucket:    ${BUCKET || '(BUCKET not set)'}`);
  console.log(`  Firestore: ${FIRESTORE_DATABASE_ID}`);
  console.log(`  Primary:   ${MODEL} (Fallback: ${FALLBACK_MODEL})`);
});