import express from 'express';
import crypto from 'crypto';
import {Firestore} from '@google-cloud/firestore';
import {Storage} from '@google-cloud/storage';
import {GoogleGenAI} from '@google/genai';

const {BUCKET, MODEL = 'gemini-3.8-flash', GEMINI_API_KEY} = process.env;
const PIPELINE_VERSION = 'transcript-evidence-v3';
const MAX_CLAIMS = 5;
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
const db = new Firestore(), gcs = new Storage();
const app = express(); app.disable('x-powered-by'); app.use(express.json({limit: '50kb'}));
app.use((_, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
process.on('unhandledRejection', e => console.error('unhandled:', String(e?.message || e).slice(0, 300)));
// Express 4 does not catch async errors: wrap every async handler so a failure returns JSON instead of crashing the container
for (const m of ['get', 'post']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => orig(path, ...hs.map(fn => fn?.constructor?.name === 'AsyncFunction'
    ? (req, res, next) => fn(req, res, next).catch(e => { console.error(m, path, String(e?.message || e).slice(0, 300)); if (!res.headersSent) res.status(500).json({error: 'Server error: ' + String(e?.message || e).slice(0, 200)}); })
    : fn));
}
const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const keyOf = req => req.get('x-ai-key') || GEMINI_API_KEY; // user key wins; server key is only a fallback
const clientFor = req => { const k = keyOf(req); return k ? new GoogleGenAI(req.get('x-ai-provider') === 'vertex' ? {vertexai: true, apiKey: k} : {apiKey: k}) : null; };
const modelOf = req => {
  const requested = req.get('x-ai-model');
  return requested ? (MODELS.has(requested) ? requested : null) : MODEL;
};
const clean = (e, k) => { let m = String(e?.message || e); if (k) m = m.split(k).join('***'); return m.slice(0, 300); };
const PUB = `https://storage.googleapis.com/${BUCKET}/`; // legacy posts stored a public URL
const nameOf = p => p.gcsName || (p.videoUrl?.startsWith(PUB) ? decodeURIComponent(p.videoUrl.slice(PUB.length)) : null);

const VERDICTS = 'Supported | Contradicted | Misleading | Mixed | Insufficient Evidence';

async function toPart(src) {
  if (src.youtube) return {fileData: {fileUri: src.youtube, mimeType: 'video/mp4'}};
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 18 * 1024 * 1024) throw new Error('Video is larger than 18 MB. Use a shorter clip.');
  return {inlineData: {mimeType: src.mime === 'video/quicktime' ? 'video/mov' : src.mime, data: b.toString('base64')}};
}

function parseJsonResponse(response) {
  const raw = response?.text;
  if (!raw) throw new Error('The AI returned an empty response. Please try again.');
  try { return JSON.parse(raw); }
  catch { throw new Error('The AI returned an invalid structured response. Please retry.'); }
}

function isQuotaError(e) {
  const s = `${e?.status || ''} ${e?.code || ''} ${e?.message || ''}`.toLowerCase();
  return /429|resource_exhausted|rate.?limit|quota/.test(s);
}

function publicAiError(e, key) {
  if (isQuotaError(e)) return 'Gemini quota/rate limit reached. Check RPM and daily request limits, wait for the quota reset, or use a project with available quota.';
  const status = Number(e?.status || e?.code);
  if (status === 401 || status === 403) return 'The AI key or provider configuration was rejected. Check the key, enabled API, project and billing settings.';
  return clean(e, key);
}

async function generate(ai, model, contents, config = {}) {
  // Deliberately do not auto-retry 429s: daily/project quota errors will not be fixed by retrying,
  // and retries consume more requests against the user's tight RPM/RPD limits.
  return ai.models.generateContent({model, contents, config: {candidateCount: 1, ...config}});
}

async function analyse(ai, src, model) {
  // Call 1: prioritize spoken words. Video is supplied to Gemini because this app currently has
  // no dedicated speech-to-text/FFmpeg stage; the prompt tells the model not to infer claims from
  // visuals. Visual-only claims are deferred rather than guessed.
  const media = await toPart(src);
  const extResponse = await generate(ai, model, [{role: 'user', parts: [media, {text:
    `TRANSCRIPT-FIRST VIDEO REVIEW. Return a best-effort near-verbatim transcript of audible speech in the original language, capped at 5000 characters. Preserve qualifiers, dates, numbers, speaker attributions and meaningful wording. Mark genuinely unclear words as [unclear] instead of guessing. Do not summarize the transcript. Then extract at most ${MAX_CLAIMS} short, atomic, checkable factual claims from that speech. Ignore opinions, jokes, predictions, and unsupported implications. Do not infer claims from images, facial expressions, edits or on-screen graphics; visual-only claims are out of scope for this pass. Never strengthen a speaker's claim. Return only JSON with this shape: {"creator":string,"title":string,"transcript":string,"claims":[{"text":string,"category":"health"|"engineering"|"general"}]}. If no audible speech is present, transcript must be an empty string. If no checkable spoken claims exist, claims must be [].` }]}], {
      responseMimeType: 'application/json', maxOutputTokens: 2500
    });
  const ext = parseJsonResponse(extResponse);
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) throw new Error('The AI returned an invalid transcript response. Please retry.');
  const transcript = typeof ext.transcript === 'string' ? ext.transcript.trim().slice(0, 5000) : '';
  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => typeof c?.text === 'string' && c.text.trim()).map(c => ({
    text: c.text.trim().slice(0, 700),
    category: ['health', 'engineering', 'general'].includes(c.category) ? c.category : 'general'
  })) : [];
  const base = {creator: String(ext.creator || '').slice(0, 120), title: String(ext.title || '').slice(0, 200)};
  if (!claims.length) return {
    verdict: 'Insufficient Evidence', confidence: 0,
    explanation: 'No checkable factual claims were extracted from the spoken content.', claims: [], misleading: [], nextSteps: [],
    limitations: 'This pass prioritizes spoken claims. Visual-only claims, on-screen text, and audio/video forensic authenticity were not assessed.',
    ...base, transcript, sources: [], pipelineVersion: PIPELINE_VERSION
  };

  // Call 2: one grounded request verifies all claims and returns the final report directly.
  // This replaces up to three category-agent calls plus a separate synthesis call.
  const compactClaims = claims.map((c, i) => `${i + 1}. [${c.category}] ${c.text}`).join('\n');
  const verifyResponse = await generate(ai, model, [{role: 'user', parts: [{text:
    `You are a rigorous fact-checking analyst. Use Google Search grounding to verify each claim independently. Prefer primary sources and relevant authoritative sources: health—WHO/CDC/NHS/systematic reviews; engineering—standards bodies, peer-reviewed research, government or university sources; general—primary documents, official data and reputable reporting. Do not treat search snippets alone as conclusive. Preserve the claim's original scope and qualifiers. If sources conflict or evidence is weak, use Insufficient Evidence or Mixed. Do not claim a video is a deepfake or authentic: this pipeline does not run forensic authenticity detection.\n\nClaims:\n${compactClaims}\n\nReturn a concise JSON report: {"verdict": one of [${VERDICTS}], "confidence": integer 0-100 (strength of assessment, not probability of truth), "explanation": string, "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}], "misleading": [short strings; empty if none], "nextSteps": [2-3 short actions], "limitations": string}. Keep explanations concise. Mention material evidence gaps. Do not invent sources; cite URLs in the explanation only when available from grounding. Include no more than 8 unique grounded sources in the final report.`}]}], {
      tools: [{googleSearch: {}}], responseMimeType: 'application/json', maxOutputTokens: 3000
    });
  const rep = parseJsonResponse(verifyResponse);
  const grounding = verifyResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Map(grounding.filter(g => g?.web?.uri).map(g => [g.web.uri, {uri: g.web.uri, title: g.web.title || g.web.uri}])).values()].slice(0, 8);
  const validVerdicts = new Set(['Supported', 'Contradicted', 'Misleading', 'Mixed', 'Insufficient Evidence']);
  const claimResults = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS).map((c, i) => ({
    text: String(c?.text || claims[i]?.text || '').slice(0, 700),
    verdict: validVerdicts.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || 'No claim-level explanation was returned.').slice(0, 1200)
  })) : claims.map(c => ({text: c.text, verdict: 'Insufficient Evidence', explanation: 'The model did not return a claim-level assessment.'}));
  const overall = validVerdicts.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence';
  return {
    verdict: overall,
    confidence: Math.max(0, Math.min(100, Number.isFinite(Number(rep.confidence)) ? Math.round(Number(rep.confidence)) : 0)),
    explanation: String(rep.explanation || 'Insufficient explanation returned.').slice(0, 3000),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5).map(x => String(x).slice(0, 300)) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3).map(x => String(x).slice(0, 300)) : [],
    limitations: [String(rep.limitations || ''), 'Transcript-first pass: visual-only claims, on-screen text, and audio/video forensic authenticity were not assessed. The transcript is AI-generated and may contain recognition errors.'].filter(Boolean).join(' '),
    ...base, transcript, sources, pipelineVersion: PIPELINE_VERSION
  };
}

async function job(id, ai, src, meta, k, model) {
  try {
    const r = await analyse(ai, src, model);
    await db.doc(`reports/${id}`).set({...r, ...meta, id, model, status: 'done', updatedAt: Date.now()});
  } catch (e) {
    const m = publicAiError(e, k);
    console.error('Analysis failed:', m);
    await db.doc(`reports/${id}`).set({id, ...meta, model, status: 'error', error: m, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION});
  } finally {
    inFlight.delete(id);
  }
}

const ytId = u => {
  try {
    const x = new URL(u); if (!['http:', 'https:'].includes(x.protocol)) return null;
    const h = x.hostname.replace(/^(www\.|m\.)/, ''), ok = v => (/^[\w-]{11}$/.test(v || '') ? v : null);
    if (h === 'youtu.be') return ok(x.pathname.slice(1));
    if (h === 'youtube.com') return ok(x.pathname === '/watch' ? x.searchParams.get('v') : (x.pathname.match(/^\/(shorts|embed)\/([\w-]{11})/) || [])[2]);
  } catch {}
  return null;
};

app.get('/api/posts', async (_, res) => {
  const ps = (await db.collection('posts').orderBy('createdAt', 'desc').get()).docs.map(d => d.data()).filter(p => nameOf(p));
  res.json(ps.map(({gcsName, ...p}) => ({...p, videoUrl: `/api/video/${p.id}`})));
});

// Private bucket: stream the video through the server with Range support
app.get('/api/video/:id', async (req, res) => {
  const p = (await db.doc(`posts/${req.params.id}`).get()).data(), name = p && nameOf(p); if (!name) return res.sendStatus(404);
  try {
    const f = gcs.bucket(BUCKET).file(name), [m] = await f.getMetadata(), size = +m.size;
    let start = 0, end = size - 1; const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (r) {
      if (r[1] !== '') { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], size - 1); } else start = Math.max(size - +r[2], 0);
      if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set({'Content-Type': m.contentType || 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600'});
    f.createReadStream({start, end}).on('error', () => res.destroy()).pipe(res);
  } catch { res.sendStatus(404); }
});

const TYPES = {'video/mp4': 'iso', 'video/quicktime': 'iso', 'video/webm': 'webm'};
const sniff = b => (b.length < 12 ? null : b.subarray(4, 8).toString() === 'ftyp' ? 'iso' : (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ? 'webm' : null);
app.post('/api/upload', express.raw({type: '*/*', limit: '30mb'}), async (req, res) => {
  if (!BUCKET) return res.status(500).json({error: 'Storage is not configured on the server.'});
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!TYPES[mime] || !Buffer.isBuffer(b) || !b.length) return res.status(400).json({error: 'Upload an MP4, WebM or MOV video (max 30 MB).'});
  if (sniff(b) !== TYPES[mime]) return res.status(400).json({error: 'The file content does not match a valid video.'});
  const id = hash(b), ref = db.doc(`posts/${id}`), old = await ref.get();
  if (old.exists) { const {gcsName, ...p} = old.data(); return res.json({...p, videoUrl: `/api/video/${id}`, duplicate: true}); }
  const gcsName = `uploads/${id}`; await gcs.bucket(BUCKET).file(gcsName).save(b, {contentType: mime});
  const q = req.query, post = {id, creator: String(q.creator || 'Uploader').slice(0, 60), title: String(q.title || 'Untitled').slice(0, 120), caption: String(q.caption || '').slice(0, 300), gcsName, mime, createdAt: Date.now()};
  await ref.set(post); res.json({...post, gcsName: undefined, videoUrl: `/api/video/${id}`});
});

app.post('/api/seed', async (_, res) => { // optional bulk import: gs://BUCKET/demo/<creator>__<title>.mp4
  if (!BUCKET) return res.status(500).json({error: 'No bucket configured.'});
  const [files] = await gcs.bucket(BUCKET).getFiles({prefix: 'demo/'}); let n = 0;
  for (const f of files.filter(f => /\.(mp4|mov|webm)$/i.test(f.name))) {
    const [a, b] = f.name.replace(/^demo\/|\.\w+$/g, '').split('__').map(s => s.replace(/[-_]/g, ' '));
    await db.doc(`posts/${hash(f.name)}`).set({id: hash(f.name), creator: b ? a : 'Demo Creator', title: b || a, caption: '', gcsName: f.name, mime: f.metadata.contentType || 'video/mp4', createdAt: Date.now() + n++}, {merge: true});
  }
  res.json({seeded: n});
});

app.post('/api/check-key', async (req, res) => {
  const model = modelOf(req);
  if (!model) return res.status(400).json({ok: false, error: 'Unsupported Gemini model.'});
  const ai = clientFor(req); if (!ai) return res.status(401).json({ok: false, needKey: true, error: 'No key provided.'});
  try { await ai.models.generateContent({model, contents: 'Reply with OK', config: {maxOutputTokens: 16}}); res.json({ok: true}); }
  catch (e) { res.status(isQuotaError(e) ? 429 : 400).json({ok: false, error: publicAiError(e, keyOf(req))}); }
});

app.post('/api/analyse', async (req, res) => {
  const {postId, url} = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({error: 'Unsupported Gemini model.'});
  let sourceId, src, meta;
  if (postId) {
    const p = (await db.doc(`posts/${String(postId)}`).get()).data(), name = p && nameOf(p);
    if (!name) return res.status(404).json({error: 'Video not found.'});
    sourceId = p.id; src = {name, mime: p.mime || 'video/mp4'};
    meta = {creator: p.creator, title: p.title, postId: p.id};
  } else {
    const v = ytId(String(url || ''));
    if (!v) return res.status(400).json({error: 'Only public YouTube links are supported for now (youtube.com or youtu.be).'});
    const canon = `https://www.youtube.com/watch?v=${v}`;
    sourceId = hash(canon); src = {youtube: canon}; meta = {url: canon};
  }
  meta = {...meta, sourceId};
  const id = hash(`${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();
  if (old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION && old.model === model) return res.json({id, cached: true});
  if (inFlight.has(id) || (old?.status === 'processing' && old.pipelineVersion === PIPELINE_VERSION && Date.now() - Number(old.updatedAt || 0) < 300000)) {
    return res.json({id, cached: false, processing: true});
  }
  const ai = clientFor(req);
  if (!ai) return res.status(401).json({error: 'An AI key is required. Add one in Settings.', needKey: true});
  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({id, sourceId, model, status: 'processing', ...meta, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION});
  res.json({id, cached: false, processing: true});
  // Background work requires Cloud Run CPU to remain available after the response.
  void job(id, ai, src, meta, keyOf(req), model).catch(e => {
    inFlight.delete(id);
    console.error('Unexpected background-job failure:', publicAiError(e, keyOf(req)));
  });
});

app.get('/api/reports', async (_, res) => res.json((await db.collection('reports').orderBy('updatedAt', 'desc').limit(50).get()).docs.map(d => d.data())));
app.get('/api/reports/:id', async (req, res) => { const d = await db.doc(`reports/${req.params.id}`).get(); d.exists ? res.json(d.data()) : res.status(404).json({error: 'not found'}); });

app.use(express.static('public'));
app.get('*', (_, res) => res.sendFile('index.html', {root: 'public'}));
app.listen(process.env.PORT || 8080);
