import express from 'express';
import crypto from 'crypto';
import {Firestore} from '@google-cloud/firestore';
import {Storage} from '@google-cloud/storage';
import {GoogleGenAI} from '@google/genai';

const {BUCKET, MODEL = 'gemini-2.5-flash', GEMINI_API_KEY} = process.env;
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
const clean = (e, k) => { let m = String(e?.message || e); if (k) m = m.split(k).join('***'); return m.slice(0, 300); };
const PUB = `https://storage.googleapis.com/${BUCKET}/`; // legacy posts stored a public URL
const nameOf = p => p.gcsName || (p.videoUrl?.startsWith(PUB) ? decodeURIComponent(p.videoUrl.slice(PUB.length)) : null);

const AGENTS = {
  health: 'You are a medical fact-checking specialist. Prefer WHO, CDC, NHS, Cochrane, PubMed.',
  engineering: 'You are an engineering/physics fact-checking specialist. Prefer standards bodies, textbooks, peer-reviewed papers, .edu/.gov sources.',
  general: 'You are a general fact-checking specialist. Prefer primary sources, major fact-checkers and reputable news.'
};
const VERDICTS = 'Supported | Contradicted | Misleading | Mixed | Insufficient Evidence';

async function toPart(src) {
  if (src.youtube) return {fileData: {fileUri: src.youtube, mimeType: 'video/mp4'}};
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 18 * 1024 * 1024) throw new Error('Video is larger than 18 MB. Use a shorter clip.');
  return {inlineData: {mimeType: src.mime === 'video/quicktime' ? 'video/mov' : src.mime, data: b.toString('base64')}};
}

async function analyse(ai, src) {
  const run = (parts, config = {}) => ai.models.generateContent({model: MODEL, contents: [{role: 'user', parts}], config});
  const json = async parts => JSON.parse((await run(parts, {responseMimeType: 'application/json'})).text);
  const ext = await json([await toPart(src), {text: 'Watch this content. Extract up to 5 checkable factual claims (ignore opinions). If there are none, return an empty claims array. Return JSON: {"creator":string,"title":string,"claims":[{"text":string,"category":"health"|"engineering"|"general"}]}'}]);
  if (!ext.claims?.length) return {verdict: 'Insufficient Evidence', confidence: 0, explanation: 'No checkable factual claims were found in this content.', claims: [], sources: [], misleading: [], nextSteps: [], limitations: 'Nothing to verify.', creator: ext.creator, title: ext.title};
  const sources = new Map(), evidence = [];
  for (const cat of Object.keys(AGENTS)) {
    const cl = ext.claims.filter(c => (AGENTS[c.category] ? c.category : 'general') === cat);
    if (!cl.length) continue;
    const r = await run([{text: `${AGENTS[cat]}\nUse search. For each claim, state what reliable sources say and whether they support, contradict or leave it unresolved.\nClaims:\n${cl.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}`}], {tools: [{googleSearch: {}}]});
    (r.candidates?.[0]?.groundingMetadata?.groundingChunks || []).forEach(g => g.web && sources.set(g.web.uri, g.web.title || g.web.uri));
    evidence.push(`[${cat}]\n${r.text}`);
  }
  const rep = await json([{text: `Using ONLY this evidence, judge the claims. If evidence is thin, say Insufficient Evidence.\nClaims: ${JSON.stringify(ext.claims)}\nEvidence:\n${evidence.join('\n\n')}\nReturn JSON: {"verdict":one of [${VERDICTS}],"confidence":0-100 (strength of the assessment, not probability the claim is true),"explanation":string,"claims":[{"text":string,"verdict":one of [${VERDICTS}],"explanation":string}],"misleading":[short strings describing misleading framing, omissions or manipulation; empty if none],"nextSteps":[2-3 short recommended actions for the viewer],"limitations":string}`}]);
  return {...rep, creator: ext.creator, title: ext.title, sources: [...sources].map(([uri, title]) => ({uri, title}))};
}

async function job(id, ai, src, meta, k) {
  try { const r = await analyse(ai, src); await db.doc(`reports/${id}`).set({...r, ...meta, id, status: 'done', updatedAt: Date.now()}); }
  catch (e) { const m = clean(e, k); console.error(m); await db.doc(`reports/${id}`).set({id, ...meta, status: 'error', error: m, updatedAt: Date.now()}); }
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
  const ai = clientFor(req); if (!ai) return res.status(401).json({ok: false, needKey: true, error: 'No key provided.'});
  try { await ai.models.generateContent({model: MODEL, contents: 'Reply with OK', config: {maxOutputTokens: 16}}); res.json({ok: true}); }
  catch (e) { res.status(400).json({ok: false, error: clean(e, keyOf(req))}); }
});

app.post('/api/analyse', async (req, res) => {
  const {postId, url} = req.body || {}; let id, src, meta;
  if (postId) {
    const p = (await db.doc(`posts/${String(postId)}`).get()).data(), name = p && nameOf(p); if (!name) return res.status(404).json({error: 'Video not found.'});
    id = p.id; src = {name, mime: p.mime || 'video/mp4'}; meta = {creator: p.creator, title: p.title, postId: p.id};
  } else {
    const v = ytId(String(url || '')); if (!v) return res.status(400).json({error: 'Only public YouTube links are supported for now (youtube.com or youtu.be).'});
    const canon = `https://www.youtube.com/watch?v=${v}`; id = hash(canon); src = {youtube: canon}; meta = {url: canon};
  }
  const old = (await db.doc(`reports/${id}`).get()).data();
  if (old && (old.status === 'done' || (old.status === 'processing' && Date.now() - old.updatedAt < 300000))) return res.json({id, cached: old.status === 'done'});
  const ai = clientFor(req);
  if (!ai) return res.status(401).json({error: 'An AI key is required. Add one in Settings.', needKey: true});
  await db.doc(`reports/${id}`).set({id, status: 'processing', ...meta, updatedAt: Date.now()});
  res.json({id}); job(id, ai, src, meta, keyOf(req)); // background work: deploy with --no-cpu-throttling
});

app.get('/api/reports', async (_, res) => res.json((await db.collection('reports').orderBy('updatedAt', 'desc').limit(50).get()).docs.map(d => d.data())));
app.get('/api/reports/:id', async (req, res) => { const d = await db.doc(`reports/${req.params.id}`).get(); d.exists ? res.json(d.data()) : res.status(404).json({error: 'not found'}); });

app.use(express.static('public'));
app.get('*', (_, res) => res.sendFile('index.html', {root: 'public'}));
app.listen(process.env.PORT || 8080);
