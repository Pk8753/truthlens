import fs from 'fs';
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
  databaseId: FIRESTORE_DATABASE_ID
});
const gcs = new Storage({
  ...(PROJECT_ID ? {projectId: PROJECT_ID} : {})
});
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '50kb'}));
app.use((_, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
process.on('unhandledRejection', e => console.error('unhandled:', String(e?.message || e).slice(0, 300)));

// Express 4 does not catch async errors: wrap every async handler so a failure returns JSON instead of crashing
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
const keyOf = req => req.get('x-ai-key') || GEMINI_API_KEY; // user key wins; server key is only a fallback
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
  // Vertex AI native zero-copy GCS URI
  if (isVertex && BUCKET && src.name) {
    return {fileData: {fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'video/mp4'}};
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 25 * 1024 * 1024) throw new Error('Video is larger than 25 MB. Use a shorter clip.');
  return {inlineData: {mimeType: src.mime === 'video/quicktime' ? 'video/mov' : src.mime, data: b.toString('base64')}};
}

function parseJsonResponse(response) {
  const raw = response?.text;
  if (!raw) throw new Error('The AI returned an empty response. Please try again.');
  try { return JSON.parse(raw); }
  catch {
    // Attempt markdown block regex cleanup if model added ```json wrappers
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
    return 'Gemini quota or rate limit reached (RPM/TPD). Wait a moment before retrying, or check your API key quota settings.';
  }
  const status = Number(e?.status || e?.code);
  if (status === 401 || status === 403) {
    return 'The AI key or provider configuration was rejected. Check your key, enabled APIs, and billing status.';
  }
  return clean(e, key);
}

async function generate(ai, model, contents, config = {}) {
  // Deliberately do not auto-retry 429s: daily/project quota errors will not be fixed by retrying
  return ai.models.generateContent({model, contents, config: {candidateCount: 1, ...config}});
}

async function analyse(ai, src, model, isVertex, options = {}) {
  const {sourceId, forceRescan = false, refreshFactCheckOnly = false} = options;

  let ext = null;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;

  // Check Tier 1 Cache: Multimodal Video Extraction
  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) {
        ext = data;
      }
    }
  }

  // Pass 1: Tri-Track Multimodal Extraction (runs only on cache miss or forceRescan)
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
- Provide a best-effort near-verbatim transcript of audible speech in the original language (capped at 4000 characters). Note approximate timing or speaker if discernable.
- Detect voice synthesis or cloning indicators (unnatural prosody, robotic cadence, robotic frequency artifacts).

2. VISUAL & OCR TRACK:
- Extract notable on-screen text, chyrons, ticker headlines, captions, or graphic banners. Note approximate timestamps if visible.

3. SYNTHETIC MEDIA & DEEPFAKE FORENSICS:
- Inspect for visual manipulation: facial boundary warping, unnatural eye blink frequency, temporal frame splicing, lip-to-speech audio desync, or generative AI diffusion textures.
- Assign syntheticMediaRisk: "low" | "moderate" | "high" | "critical".
- Provide a concise 1-2 sentence forensic explanation.

4. CHECKABLE FACTUAL CLAIMS:
- Extract at most ${MAX_CLAIMS} short, atomic, checkable factual claims originating from either speech or on-screen text.
- For each claim, identify origin ("speech" or "on_screen_text") and category ("health" | "engineering" | "general" | "politics" | "breaking_news").
- Ignore subjective opinions, comedy, rhetorical questions, and predictions.

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
    ext.updatedAt = Date.now();

    // Persist Tier 1 Extraction Cache
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

  // If no checkable claims exist, return immediate multimodal report without burning grounding tokens
  if (!claims.length) {
    return {
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

  // Pass 2: Grounded Search Verification (Text-only tokens, high token efficiency)
  const compactClaims = claims.map((c, i) => `${i + 1}. [Origin: ${c.origin}${c.timestamp ? ` @ ${c.timestamp}` : ''}] [Category: ${c.category}] ${c.text}`).join('\n');
  const verifyResponse = await generate(ai, model, [{
    role: 'user',
    parts: [{
      text: `You are an elite newsroom fact-checking analyst. Use Google Search grounding to independently verify each claim.
Prefer authoritative, primary sources: scientific reviews (WHO/CDC/Nature), official records, government data, recognized news organizations. Do not invent sources.

Claims:
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
}
Keep explanations focused and factual.`
    }]
  }], {
    tools: [{googleSearch: {}}],
    responseMimeType: 'application/json',
    maxOutputTokens: 2500
  });

  const rep = parseJsonResponse(verifyResponse);
  const grounding = verifyResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Map(grounding.filter(g => g?.web?.uri).map(g => [g.web.uri, {uri: g.web.uri, title: g.web.title || g.web.uri}])).values()].slice(0, 8);
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
    verdict: overall,
    confidence: Math.max(0, Math.min(100, Number.isFinite(Number(rep.confidence)) ? Math.round(Number(rep.confidence)) : 0)),
    explanation: String(rep.explanation || 'Insufficient explanation returned.').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5).map(x => String(x).slice(0, 300)) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3).map(x => String(x).slice(0, 300)) : [],
    limitations: [
      String(rep.limitations || ''),
      'Multimodal analysis includes speech transcription, on-screen text (OCR), synthetic media heuristics, and grounded web search. Confidence represents evidence strength, not absolute mathematical certainty.'
    ].filter(Boolean).join(' '),
    ...base,
    transcript,
    ocrText,
    syntheticMedia,
    sources,
    pipelineVersion: PIPELINE_VERSION
  };
}

async function job(id, ai, src, meta, k, model, isVertex, options) {
  await acquireSlot();
  try {
    const r = await analyse(ai, src, model, isVertex, options);
    await db.doc(`reports/${id}`).set({
      ...r,
      ...meta,
      id,
      model,
      status: 'done',
      updatedAt: Date.now()
    });
  } catch (e) {
    const m = publicAiError(e, k);
    console.error('Analysis failed for', id, ':', m);
    await db.doc(`reports/${id}`).set({
      id,
      ...meta,
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

// Canonical YouTube URL parser: strips tracking parameters and standardizes path
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

app.get('/api/posts', async (_, res) => {
  const ps = (await db.collection('posts').orderBy('createdAt', 'desc').get()).docs.map(d => d.data()).filter(p => nameOf(p));
  res.json(ps.map(({gcsName, ...p}) => ({...p, videoUrl: `/api/video/${p.id}`})));
});

// Private bucket: stream the video through the server with HTTP Range support
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

const TYPES = {'video/mp4': 'iso', 'video/quicktime': 'iso', 'video/webm': 'webm'};
const sniff = b => (b.length < 12 ? null : b.subarray(4, 8).toString() === 'ftyp' ? 'iso' : (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ? 'webm' : null);

// Ingestion with SHA-256 deduplication
app.post('/api/upload', express.raw({type: '*/*', limit: '30mb'}), async (req, res) => {
  if (!BUCKET) return res.status(500).json({error: 'Storage is not configured on the server.'});
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!TYPES[mime] || !Buffer.isBuffer(b) || !b.length) return res.status(400).json({error: 'Upload an MP4, WebM or MOV video (max 30 MB).'});
  if (sniff(b) !== TYPES[mime]) return res.status(400).json({error: 'The file content does not match a valid video.'});

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

// Analyse endpoint: handles cache checks, deduplication, re-runs, and rate throttling
app.post('/api/analyse', async (req, res) => {
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
  meta = {...meta, sourceId};

  const id = hash(`${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();

  // Zero-cost cache return if report is already complete and no re-run was requested
  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION && old.model === model) {
    return res.json({id, cached: true, report: old});
  }

  // Prevent duplicate concurrent requests for the same report
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
    status: 'processing',
    ...meta,
    updatedAt: Date.now(),
    pipelineVersion: PIPELINE_VERSION
  });

  res.json({id, cached: false, processing: true});

  // Background execution with container CPU guarantee
  const isVertex = isVertexOf(req);
  void job(id, ai, src, meta, keyOf(req), model, isVertex, {sourceId, forceRescan, refreshFactCheckOnly}).catch(e => {
    inFlight.delete(id);
    console.error('Unexpected background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.get('/api/reports', async (_, res) => {
  res.json((await db.collection('reports').orderBy('updatedAt', 'desc').limit(50).get()).docs.map(d => d.data()));
});

app.get('/api/reports/:id', async (req, res) => {
  const d = await db.doc(`reports/${req.params.id}`).get();
  d.exists ? res.json(d.data()) : res.status(404).json({error: 'not found'});
});

app.get('/api/extractions/:sourceId', async (req, res) => {
  const d = await db.doc(`extractions/${req.params.sourceId}`).get();
  d.exists ? res.json(d.data()) : res.status(404).json({error: 'not found'});
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`TruthLens backend listening on http://localhost:${PORT}`);
  console.log(`  Project:   ${PROJECT_ID || '(using default ADC project)'}`);
  console.log(`  Bucket:    ${BUCKET || '(BUCKET not set)'}`);
  console.log(`  Firestore: ${FIRESTORE_DATABASE_ID}`);
  console.log(`  Fallback:  ${MODEL}`);
});

