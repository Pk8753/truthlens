import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import {Firestore} from '@google-cloud/firestore';
import {Storage} from '@google-cloud/storage';
import {GoogleGenAI} from '@google/genai';

// Auto-load .env config for local development if present
if (typeof process.loadEnvFile === 'function') {
  if (fs.existsSync('.env')) {
    try { process.loadEnvFile('.env'); } catch {}
  } else if (fs.existsSync('../.env')) {
    try { process.loadEnvFile('../.env'); } catch {}
  }
}

const PROJECT_ID = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const BUCKET = process.env.BUCKET;
const FIRESTORE_DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
const MODEL = process.env.MODEL || 'gemini-3.8-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PIPELINE_VERSION = 'multimodal-intelligence-v4';
const MAX_CLAIMS = 5;
const MAX_CONCURRENT_JOBS = 3;
const MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash-lite-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

const inFlight = new Map();
let activeJobs = 0;
const jobQueue = [];

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

const db = new Firestore({
  ...(PROJECT_ID ? {projectId: PROJECT_ID} : {}),
  databaseId: FIRESTORE_DATABASE_ID,
  ignoreUndefinedProperties: true
});
const gcs = new Storage({
  ...(PROJECT_ID ? {projectId: PROJECT_ID} : {})
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '2mb'}));
app.use((_, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
process.on('unhandledRejection', e => console.error('unhandled:', String(e?.message || e).slice(0, 300)));

// Express 4 async handler error wrapper
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => orig(path, ...hs.map(fn => fn?.constructor?.name === 'AsyncFunction'
    ? (req, res, next) => fn(req, res, next).catch(e => {
        console.error(m, path, String(e?.message || e).slice(0, 300));
        if (!res.headersSent) res.status(500).json({error: 'Server error: ' + String(e?.message || e).slice(0, 200)});
      })
    : fn));
}

const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const keyOf = req => req.get('x-ai-key') || GEMINI_API_KEY;
const isVertexOf = req => req.get('x-ai-provider') === 'vertex';
const clientFor = req => {
  const k = keyOf(req);
  return k ? new GoogleGenAI(isVertexOf(req) ? {vertexai: true, apiKey: k} : {apiKey: k}) : null;
};
const modelOf = req => {
  const requested = req.get('x-ai-model');
  return requested ? (MODELS.has(requested) ? requested : null) : MODEL;
};
const clean = (e, k) => {
  let m = String(e?.message || e);
  if (k) m = m.split(k).join('***');
  return m.slice(0, 300);
};

const PUB = `https://storage.googleapis.com/${BUCKET}/`;
const nameOf = p => p.gcsName || (p.videoUrl?.startsWith(PUB) ? decodeURIComponent(p.videoUrl.slice(PUB.length)) : null);
const VERDICTS = 'Supported | Contradicted | Misleading | Mixed | Insufficient Evidence';

async function toPart(src, isVertex) {
  if (src.youtube) return {fileData: {fileUri: src.youtube, mimeType: 'video/mp4'}};
  if (isVertex && BUCKET && src.name) {
    return {fileData: {fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'video/mp4'}};
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 25 * 1024 * 1024) throw new Error('Video is larger than 25 MB. Use a shorter clip.');
  return {inlineData: {mimeType: src.mime === 'video/quicktime' ? 'video/mov' : src.mime, data: b.toString('base64')}};
}

async function toAudioPart(src, isVertex) {
  if (isVertex && BUCKET && src.name) {
    return {fileData: {fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'audio/mp3'}};
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 25 * 1024 * 1024) throw new Error('Audio file exceeds 25 MB limit.');
  return {inlineData: {mimeType: src.mime || 'audio/mp3', data: b.toString('base64')}};
}

function parseJsonResponse(response) {
  const raw = response?.text;
  if (!raw) throw new Error('The AI returned an empty response. Please try again.');
  try { return JSON.parse(raw); }
  catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
    throw new Error('The AI returned an invalid structured response. Please retry.');
  }
}

function isQuotaError(e) {
  const s = `${e?.status || ''} ${e?.code || ''} ${e?.message || ''}`.toLowerCase();
  return /429|resource_exhausted|rate.?limit|quota/.test(s);
}

function publicAiError(e, key) {
  if (isQuotaError(e)) {
    return 'Gemini quota or rate limit reached (RPM/TPD). Wait a moment before retrying, or verify your API key quota settings.';
  }
  const status = Number(e?.status || e?.code);
  if (status === 401 || status === 403) {
    return 'The AI key or provider configuration was rejected. Check your key, enabled APIs, and billing status.';
  }
  return clean(e, key);
}

async function generate(ai, model, contents, config = {}) {
  return ai.models.generateContent({model, contents, config: {candidateCount: 1, ...config}});
}

async function verifyClaimsWithGrounding(ai, model, promptText) {
  let verifyResponse;
  let searchAvailable = true;
  try {
    verifyResponse = await generate(ai, model, [{
      role: 'user',
      parts: [{text: promptText}]
    }], {
      tools: [{googleSearch: {}}],
      responseMimeType: 'application/json',
      maxOutputTokens: 2500
    });
  } catch (e) {
    if (isQuotaError(e)) {
      console.warn('Google Search Grounding quota reached or unavailable on this key. Falling back gracefully to Gemini knowledge verification...');
      searchAvailable = false;
      verifyResponse = await generate(ai, model, [{
        role: 'user',
        parts: [{text: `${promptText}\n\nNOTE: Verify each claim thoroughly using your internal authoritative knowledge base.`}]
      }], {
        responseMimeType: 'application/json',
        maxOutputTokens: 2500
      });
    } else {
      throw e;
    }
  }

  const rep = parseJsonResponse(verifyResponse);
  const grounding = verifyResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Map(grounding.filter(g => g?.web?.uri).map(g => [g.web.uri, {uri: g.web.uri, title: g.web.title || g.web.uri}])).values()].slice(0, 8);
  return { rep, sources, searchAvailable };
}

// ----------------------------------------------------
// 1. VIDEO FORENSIC PIPELINE
// ----------------------------------------------------
async function analyseVideo(ai, src, model, isVertex, options = {}) {
  const {sourceId, forceRescan = false, refreshFactCheckOnly = false} = options;
  let ext = null;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  if (!ext) {
    const media = await toPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [
        media,
        {
          text: `MULTIMODAL FORENSIC VIDEO ANALYSIS.
Analyze this video across audio speech, visual frames, on-screen text, and temporal flow.

1. AUDIAL TRACK:
- Provide a near-verbatim transcript of audible speech (capped at 4000 chars). Note approximate timing or speaker.
- Detect voice cloning/synthesis indicators (robotic cadence, frequency anomalies, unnatural prosody).

2. VISUAL & OCR TRACK:
- Extract notable on-screen text, chyrons, ticker headlines, captions, or graphic banners with timestamps.

3. SYNTHETIC MEDIA & DEEPFAKE FORENSICS:
- Inspect for visual manipulation: facial boundary warping, unnatural eye blink frequency, temporal frame splicing, lip-to-speech audio desync, or generative AI diffusion textures.
- Assign syntheticMediaRisk: "low" | "moderate" | "high" | "critical".
- Provide a concise 1-2 sentence forensic explanation.

4. CHECKABLE FACTUAL CLAIMS:
- Extract at most ${MAX_CLAIMS} short, atomic, checkable factual claims originating from either speech or on-screen text.
- For each claim, identify origin ("speech" or "on_screen_text") and category ("health" | "engineering" | "general" | "politics" | "breaking_news").

Return ONLY JSON with this shape:
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
}
If no audible speech is present, transcript must be "". If no claims exist, claims must be [].`
        }
      ]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2500
    });

    ext = parseJsonResponse(extResponse);
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
      throw new Error('The AI returned an invalid multimodal extraction response. Please retry.');
    }

    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'video';
    ext.updatedAt = Date.now();

    if (extractionRef) {
      await extractionRef.set(ext, {merge: true}).catch(err => console.error('Failed to cache extraction:', err));
    }
  }

  const transcript = typeof ext.transcript === 'string' ? ext.transcript.trim().slice(0, 4500) : '';
  const ocrText = Array.isArray(ext.ocrText) ? ext.ocrText.slice(0, 8).map(o => ({
    timestamp: String(o.timestamp || '').slice(0, 20),
    text: String(o.text || '').slice(0, 300)
  })) : [];
  const syntheticMedia = {
    risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
    confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
    reasoning: String(ext.syntheticMedia?.reasoning || 'No forensic anomalies detected.').slice(0, 500),
    anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
  };

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => typeof c?.text === 'string' && c.text.trim()).map(c => ({
    text: c.text.trim().slice(0, 700),
    origin: ['speech', 'on_screen_text'].includes(c.origin) ? c.origin : 'speech',
    timestamp: String(c.timestamp || '').slice(0, 20),
    category: ['health', 'engineering', 'general', 'politics', 'breaking_news'].includes(c.category) ? c.category : 'general'
  })) : [];

  const base = {
    creator: String(ext.creator || '').slice(0, 120),
    title: String(ext.title || '').slice(0, 200)
  };

  if (!claims.length) {
    return {
      mediaType: 'video',
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from spoken audio or on-screen text.',
      claims: [],
      misleading: [],
      nextSteps: ['Verify if the video is primarily opinion, entertainment, or artistic content.'],
      limitations: 'Multimodal pass completed. No checkable factual claims identified in speech or text overlays.',
      ...base,
      transcript,
      ocrText,
      syntheticMedia,
      sources: [],
      pipelineVersion: PIPELINE_VERSION
    };
  }

  // Pass 2: Grounded Fact-Checking
  const compactClaims = claims.map((c, i) => `${i + 1}. [Origin: ${c.origin}${c.timestamp ? ` @ ${c.timestamp}` : ''}] [Category: ${c.category}] ${c.text}`).join('\n');
  const promptText = `You are an elite newsroom fact-checking analyst. Verify each claim independently:
Claims to verify:
${compactClaims}

Return a concise JSON report:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100 (strength of verifiable evidence),
  "explanation": string (overall synthesis, 2-4 sentences),
  "claims": [
    {
      "text": string,
      "verdict": one of [${VERDICTS}],
      "explanation": string
    }
  ],
  "misleading": [short strings detailing misleading elements; empty if none],
  "nextSteps": [2-3 short actionable steps for editors/moderators],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText);
  const validVerdicts = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);

  const claimResults = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS).map((c, i) => ({
    text: String(c?.text || claims[i]?.text || '').slice(0, 700),
    origin: claims[i]?.origin || 'speech',
    timestamp: claims[i]?.timestamp || '',
    verdict: validVerdicts.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || 'No claim-level explanation returned.').slice(0, 1000)
  })) : claims.map(c => ({
    text: c.text,
    origin: c.origin,
    timestamp: c.timestamp,
    verdict: 'Insufficient Evidence',
    explanation: 'The verification model did not return a claim-level assessment.'
  }));

  const overall = validVerdicts.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence';

  return {
    mediaType: 'video',
    verdict: overall,
    confidence: Math.max(0, Math.min(100, Number.isFinite(Number(rep.confidence)) ? Math.round(Number(rep.confidence)) : 0)),
    explanation: String(rep.explanation || 'Insufficient explanation returned.').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5).map(x => String(x).slice(0, 300)) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3).map(x => String(x).slice(0, 300)) : [],
    limitations: [
      String(rep.limitations || ''),
      searchAvailable
        ? 'Multimodal video analysis includes speech transcription, on-screen text (OCR), synthetic media heuristics, and live grounded web search.'
        : 'Multimodal video analysis includes speech transcription, on-screen text (OCR), synthetic media heuristics, and Gemini knowledge verification (live search was unavailable on this API key).'
    ].filter(Boolean).join(' '),
    ...base,
    transcript,
    ocrText,
    syntheticMedia,
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

// ----------------------------------------------------
// 2. AUDIO FORENSIC PIPELINE
// ----------------------------------------------------
async function analyseAudio(ai, src, model, isVertex, options = {}) {
  const {sourceId, forceRescan = false, refreshFactCheckOnly = false} = options;
  let ext = null;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  if (!ext) {
    const audioPart = await toAudioPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [
        audioPart,
        {
          text: `AUDIO FORENSIC & SYNTHETIC VOICE ANALYSIS.
Analyze this audio recording for acoustic markers, synthetic speech generation, voice cloning, and factual claims.

1. VOICE SYNTHESIS & ACOUSTIC FORENSICS:
- Evaluate prosody, breathing patterns, micro-tremors, frequency anomalies, robotic pacing, and pitch variations.
- Detect signs of neural voice synthesis (e.g. ElevenLabs, XTTS, VALL-E).
- Assign syntheticRisk: "low" | "moderate" | "high" | "critical".
- Provide cadenceScore (0-100, where 100 = completely natural human cadence).
- List specific acoustic anomalies observed (e.g. "metallic timbre at 0:14", "unnatural absence of breathing artifacts").

2. TRANSCRIPTION & SPEAKER TURNS:
- Provide a near-verbatim transcript of spoken speech with speaker labels and timestamps.

3. FACTUAL CLAIMS:
- Extract up to ${MAX_CLAIMS} atomic factual claims made in the audio.

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
  "claims": [
    {"text": string, "timestamp": string, "category": string}
  ]
}`
        }
      ]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2500
    });

    ext = parseJsonResponse(extResponse);
    if (!ext || typeof ext !== 'object') {
      throw new Error('Invalid audio extraction response.');
    }
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'audio';
    ext.updatedAt = Date.now();
    if (extractionRef) {
      await extractionRef.set(ext, {merge: true}).catch(err => console.error('Audio cache error:', err));
    }
  }

  const transcript = String(ext.transcript || '').trim().slice(0, 4500);
  const syntheticMedia = {
    risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
    confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
    reasoning: String(ext.syntheticMedia?.reasoning || 'No acoustic anomalies detected.').slice(0, 500),
    anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : [],
    cadenceScore: Number(ext.syntheticMedia?.cadenceScore) || 85,
    voiceCloningDetected: Boolean(ext.syntheticMedia?.voiceCloningDetected)
  };

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => typeof c?.text === 'string' && c.text.trim()).map(c => ({
    text: c.text.trim().slice(0, 700),
    origin: 'speech',
    timestamp: String(c.timestamp || '').slice(0, 20),
    category: ['health', 'engineering', 'general', 'politics', 'breaking_news'].includes(c.category) ? c.category : 'general'
  })) : [];

  const base = {
    creator: String(ext.speaker || 'Unknown Speaker').slice(0, 120),
    title: String(ext.title || 'Audio Recording').slice(0, 200)
  };

  if (!claims.length) {
    return {
      mediaType: 'audio',
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from spoken audio.',
      claims: [],
      misleading: [],
      nextSteps: ['Assess audio independently as conversational or artistic material.'],
      limitations: 'Audio acoustic analysis completed. No checkable factual claims extracted.',
      ...base,
      transcript,
      syntheticMedia,
      sources: [],
      pipelineVersion: PIPELINE_VERSION
    };
  }

  // Pass 2: Audio Claims Verification
  const compactClaims = claims.map((c, i) => `${i + 1}. [Timestamp: ${c.timestamp || 'N/A'}] [Category: ${c.category}] ${c.text}`).join('\n');
  const promptText = `You are an audio verification specialist. Verify the following spoken claims:
${compactClaims}

Return JSON:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {"text": string, "verdict": one of [${VERDICTS}], "explanation": string}
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText);
  const validVerdicts = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);

  const claimResults = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS).map((c, i) => ({
    text: String(c?.text || claims[i]?.text || '').slice(0, 700),
    origin: 'speech',
    timestamp: claims[i]?.timestamp || '',
    verdict: validVerdicts.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  })) : claims.map(c => ({
    text: c.text,
    origin: 'speech',
    timestamp: c.timestamp,
    verdict: 'Insufficient Evidence',
    explanation: 'No claim-level assessment returned.'
  }));

  return {
    mediaType: 'audio',
    verdict: validVerdicts.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    limitations: searchAvailable
      ? 'Audio acoustic forensics evaluated speech cadence, prosody, and synthetic voice indicators alongside live search grounding.'
      : 'Audio acoustic forensics evaluated speech cadence, prosody, and synthetic voice indicators alongside Gemini knowledge verification (live search was unavailable on this API key).',
    ...base,
    transcript,
    syntheticMedia,
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

// ----------------------------------------------------
// 3. ARTICLE / TEXT FORENSIC PIPELINE
// ----------------------------------------------------
async function analyseArticle(ai, input, model, options = {}) {
  const {text, url, title, author} = input;
  const sourceText = String(text || '').trim().slice(0, 12000);

  if (!sourceText) {
    throw new Error('Please provide article text or a valid article URL to inspect.');
  }

  // Pass 1: Stylometric AI text generation & quote extraction
  const extResponse = await generate(ai, model, [{
    role: 'user',
    parts: [{
      text: `ARTICLE & TEXT FORENSIC ANALYSIS.
Analyze this article for synthetic AI-generated text patterns, sensationalism, cherry-picked quotes, and factual claims.

Article Metadata:
Title: ${title || 'Unknown'}
Author: ${author || 'Unknown'}
URL: ${url || 'N/A'}

Article Content:
${sourceText}

Analyze the following:
1. AI AUTHORSHIP & SYNTHETIC TEXT DETECTION:
- Evaluate stylometry, token repetition, uniform sentence lengths, lack of colloquial texture, and typical LLM cliches.
- Estimate aiProbability (0-100, where 100 = completely AI generated / synthetic).
- Assign syntheticRisk: "low" | "moderate" | "high" | "critical".
- Estimate sensationalismScore (0-100, degree of emotional manipulation or clickbait framing).

2. QUOTE VERIFICATION:
- Extract up to 3 direct quotes attributed to named individuals.

3. CHECKABLE FACTUAL CLAIMS:
- Extract up to ${MAX_CLAIMS} atomic factual claims made in the article.

Return ONLY JSON:
{
  "detectedTitle": string,
  "detectedAuthor": string,
  "summary": string,
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "aiProbability": integer 0-100,
    "sensationalismScore": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "quotes": [
    {"speaker": string, "quote": string}
  ],
  "claims": [
    {"text": string, "category": string}
  ]
}`
    }]
  }], {
    responseMimeType: 'application/json',
    maxOutputTokens: 2500
  });

  const ext = parseJsonResponse(extResponse);
  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).map(c => ({
    text: String(c.text || '').trim().slice(0, 700),
    origin: 'article_text',
    category: c.category || 'general'
  })) : [];

  const syntheticMedia = {
    risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
    confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
    aiProbability: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.aiProbability) || 10)),
    sensationalismScore: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.sensationalismScore) || 20)),
    reasoning: String(ext.syntheticMedia?.reasoning || 'No stylistic generative artifacts observed.').slice(0, 500),
    anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
  };

  const base = {
    creator: String(author || ext.detectedAuthor || 'Unknown Journalist').slice(0, 120),
    title: String(title || ext.detectedTitle || 'Untitled Article').slice(0, 200)
  };

  if (!claims.length) {
    return {
      mediaType: 'article',
      verdict: 'Insufficient Evidence',
      confidence: 0,
      explanation: 'No verifiable factual claims were extracted from this article.',
      claims: [],
      misleading: [],
      nextSteps: ['Review whether the text is an editorial opinion or personal commentary.'],
      limitations: 'Article stylometric analysis completed. No checkable factual claims extracted.',
      ...base,
      syntheticMedia,
      quotes: Array.isArray(ext.quotes) ? ext.quotes.slice(0, 3) : [],
      sources: [],
      pipelineVersion: PIPELINE_VERSION
    };
  }

  // Pass 2: Article Claims Verification
  const compactClaims = claims.map((c, i) => `${i + 1}. [Category: ${c.category}] ${c.text}`).join('\n');
  const promptText = `You are an investigative fact-checker. Verify each article claim against primary authoritative reporting:
${compactClaims}

Return JSON:
{
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {"text": string, "verdict": one of [${VERDICTS}], "explanation": string}
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText);
  const validVerdicts = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);

  const claimResults = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS).map((c, i) => ({
    text: String(c?.text || claims[i]?.text || '').slice(0, 700),
    origin: 'article_text',
    verdict: validVerdicts.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  })) : claims.map(c => ({
    text: c.text,
    origin: 'article_text',
    verdict: 'Insufficient Evidence',
    explanation: 'No claim-level assessment returned.'
  }));

  return {
    mediaType: 'article',
    verdict: validVerdicts.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    quotes: Array.isArray(ext.quotes) ? ext.quotes.slice(0, 3) : [],
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3) : [],
    limitations: searchAvailable
      ? 'Article forensic analysis examined AI generation indicators, sensationalism framing, and live source corroboration.'
      : 'Article forensic analysis examined AI generation indicators, sensationalism framing, and Gemini knowledge verification (live search was unavailable on this API key).',
    ...base,
    syntheticMedia,
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
      r = await analyseArticle(ai, src, model, options);
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
  } catch {}
  return null;
};

// Simple web text extractor for article URLs
async function fetchArticleContent(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL protocol.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const resp = await fetch(targetUrl, {
    headers: {'User-Agent': 'TruthLens-Bot/1.0 (+https://truthlens.ai)'},
    signal: controller.signal
  });
  clearTimeout(timeout);
  if (!resp.ok) throw new Error(`Could not fetch article (HTTP ${resp.status})`);
  const html = await resp.text();

  // Basic HTML text extraction
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Web Article';

  // Strip script, style, comments
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                 .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                 .replace(/<!--[\s\S]*?-->/g, ' ')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\s+/g, ' ')
                 .trim();

  return {title, text: text.slice(0, 10000)};
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Posts & Video Streaming
app.get('/api/posts', async (_, res) => {
  const ps = (await db.collection('posts').orderBy('createdAt', 'desc').get()).docs.map(d => d.data()).filter(p => nameOf(p));
  res.json(ps.map(({gcsName, ...p}) => ({...p, videoUrl: `/api/video/${p.id}`})));
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
    f.createReadStream({start, end}).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.sendStatus(404);
  }
});

// 2. Audio Streaming
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
    f.createReadStream({start, end}).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.sendStatus(404);
  }
});

// 3. Uploads with SHA-256 Deduplication
const VIDEO_TYPES = {'video/mp4': 'iso', 'video/quicktime': 'iso', 'video/webm': 'webm'};
const AUDIO_TYPES = {'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg'};
const sniffVideo = b => (b.length < 12 ? null : b.subarray(4, 8).toString() === 'ftyp' ? 'iso' : (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ? 'webm' : null);

app.post('/api/upload', express.raw({type: '*/*', limit: '30mb'}), async (req, res) => {
  if (!BUCKET) return res.status(500).json({error: 'Storage is not configured on the server.'});
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!VIDEO_TYPES[mime] || !Buffer.isBuffer(b) || !b.length) return res.status(400).json({error: 'Upload an MP4, WebM or MOV video (max 30 MB).'});
  if (sniffVideo(b) !== VIDEO_TYPES[mime]) return res.status(400).json({error: 'The file content does not match a valid video.'});

  const id = hash(b);
  const ref = db.doc(`posts/${id}`);
  const old = await ref.get();
  if (old.exists) {
    const {gcsName, ...p} = old.data();
    return res.json({...p, videoUrl: `/api/video/${id}`, duplicate: true});
  }

  const gcsName = `uploads/${id}`;
  await gcs.bucket(BUCKET).file(gcsName).save(b, {contentType: mime});
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
  res.json({...post, gcsName: undefined, videoUrl: `/api/video/${id}`});
});

app.post('/api/upload/audio', express.raw({type: '*/*', limit: '30mb'}), async (req, res) => {
  if (!BUCKET) return res.status(500).json({error: 'Storage is not configured on the server.'});
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!AUDIO_TYPES[mime] && !mime.startsWith('audio/')) return res.status(400).json({error: 'Please upload an MP3, WAV, or M4A audio file (max 30 MB).'});
  if (!Buffer.isBuffer(b) || !b.length) return res.status(400).json({error: 'Empty audio buffer.'});

  const id = hash(b);
  const ref = db.doc(`audios/${id}`);
  const old = await ref.get();
  if (old.exists) {
    return res.json({...old.data(), audioUrl: `/api/audio/${id}`, duplicate: true});
  }

  const gcsName = `audio/${id}`;
  await gcs.bucket(BUCKET).file(gcsName).save(b, {contentType: mime || 'audio/mp3'});
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
  res.json({...audioDoc, audioUrl: `/api/audio/${id}`});
});

// 4. Verification Endpoints: Video, Audio, Article
app.post(['/api/analyse', '/api/analyse/video'], async (req, res) => {
  const {postId, url, forceRescan, refreshFactCheckOnly} = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({error: 'Unsupported Gemini model.'});

  let sourceId, src, meta;
  if (postId) {
    const p = (await db.doc(`posts/${String(postId)}`).get()).data(), name = p && nameOf(p);
    if (!name) return res.status(404).json({error: 'Video not found.'});
    sourceId = p.id;
    src = {name, mime: p.mime || 'video/mp4'};
    meta = {creator: p.creator, title: p.title, postId: p.id};
  } else {
    const v = ytId(String(url || ''));
    if (!v) return res.status(400).json({error: 'Only public YouTube links are supported (youtube.com or youtu.be).'});
    const canon = `https://www.youtube.com/watch?v=${v}`;
    sourceId = hash(canon);
    src = {youtube: canon};
    meta = {url: canon};
  }
  meta = {...meta, sourceId, mediaType: 'video'};

  const id = hash(`${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION && old.model === model) {
    return res.json({id, cached: true, report: old});
  }

  if (inFlight.has(id) || (!forceRescan && old?.status === 'processing' && old.pipelineVersion === PIPELINE_VERSION && Date.now() - Number(old.updatedAt || 0) < 300000)) {
    return res.json({id, cached: false, processing: true});
  }

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({error: 'An AI key is required. Add one in Settings.', needKey: true});

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

  res.json({id, cached: false, processing: true});
  const isVertex = isVertexOf(req);
  void job(id, ai, 'video', src, meta, keyOf(req), model, isVertex, {sourceId, forceRescan, refreshFactCheckOnly}).catch(e => {
    inFlight.delete(id);
    console.error('Video background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.post('/api/analyse/audio', async (req, res) => {
  const {audioId, url, forceRescan, refreshFactCheckOnly} = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({error: 'Unsupported Gemini model.'});

  let sourceId, src, meta;
  if (audioId) {
    const a = (await db.doc(`audios/${String(audioId)}`).get()).data();
    if (!a || !a.gcsName) return res.status(404).json({error: 'Audio record not found.'});
    sourceId = a.id;
    src = {name: a.gcsName, mime: a.mime || 'audio/mp3'};
    meta = {creator: a.creator, title: a.title, audioId: a.id};
  } else if (url) {
    sourceId = hash(String(url).trim());
    src = {url: String(url).trim()};
    meta = {url: String(url).trim(), title: 'Remote Audio Stream'};
  } else {
    return res.status(400).json({error: 'Please provide an audioId or audio URL.'});
  }
  meta = {...meta, sourceId, mediaType: 'audio'};

  const id = hash(`audio:${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION && old.model === model) {
    return res.json({id, cached: true, report: old});
  }

  if (inFlight.has(id)) return res.json({id, cached: false, processing: true});

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({error: 'An AI key is required. Add one in Settings.', needKey: true});

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

  res.json({id, cached: false, processing: true});
  const isVertex = isVertexOf(req);
  void job(id, ai, 'audio', src, meta, keyOf(req), model, isVertex, {sourceId, forceRescan, refreshFactCheckOnly}).catch(e => {
    inFlight.delete(id);
    console.error('Audio background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.post('/api/analyse/article', async (req, res) => {
  let {url, text, title, author, forceRescan} = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({error: 'Unsupported Gemini model.'});

  if (url && !text) {
    try {
      const scraped = await fetchArticleContent(url);
      text = scraped.text;
      if (!title) title = scraped.title;
    } catch (e) {
      return res.status(400).json({error: `Could not fetch article URL: ${e.message}`});
    }
  }

  if (!text || String(text).trim().length < 50) {
    return res.status(400).json({error: 'Article content must be at least 50 characters.'});
  }

  const sourceId = hash(url ? url.trim() : text.trim().slice(0, 1000));
  const id = hash(`article:${sourceId}:${model}`);
  const meta = {url, title: title || 'Article Investigation', creator: author || 'Unknown Author', sourceId, mediaType: 'article'};
  const old = (await db.doc(`reports/${id}`).get()).data();

  if (!forceRescan && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION && old.model === model) {
    return res.json({id, cached: true, report: old});
  }

  if (inFlight.has(id)) return res.json({id, cached: false, processing: true});

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({error: 'An AI key is required. Add one in Settings.', needKey: true});

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

  res.json({id, cached: false, processing: true});
  void job(id, ai, 'article', {text, url, title, author}, meta, keyOf(req), model, false, {sourceId, forceRescan}).catch(e => {
    inFlight.delete(id);
    console.error('Article background-job failure:', publicAiError(e, keyOf(req)));
  });
});

// 5. Dashboard Aggregated Metrics
app.get('/api/dashboard/stats', async (_, res) => {
  try {
    const docs = (await db.collection('reports').orderBy('updatedAt', 'desc').limit(100).get()).docs.map(d => d.data());
    const total = docs.length;
    const byType = {video: 0, audio: 0, article: 0};
    const byVerdict = {Supported: 0, Contradicted: 0, Misleading: 0, Mixed: 0, 'Insufficient Evidence': 0};
    const byRisk = {low: 0, moderate: 0, high: 0, critical: 0};

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
      recent
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({error: 'Could not compute dashboard stats'});
  }
});

// 6. Reports & Key Verification
app.get('/api/reports', async (req, res) => {
  const type = req.query.type;
  let q = db.collection('reports').orderBy('updatedAt', 'desc').limit(50);
  const docs = (await q.get()).docs.map(d => d.data());
  const filtered = type ? docs.filter(r => (r.mediaType || 'video') === type) : docs;
  res.json(filtered);
});

app.get('/api/reports/:id', async (req, res) => {
  const d = await db.doc(`reports/${req.params.id}`).get();
  d.exists ? res.json(d.data()) : res.status(404).json({error: 'not found'});
});

app.post('/api/check-key', async (req, res) => {
  const model = modelOf(req);
  if (!model) return res.status(400).json({ok: false, error: 'Unsupported Gemini model.'});
  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ok: false, needKey: true, error: 'No key provided.'});
  try {
    await ai.models.generateContent({model, contents: 'Reply with OK', config: {maxOutputTokens: 16}});
    res.json({ok: true});
  } catch (e) {
    res.status(isQuotaError(e) ? 429 : 400).json({ok: false, error: publicAiError(e, keyOf(req))});
  }
});

app.post('/api/seed', async (_, res) => {
  if (!BUCKET) return res.status(500).json({error: 'No bucket configured.'});
  const [files] = await gcs.bucket(BUCKET).getFiles({prefix: 'demo/'});
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
    }, {merge: true});
  }
  res.json({seeded: n});
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateDirs = [
  path.resolve('public'),
  path.resolve(__dirname, 'public'),
  path.resolve('frontend/dist'),
  path.resolve(__dirname, '../frontend/dist')
];
const staticDir = candidateDirs.find(d => fs.existsSync(path.join(d, 'index.html')));

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
          <p>To view the frontend application locally:</p>
          <ul>
            <li>Run Vite dev server: <code>cd frontend && npm run dev</code></li>
            <li>Or build frontend assets: <code>npm run build --prefix frontend</code></li>
          </ul>
        </body>
      </html>
    `);
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`TruthLens backend listening on http://localhost:${PORT}`);
  console.log(`  Project:   ${PROJECT_ID || '(using default ADC project)'}`);
  console.log(`  Bucket:    ${BUCKET || '(BUCKET not set)'}`);
  console.log(`  Firestore: ${FIRESTORE_DATABASE_ID}`);
  console.log(`  Fallback:  ${MODEL}`);
});
