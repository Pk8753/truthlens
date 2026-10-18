import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { BUCKET, PIPELINE_VERSION, FEATURE_AUDIO_ENABLED } from './lib/config.js';
import { db, gcs } from './lib/db.js';
import { acquireSlot, releaseSlot, inFlight, getQueueStats, publicAiError, clientFor, modelOf, keyOf, isVertexOf, quotaModeOf, useSearchOf, generate, isQuotaError } from './lib/ai.js';
import { analyseVideo, analyseAudio, analyseArticle, nameOf } from './lib/pipelines.js';
import { hash, ytId, fetchArticleContent, checkUploadLimit } from './lib/utils.js';

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

// Background job executor with semaphore
async function job(id, ai, type, src, meta, k, model, isVertex, options) {
  await acquireSlot();
  try {
    let r;
    if (type === 'audio') r = await analyseAudio(ai, src, model, isVertex, options);
    else if (type === 'article') r = await analyseArticle(ai, src, model, isVertex, options);
    else r = await analyseVideo(ai, src, model, isVertex, options);
    await db.doc(`reports/${id}`).set({ ...r, ...meta, id, mediaType: type, model, status: 'done', updatedAt: Date.now() });
  } catch (e) {
    const errMsg = publicAiError(e, k);
    console.error(`Analysis failed for ${type} ${id}:`, errMsg);
    await db.doc(`reports/${id}`).set({ id, ...meta, mediaType: type, model, status: 'error', error: errMsg, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION });
  } finally {
    releaseSlot();
    inFlight.delete(id);
  }
}

// ------- VIDEO STREAMING -------
app.get('/api/posts', async (_, res) => {
  const ps = (await db.collection('posts').orderBy('createdAt', 'desc').get()).docs.map(d => d.data()).filter(p => nameOf(p));
  res.json(ps.map(({ gcsName, ...p }) => ({ ...p, videoUrl: `/api/video/${p.id}` })));
});

const streamGcs = async (res, bucketFile, defaultMime, rangeHeader) => {
  const [m] = await bucketFile.getMetadata();
  const size = +m.size;
  let start = 0, end = size - 1;
  const r = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (r) {
    if (r[1] !== '') { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], size - 1); }
    else start = Math.max(size - +r[2], 0);
    if (start > end || start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.set({ 'Content-Type': m.contentType || defaultMime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600' });
  bucketFile.createReadStream({ start, end }).on('error', () => res.destroy()).pipe(res);
};

app.get('/api/video/:id', async (req, res) => {
  const p = (await db.doc(`posts/${req.params.id}`).get()).data(), name = p && nameOf(p);
  if (!name) return res.sendStatus(404);
  try { await streamGcs(res, gcs.bucket(BUCKET).file(name), 'video/mp4', req.headers.range); } catch { res.sendStatus(404); }
});

app.get('/api/audio/:id', async (req, res) => {
  const a = (await db.doc(`audios/${req.params.id}`).get()).data();
  if (!a || !a.gcsName) return res.sendStatus(404);
  try { await streamGcs(res, gcs.bucket(BUCKET).file(a.gcsName), 'audio/mp3', req.headers.range); } catch { res.sendStatus(404); }
});

// ------- UPLOAD ROUTES -------
const VIDEO_TYPES = { 'video/mp4': 'iso', 'video/quicktime': 'iso', 'video/webm': 'webm' };
const AUDIO_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg' };
const sniffVideo = b => (b.length < 12 ? null : b.subarray(4, 8).toString() === 'ftyp' ? 'iso' : (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) ? 'webm' : null);
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();

app.post('/api/upload', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'Storage is not configured on the server.' });
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!VIDEO_TYPES[mime] || !Buffer.isBuffer(b) || !b.length) return res.status(400).json({ error: 'Upload an MP4, WebM or MOV video (max 25 MB).' });
  if (sniffVideo(b) !== VIDEO_TYPES[mime]) return res.status(400).json({ error: 'The file content does not match a valid video.' });

  // Check daily upload limit
  const ip = clientIp(req);
  const limitResult = await checkUploadLimit(ip, 'video');
  if (!limitResult.allowed) {
    return res.status(429).json({ error: 'Daily upload limit reached (10 videos per day). This app is in demo mode.', limitReached: true, limit: limitResult.limit });
  }

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
  const post = { id, creator: String(q.creator || 'Uploader').slice(0, 60), title: String(q.title || 'Untitled').slice(0, 120), caption: String(q.caption || '').slice(0, 300), gcsName, mime, createdAt: Date.now() };
  await ref.set(post);
  res.json({ ...post, gcsName: undefined, videoUrl: `/api/video/${id}` });
});

app.post('/api/upload/audio', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'Storage is not configured on the server.' });
  if (!FEATURE_AUDIO_ENABLED) return res.status(403).json({ error: 'Audio Lab is disabled in this deployment.' });
  const mime = (req.get('content-type') || '').split(';')[0], b = req.body;
  if (!AUDIO_TYPES[mime] && !mime.startsWith('audio/')) return res.status(400).json({ error: 'Please upload an MP3, WAV, or M4A audio file (max 25 MB).' });
  if (!Buffer.isBuffer(b) || !b.length) return res.status(400).json({ error: 'Empty audio buffer.' });

  const ip = clientIp(req);
  const limitResult = await checkUploadLimit(ip, 'audio');
  if (!limitResult.allowed) {
    return res.status(429).json({ error: 'Daily upload limit reached (10 audio files per day). This app is in demo mode.', limitReached: true, limit: limitResult.limit });
  }

  const id = hash(b);
  const ref = db.doc(`audios/${id}`);
  const old = await ref.get();
  if (old.exists) return res.json({ ...old.data(), audioUrl: `/api/audio/${id}`, duplicate: true });

  const gcsName = `audio/${id}`;
  await gcs.bucket(BUCKET).file(gcsName).save(b, { contentType: mime || 'audio/mp3' });
  const q = req.query;
  const audioDoc = { id, creator: String(q.creator || 'Audio Source').slice(0, 60), title: String(q.title || 'Audio Recording').slice(0, 120), gcsName, mime: mime || 'audio/mp3', createdAt: Date.now() };
  await ref.set(audioDoc);
  res.json({ ...audioDoc, audioUrl: `/api/audio/${id}` });
});

// ------- ANALYSE ROUTES -------
app.post(['/api/analyse', '/api/analyse/video'], async (req, res) => {
  const { postId, url, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  let sourceId, src, meta;
  if (postId) {
    const p = (await db.doc(`posts/${String(postId)}`).get()).data(), name = p && nameOf(p);
    if (!name) return res.status(404).json({ error: 'Video not found.' });
    sourceId = p.id; src = { name, mime: p.mime || 'video/mp4' }; meta = { creator: p.creator, title: p.title, postId: p.id };
  } else {
    const v = ytId(String(url || ''));
    if (!v) return res.status(400).json({ error: 'Only public YouTube links are supported (youtube.com or youtu.be).' });
    const canon = `https://www.youtube.com/watch?v=${v}`;
    sourceId = hash(canon); src = { youtube: canon }; meta = { url: canon };
  }
  meta = { ...meta, sourceId, mediaType: 'video' };

  const id = hash(`${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();
  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) return res.json({ id, cached: true, report: old });
  if (inFlight.has(id) || (!forceRescan && old?.status === 'processing' && Date.now() - Number(old.updatedAt || 0) < 180000)) return res.json({ id, cached: false, processing: true });

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({ id, sourceId, model, mediaType: 'video', status: 'processing', ...meta, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION });
  res.json({ id, cached: false, processing: true });

  const isVertex = isVertexOf(req), quotaMode = quotaModeOf(req), useSearch = useSearchOf(req);
  void job(id, ai, 'video', src, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => { inFlight.delete(id); console.error('Video bg-job failure:', publicAiError(e, keyOf(req))); });
});

app.post('/api/analyse/audio', async (req, res) => {
  if (!FEATURE_AUDIO_ENABLED) return res.status(403).json({ error: 'Audio Lab is disabled in this deployment.' });
  const { audioId, url, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  let sourceId, src, meta;
  if (audioId) {
    const a = (await db.doc(`audios/${String(audioId)}`).get()).data();
    if (!a || !a.gcsName) return res.status(404).json({ error: 'Audio record not found.' });
    sourceId = a.id; src = { name: a.gcsName, mime: a.mime || 'audio/mp3' }; meta = { creator: a.creator, title: a.title, audioId: a.id };
  } else if (url) {
    sourceId = hash(String(url).trim()); src = { url: String(url).trim() }; meta = { url: String(url).trim(), title: 'Remote Audio Stream' };
  } else {
    return res.status(400).json({ error: 'Please provide an audioId or audio URL.' });
  }
  meta = { ...meta, sourceId, mediaType: 'audio' };

  const id = hash(`audio:${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();
  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) return res.json({ id, cached: true, report: old });
  if (inFlight.has(id)) return res.json({ id, cached: false, processing: true });

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({ id, sourceId, model, mediaType: 'audio', status: 'processing', ...meta, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION });
  res.json({ id, cached: false, processing: true });

  const isVertex = isVertexOf(req), quotaMode = quotaModeOf(req), useSearch = useSearchOf(req);
  void job(id, ai, 'audio', src, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => { inFlight.delete(id); console.error('Audio bg-job failure:', publicAiError(e, keyOf(req))); });
});

app.post('/api/analyse/article', async (req, res) => {
  let { url, text, title, author, forceRescan, refreshFactCheckOnly } = req.body || {};
  const model = modelOf(req);
  if (!model) return res.status(400).json({ error: 'Unsupported Gemini model.' });

  if (url && !text && !refreshFactCheckOnly) {
    try { const scraped = await fetchArticleContent(url); text = scraped.text; if (!title) title = scraped.title; }
    catch (e) { return res.status(400).json({ error: `Could not fetch article URL: ${e.message}` }); }
  }
  if (!refreshFactCheckOnly && (!text || String(text).trim().length < 50)) return res.status(400).json({ error: 'Article content must be at least 50 characters.' });

  const cleanUrl = url ? String(url).trim() : '';
  const sourceId = hash(cleanUrl ? cleanUrl : String(text || '').trim().slice(0, 1000));
  const id = hash(`article:${sourceId}:${model}`);
  const old = (await db.doc(`reports/${id}`).get()).data();
  const effectiveUrl = cleanUrl || old?.url || undefined;
  const meta = {
    ...(effectiveUrl ? { url: effectiveUrl } : {}),
    title: title || old?.title || 'Article Investigation',
    creator: author || old?.creator || 'Unknown Author',
    sourceId,
    mediaType: 'article'
  };

  if (!forceRescan && !refreshFactCheckOnly && old?.status === 'done' && old.pipelineVersion === PIPELINE_VERSION) return res.json({ id, cached: true, report: old });
  if (inFlight.has(id)) return res.json({ id, cached: false, processing: true });

  const ai = clientFor(req);
  if (!ai) return res.status(401).json({ error: 'An AI key is required. Add one in Settings.', needKey: true });

  inFlight.set(id, true);
  await db.doc(`reports/${id}`).set({ id, sourceId, model, mediaType: 'article', status: 'processing', ...meta, updatedAt: Date.now(), pipelineVersion: PIPELINE_VERSION });
  res.json({ id, cached: false, processing: true });

  const isVertex = isVertexOf(req), quotaMode = quotaModeOf(req), useSearch = useSearchOf(req);
  void job(id, ai, 'article', { text, url: effectiveUrl, title, author }, meta, keyOf(req), model, isVertex, { sourceId, forceRescan, refreshFactCheckOnly, quotaMode, useSearch }).catch(e => { inFlight.delete(id); console.error('Article bg-job failure:', publicAiError(e, keyOf(req))); });
});

// ------- DATA ROUTES -------
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
      if (r.verdict && byVerdict[r.verdict] !== undefined) byVerdict[r.verdict]++;
      const risk = r.syntheticMedia?.risk || 'low';
      if (byRisk[risk] !== undefined) byRisk[risk]++;
      if (risk === 'high' || risk === 'critical') criticalCount++;
    }
    const threatRate = total ? Math.round((criticalCount / total) * 100) : 0;
    const recent = docs.slice(0, 6);
    const { queueDepth, activeJobs } = getQueueStats();
    res.json({ total, byType, byVerdict, byRisk, threatRate, recent, queueDepth, activeJobs });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Could not compute dashboard stats' });
  }
});

app.get('/api/reports', async (req, res) => {
  const type = req.query.type;
  const q = db.collection('reports').orderBy('updatedAt', 'desc').limit(50);
  const docs = (await q.get()).docs.map(d => d.data());
  res.json(type ? docs.filter(r => (r.mediaType || 'video') === type) : docs);
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

// Feature flags endpoint (for frontend config)
app.get('/api/features', (_, res) => {
  res.json({ audioEnabled: FEATURE_AUDIO_ENABLED });
});

app.post('/api/seed', async (_, res) => {
  if (!BUCKET) return res.status(500).json({ error: 'No bucket configured.' });
  const [files] = await gcs.bucket(BUCKET).getFiles({ prefix: 'demo/' });
  let n = 0;
  for (const f of files.filter(f => /\.(mp4|mov|webm)$/i.test(f.name))) {
    const [a, b] = f.name.replace(/^demo\/|\.\w+$/g, '').split('__').map(s => s.replace(/[-_]/g, ' '));
    await db.doc(`posts/${hash(f.name)}`).set({ id: hash(f.name), creator: b ? a : 'Demo Creator', title: b || a, caption: '', gcsName: f.name, mime: f.metadata.contentType || 'video/mp4', createdAt: Date.now() + n++ }, { merge: true });
  }
  res.json({ seeded: n });
});

// ------- STATIC FRONTEND -------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateDirs = [path.resolve('public'), path.resolve(__dirname, 'public'), path.resolve('frontend/dist'), path.resolve(__dirname, '../frontend/dist')];
const staticDir = candidateDirs.find(d => fs.existsSync(path.join(d, 'index.html')));

const PORT = process.env.PORT || 8080;

if (staticDir) {
  app.use(express.static(staticDir));
  app.get('*', (_, res) => res.sendFile(path.join(staticDir, 'index.html'), err => { if (err && !res.headersSent) res.status(500).send('Error loading frontend assets.'); }));
} else {
  app.get('*', (_, res) => res.status(200).send(`<!DOCTYPE html><html><head><title>TruthLens API Server</title></head><body style="font-family:system-ui,sans-serif;background:#0b0f19;color:#f1f5f9;padding:40px"><h2>TruthLens Backend API Running</h2><p>The backend API is active on <code>http://localhost:${PORT}/api</code>.</p></body></html>`));
}

app.listen(PORT, () => {
  console.log(`TruthLens backend listening on http://localhost:${PORT}`);
  console.log(`  Audio Lab: ${FEATURE_AUDIO_ENABLED ? 'ENABLED' : 'DISABLED (set FEATURE_AUDIO_ENABLED=true to enable)'}`);
});