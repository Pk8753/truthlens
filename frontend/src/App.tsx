import {useCallback, useEffect, useRef, useState} from 'react';

type Post = {id: string; creator: string; title: string; caption?: string; videoUrl: string};
type Claim = {text: string; verdict: string; explanation: string};
type Report = {id: string; status: 'processing' | 'done' | 'error'; creator?: string; title?: string; url?: string; postId?: string; sourceId?: string; model?: string; verdict?: string; confidence?: number; explanation?: string; claims?: Claim[]; sources?: {uri: string; title: string}[]; misleading?: string[]; nextSteps?: string[]; limitations?: string; transcript?: string; transcriptSummary?: string; error?: string; updatedAt?: number};
type ToastFn = (msg: string, kind?: 'ok' | 'err') => void;
type Prov = 'gemini' | 'vertex';

const MODEL_OPTIONS = [
  {id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash'},
  {id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash'},
  {id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite'},
  {id: 'gemini-3.5-flash-lite-preview', label: 'Gemini 3.5 Flash Lite Preview'},
  {id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview'},
  {id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview'},
  {id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite'},
  {id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash'},
  {id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite'}
] as const;
type ModelId = typeof MODEL_OPTIONS[number]['id'];
const DEFAULT_MODEL: ModelId = 'gemini-3.8-flash';
const getModel = (): ModelId => MODEL_OPTIONS.find(m => m.id === localStorage.getItem('ai_model'))?.id || DEFAULT_MODEL;
const normalizeModel = (value: string): ModelId => MODEL_OPTIONS.find(m => m.id === value)?.id || DEFAULT_MODEL;

/* ---------- keys: sessionStorage by default, localStorage only if "remember" is ticked ---------- */
const PROV: Prov[] = ['gemini', 'vertex'];
const getKey = (p: Prov) => localStorage.getItem('ai_key_' + p) || sessionStorage.getItem('ai_key_' + p) || '';
const setKey = (p: Prov, k: string, remember: boolean) => { localStorage.removeItem('ai_key_' + p); sessionStorage.removeItem('ai_key_' + p); if (k) (remember ? localStorage : sessionStorage).setItem('ai_key_' + p, k); };
const active = (): Prov => { const a = localStorage.getItem('ai_active') as Prov; return a && getKey(a) ? a : PROV.find(getKey) || 'gemini'; };
const api = async (path: string, body?: unknown) => {
  const p = active(), k = getKey(p); const h: Record<string, string> = {'Content-Type': 'application/json', 'x-ai-model': getModel()};
  if (k) { h['x-ai-key'] = k; h['x-ai-provider'] = p; }
  try { const r = await fetch('/api' + path, {method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined}); return await r.json(); }
  catch { return {error: 'Could not reach the server. Check your connection.'}; }
};

/* ---------- ui helpers ---------- */
const IC: Record<string, string> = {
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3 1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8 1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M7 4l13 8-13 8z', pause: 'M8 4v16M16 4v16', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5', upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z', vol: 'M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 010 6', mute: 'M11 5L6 9H3v6h3l5 4zM17 9l5 6M22 9l-5 6', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', doc: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6'
};
const Ic = ({n, s = 18}: {n: string; s?: number}) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n in IC ? IC[n] : n} /></svg>;
const V: Record<string, {label: string; c: string}> = {Supported: {label: 'Verified', c: '#1a7f37'}, Contradicted: {label: 'Contradicted', c: '#d1242f'}, Misleading: {label: 'Potentially misleading', c: '#c2570c'}, Mixed: {label: 'Mixed evidence', c: '#9a6700'}, 'Insufficient Evidence': {label: 'Inconclusive', c: '#6e6e73'}};
const Badge = ({v}: {v?: string}) => { const x = V[v || ''] || {label: v || '—', c: '#6e6e73'}; return <span className="badge" style={{color: x.c, background: x.c + '14', borderColor: x.c + '40'}}>{x.label}</span>; };
const ytThumb = (u?: string) => { const m = u?.match(/(?:v=|youtu\.be\/)([\w-]{11})/); return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : ''; };
const ytOk = (u: string) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)[\w-]{11}|youtu\.be\/[\w-]{11})/.test(u.trim());
const when = (t?: number) => (t ? new Date(t).toLocaleString() : '');

type KeyFrame = {timestamp: number; dataUrl: string};
const formatMediaTime = (time: number) => {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Extract a few real frames in the browser from TruthLens-hosted video media.
 *  This uses the same-origin /api/video endpoint; it does not attempt to capture
 *  pixels from YouTube's cross-origin player or send screenshots back to Gemini.
 */
async function extractKeyFrames(videoUrl: string): Promise<KeyFrame[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, {
    position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px',
    opacity: '0', pointerEvents: 'none'
  });
  document.body.appendChild(video);

  const waitFor = (eventName: 'loadedmetadata' | 'seeked', timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener('error', onError);
      if (err) reject(err); else resolve();
    };
    const onEvent = () => finish();
    const onError = () => finish(new Error('The browser could not decode this video.'));
    const timer = window.setTimeout(() => finish(new Error('Timed out while reading video frames.')), timeoutMs);
    video.addEventListener(eventName, onEvent, {once: true});
    video.addEventListener('error', onError, {once: true});
  });

  try {
    const loaded = waitFor('loadedmetadata', 15000);
    video.src = videoUrl;
    video.load();
    await loaded;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) return [];

    const marks = [...new Set([0.08, 0.33, 0.58, 0.83].map(ratio =>
      Number(Math.max(0, Math.min(Math.max(duration - 0.05, 0), duration * ratio)).toFixed(2))
    ))];
    const frames: KeyFrame[] = [];
    for (const timestamp of marks) {
      try {
        const sought = waitFor('seeked', 7000);
        video.currentTime = timestamp;
        await sought;
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
        const width = Math.min(640, video.videoWidth);
        const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.drawImage(video, 0, 0, width, height);
        frames.push({timestamp, dataUrl: canvas.toDataURL('image/jpeg', 0.72)});
      } catch {
        // A single failed seek should not prevent other representative frames.
      }
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/* ---------- report modal (real data only; polls the backend) ---------- */
function ReportModal({id, onClose}: {id: string; onClose: () => void}) {
  const [r, setR] = useState<Report>(); const [sec, setSec] = useState(0);
  const [frames, setFrames] = useState<KeyFrame[]>([]);
  const [framesLoading, setFramesLoading] = useState(false);
  const [framesError, setFramesError] = useState('');
  useEffect(() => {
    let t: number, dead = false; const tick = async () => { const d: Report = await api('/reports/' + id); if (dead) return; setR(d); if (d.status === 'processing') t = window.setTimeout(tick, 3000); };
    tick(); const c = window.setInterval(() => setSec(s => s + 1), 1000); return () => { dead = true; clearTimeout(t); clearInterval(c); };
  }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const reportId = r?.id;
  const reportStatus = r?.status;
  const reportPostId = r?.postId;
  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    setFramesError('');
    if (!reportId || reportStatus !== 'done' || !reportPostId) {
      setFramesLoading(false);
      return () => { cancelled = true; };
    }
    setFramesLoading(true);
    extractKeyFrames(`/api/video/${encodeURIComponent(reportPostId)}`)
      .then(items => { if (!cancelled) setFrames(items); })
      .catch(() => { if (!cancelled) setFramesError('Frames could not be extracted in this browser. The transcript above is still available.'); })
      .finally(() => { if (!cancelled) setFramesLoading(false); });
    return () => { cancelled = true; };
  }, [reportId, reportStatus, reportPostId]);
  const busy = !r || r.status === 'processing';
  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label="Analysis report"><div className="sheet" onClick={e => e.stopPropagation()}>
      <div className="row"><span className="mu small">Investigation report</span><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic n="x" /></button></div>
      {busy ? <div style={{padding: '30px 0'}}><h2 className="sec" style={{fontSize: 26}}>Investigating…</h2>
        <p className="mu">Reading the video, extracting claims and checking sources. This usually takes 30–90 seconds.</p><div className="bar"><i /></div><span className="mu small">Elapsed {sec}s</span></div>
      : r.status === 'error' ? <div style={{padding: '20px 0'}}><h2 className="sec" style={{fontSize: 26}}>Analysis didn’t complete</h2><p className="mu">{r.error}</p>
        <p className="small mu">Check your AI key in Settings, then try again.</p></div>
      : <>
        <h2 className="sec" style={{fontSize: 28, marginTop: 8}}>{r.title || 'Untitled video'}</h2>
        <p className="mu small" style={{margin: 0}}>{r.creator ? `by ${r.creator} · ` : ''}Analysed {when(r.updatedAt)}</p>
        <p style={{margin: '16px 0 4px'}}><Badge v={r.verdict} /></p>
        <p className="mu small" style={{margin: 0}}>Assessment confidence: <b>{r.confidence ?? '—'}%</b> — how strong the evidence is for this assessment, not a guarantee the claim is true or false.</p>
        <p style={{marginTop: 14}}>{r.explanation}</p>
        {!!r.claims?.length && <><h3>Key claims</h3><ul>{r.claims.map((c, i) => <li key={i}><Badge v={c.verdict} /> <b>{c.text}</b><div className="mu small">{c.explanation}</div></li>)}</ul></>}
        {!!r.misleading?.length && <><h3>Potentially misleading elements</h3><ul>{r.misleading.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
        <h3>Sources consulted</h3>
        {r.sources?.length ? <ul>{r.sources.map(s => <li key={s.uri}><a href={s.uri} target="_blank" rel="noreferrer noopener">{s.title}</a></li>)}</ul> : <p className="mu small">No sources were retrieved, so treat this assessment with extra caution.</p>}
        {!!r.nextSteps?.length && <><h3>Recommended next steps</h3><ul>{r.nextSteps.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
        {r.limitations && <><h3>Limitations</h3><p className="mu small">{r.limitations}</p></>}
        <section aria-label="Transcript and key-frame evidence" style={{marginTop: 24, paddingTop: 18, borderTop: '1px solid #e5e5e7'}}>
          <h3 style={{marginTop: 0}}>Transcript &amp; key frames</h3>
          <p className="mu small" style={{marginTop: -4}}>AI-generated transcript for review. It can contain recognition errors and should be checked against the original video.</p>
          <h4 style={{margin: '16px 0 8px'}}>Transcript</h4>
          {r.transcript?.trim()
            ? <pre style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto', margin: 0, padding: 14, borderRadius: 12, border: '1px solid #e5e5e7', background: '#f7f7f8', color: '#242428', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6}}>{r.transcript}</pre>
            : <p className="mu small">No transcript text was returned for this video. This may mean speech was absent, unclear, or not transcribed successfully.</p>}
          <h4 style={{margin: '18px 0 8px'}}>Key-frame screenshots</h4>
          {r.postId
            ? framesLoading
              ? <p className="mu small">Extracting representative frames from the video…</p>
              : frames.length
                ? <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10}}>
                    {frames.map((frame, i) => <figure key={`${frame.timestamp}-${i}`} style={{margin: 0, minWidth: 0}}>
                      <img src={frame.dataUrl} alt={`Video frame at ${formatMediaTime(frame.timestamp)}`} loading="lazy" style={{display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', background: '#111', borderRadius: 10, border: '1px solid #e5e5e7'}} />
                      <figcaption className="mu small" style={{marginTop: 5}}>Frame at {formatMediaTime(frame.timestamp)}</figcaption>
                    </figure>)}
                  </div>
                : <p className="mu small">{framesError || 'No usable key frames could be extracted from this video.'}</p>
            : <p className="mu small">Key-frame screenshots are available for videos stored in the TruthLens feed. For public YouTube URL analyses, the transcript is shown here; this app does not capture screenshots from YouTube’s embedded player.</p>}
        </section>
      </>}
    </div></div>
  );
}

/* ---------- settings ---------- */
function Settings({onClose, toast}: {onClose: () => void; toast: ToastFn}) {
  const [vals, setVals] = useState<Record<Prov, string>>({gemini: getKey('gemini'), vertex: getKey('vertex')});
  const [rem, setRem] = useState(!!(localStorage.getItem('ai_key_gemini') || localStorage.getItem('ai_key_vertex')));
  const [model, setModel] = useState<ModelId>(getModel);
  const [act, setAct] = useState<Prov>(active()); const [st, setSt] = useState<Record<string, string>>({});
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const save = (p: Prov) => { const k = vals[p].trim(); if (k.length < 20) return toast('That key looks too short.', 'err'); setKey(p, k, rem); localStorage.setItem('ai_active', p); setAct(p); setSt(s => ({...s, [p]: 'Saved. Not verified yet.'})); toast('Key saved in this browser.'); };
  const remove = (p: Prov) => { setKey(p, '', false); setVals(v => ({...v, [p]: ''})); setSt(s => ({...s, [p]: ''})); toast('Key removed.'); };
  const test = async (p: Prov) => { if (!getKey(p)) return toast('Save the key first.', 'err'); localStorage.setItem('ai_active', p); setAct(p); setSt(s => ({...s, [p]: 'Checking with the server…'})); const d = await api('/check-key', {}); setSt(s => ({...s, [p]: d.ok ? 'Confirmed by the server ✓' : d.error || 'Key was rejected.'})); };
  const card = (p: Prov, title: string, label: string, note: JSX.Element) => (
    <div className="card" style={{boxShadow: 'none', marginTop: 14}}>
      <div className="row"><b>{title}</b>{getKey(p) && <span className="badge" style={{color: '#1a7f37', borderColor: '#1a7f3740', background: '#1a7f3714'}}>Key set</span>}</div>
      <label className="l" htmlFor={'k' + p}>{label}</label>
      <input id={'k' + p} className="field" type="password" autoComplete="off" spellCheck={false} value={vals[p]} onChange={e => setVals(v => ({...v, [p]: e.target.value}))} placeholder="Paste key" />
      <p className="mu small" style={{margin: '8px 0'}}>{note}</p>
      <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}><button className="btn primary sm" onClick={() => save(p)}>Save Key</button><button className="btn sm" onClick={() => test(p)}>Test with server</button><button className="btn sm" onClick={() => remove(p)}>Remove</button></div>
      <label className="small" style={{display: 'flex', gap: 8, marginTop: 12, alignItems: 'center'}}><input type="radio" name="act" checked={act === p} onChange={() => { setAct(p); localStorage.setItem('ai_active', p); }} /> Use this key for analyses</label>
      {st[p] && <p className="small" style={{margin: '8px 0 0'}}>{st[p]}</p>}
    </div>);
  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label="AI Configuration"><div className="sheet" onClick={e => e.stopPropagation()}>
      <div className="row"><h2 className="sec" style={{fontSize: 28, margin: 0}}>AI Configuration</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Ic n="x" /></button></div>
      <p className="mu small">Your key is sent only with analysis requests and is never stored on the server. If no key is set here, the server’s own key (if configured) is used.</p>
      <label className="l" htmlFor="ai-model">Analysis model</label>
      <select id="ai-model" className="field" value={model} onChange={e => { const next = normalizeModel(e.target.value); setModel(next); localStorage.setItem('ai_model', next); }}>
        {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      <p className="mu small">This model is used for key checks and video analyses. Availability depends on your Gemini or Vertex project.</p>
      {card('gemini', 'Option A · Google AI Studio / Gemini', 'Gemini API Key', <>Create one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">aistudio.google.com/apikey</a>.</>)}
      {card('vertex', 'Option B · Vertex AI', 'Vertex AI API Key', <>Must be a Vertex AI API key (express mode) compatible with this backend. Not every Vertex credential works as an API key. Use “Test with server” to confirm.</>)}
      <label className="small" style={{display: 'flex', gap: 8, marginTop: 16, alignItems: 'flex-start'}}><input type="checkbox" checked={rem} onChange={e => setRem(e.target.checked)} />
        <span>Remember keys on this device. Off by default: keys live only until you close the tab. If on, they stay in this browser’s storage, which other scripts or people with access to this device could read. Re-save a key after changing this.</span></label>
    </div></div>
  );
}

/* ---------- smartphone feed ---------- */
function Phone({posts, loading, sel, setSel, repOf, busy, onAnalyse, goUpload}: {posts: Post[]; loading: boolean; sel: number; setSel: (i: number) => void; repOf: (id: string) => Report | undefined; busy: string; onAnalyse: (id: string) => void; goUpload: () => void}) {
  const sc = useRef<HTMLDivElement>(null); const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const [muted, setMuted] = useState(true); const [playing, setPlaying] = useState(false); const [bad, setBad] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const root = sc.current; if (!root) return;
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.intersectionRatio > 0.6) setSel(Number((e.target as HTMLElement).dataset.i)); }), {root, threshold: [0.6]});
    root.querySelectorAll('.slide').forEach(s => io.observe(s)); return () => io.disconnect();
  }, [posts.length, setSel]);
  useEffect(() => { vids.current.forEach((v, i) => { if (!v) return; if (i === sel) { v.muted = muted; v.play().catch(() => setPlaying(false)); } else v.pause(); }); }, [sel, muted, posts.length]);
  useEffect(() => { const r = sc.current; if (r && r.clientHeight && Math.round(r.scrollTop / r.clientHeight) !== sel && sel < posts.length) r.scrollTo({top: sel * r.clientHeight, behavior: 'smooth'}); }, [sel, posts.length]);
  const go = (i: number) => i >= 0 && i < posts.length && setSel(i);
  const toggle = () => { const v = vids.current[sel]; if (v) v.paused ? v.play().catch(() => {}) : v.pause(); };
  return (
    <div className="phone" aria-label="Video feed"><div className="island" /><div className="screen">
      {loading ? <div className="skel" style={{height: '100%', borderRadius: 0}} />
      : !posts.length ? <div className="empty-phone"><b>No videos yet</b><span style={{opacity: .7, fontSize: 14}}>Add a video to start investigating.</span><button className="btn sm" onClick={goUpload}>Add a video</button></div>
      : <>
        <div className="scroller" ref={sc} tabIndex={0}>
          {posts.map((p, i) => { const r = repOf(p.id); return (
            <div className="slide" key={p.id} data-i={i}>
              {bad[p.id] ? <div className="vfail"><span>This video couldn’t be loaded.</span></div>
                : <video ref={el => { vids.current[i] = el; }} src={p.videoUrl} loop playsInline muted={muted} preload={Math.abs(i - sel) <= 1 ? 'auto' : 'metadata'} onClick={toggle}
                    onError={() => setBad(b => ({...b, [p.id]: true}))} onPlay={() => i === sel && setPlaying(true)} onPause={() => i === sel && setPlaying(false)} />}
              <div className="shade" />
              {r && <span className="chip">{r.status === 'done' ? <>● {V[r.verdict || '']?.label || 'Analysed'}</> : r.status === 'processing' ? 'Analysing…' : 'Analysis failed'}</span>}
              <div className="meta"><b>{p.title}</b><span>@{p.creator}</span>{p.caption && <p>{p.caption}</p>}
                <button className="btn primary full" disabled={busy === p.id} onClick={() => onAnalyse(p.id)}><Ic n="spark" s={16} />{busy === p.id ? 'Starting…' : r?.status === 'done' ? 'View Report' : 'Analyse This Video'}</button></div>
            </div>); })}
        </div>
        <div className="rail">
          <button onClick={() => go(sel - 1)} disabled={sel === 0} aria-label="Previous video"><Ic n="up" /></button>
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Ic n={playing ? 'pause' : 'play'} /></button>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'}><Ic n={muted ? 'mute' : 'vol'} /></button>
          <button onClick={() => go(sel + 1)} disabled={sel >= posts.length - 1} aria-label="Next video"><Ic n="down" /></button>
        </div></>}
    </div></div>
  );
}

/* ---------- upload ---------- */
function Upload({onDone, toast}: {onDone: (p: Post) => void; toast: ToastFn}) {
  const [file, setFile] = useState<File | null>(null); const [prev, setPrev] = useState(''); const [title, setTitle] = useState(''); const [creator, setCreator] = useState(''); const [caption, setCaption] = useState('');
  const [pct, setPct] = useState<number | null>(null); const [over, setOver] = useState(false); const inp = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (prev) URL.revokeObjectURL(prev); }, [prev]);
  const pick = (f?: File) => {
    if (!f) return;
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(f.type)) return toast('Please choose an MP4, WebM or MOV video.', 'err');
    if (f.size > 25 * 1024 * 1024) return toast('That video is over 25 MB. Choose a shorter clip.', 'err');
    setFile(f); setPrev(URL.createObjectURL(f)); if (!title) setTitle(f.name.replace(/\.\w+$/, ''));
  };
  const send = () => {
    if (!file) return;
    const q = new URLSearchParams({title: title.trim() || file.name, creator: creator.trim() || 'Uploader', caption: caption.trim()}); const x = new XMLHttpRequest();
    x.open('POST', '/api/upload?' + q); x.setRequestHeader('Content-Type', file.type);
    x.upload.onprogress = e => e.lengthComputable && setPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => { setPct(null); let d: any = {}; try { d = JSON.parse(x.responseText); } catch {}
      if (x.status < 300) { toast(d.duplicate ? 'This video is already in the feed.' : 'Video added to the feed.'); onDone(d); setFile(null); setPrev(''); setTitle(''); setCreator(''); setCaption(''); } else toast(d.error || 'Upload failed.', 'err'); };
    x.onerror = () => { setPct(null); toast('Network error during upload.', 'err'); }; setPct(0); x.send(file);
  };
  return (
    <section id="upload" style={{marginTop: 90}} aria-labelledby="up-h"><div className="grid2">
      <div><h2 className="sec" id="up-h">Add a Video to TruthLens</h2><p className="mu">Bring a video into the feed and investigate its claims with AI.</p>
        <p className="mu small">MP4, WebM or MOV · up to 25 MB · short clips (under 2 minutes) work best. Duplicates are detected automatically.</p></div>
      <div>
        <div className={'drop' + (over ? ' over' : '')} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
          <Ic n="upload" s={28} /><p style={{margin: '8px 0'}}>Drag a video here, or</p>
          <button className="btn sm" onClick={() => inp.current?.click()}>Choose file</button>
          <input ref={inp} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={e => pick(e.target.files?.[0])} />
          {prev && <video src={prev} controls muted playsInline style={{width: '100%'}} />}
        </div>
        <label className="l" htmlFor="ut">Video title</label><input id="ut" className="field" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} />
        <label className="l" htmlFor="uc">Creator name</label><input id="uc" className="field" value={creator} maxLength={60} onChange={e => setCreator(e.target.value)} />
        <label className="l" htmlFor="ud">Caption (optional)</label><input id="ud" className="field" value={caption} maxLength={300} onChange={e => setCaption(e.target.value)} />
        {pct !== null && <div className="prog" role="progressbar" aria-valuenow={pct}><i style={{width: pct + '%'}} /></div>}
        <p><button className="btn primary" disabled={!file || pct !== null} onClick={send}>{pct !== null ? `Uploading ${pct}%` : 'Upload video'}</button></p>
      </div></div></section>
  );
}

/* ---------- history ---------- */
function History({reports, posts, loading, onOpen}: {reports: Report[]; posts: Post[]; loading: boolean; onOpen: (id: string) => void}) {
  const [q, setQ] = useState(''); const [f, setF] = useState('all');
  const list = reports.filter(r => (f === 'all' || (f === 'pending' ? r.status !== 'done' : r.verdict === f)) && `${r.title || ''} ${r.creator || ''} ${r.url || ''} ${r.explanation || ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div><div style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22}}>
      <div style={{position: 'relative', flex: '1 1 240px'}}><span style={{position: 'absolute', left: 12, top: 11, color: '#6e6e73'}}><Ic n="search" s={16} /></span><input className="field" style={{paddingLeft: 36}} placeholder="Search investigations" aria-label="Search investigations" value={q} onChange={e => setQ(e.target.value)} /></div>
      <select className="field" style={{width: 'auto'}} aria-label="Filter by assessment" value={f} onChange={e => setF(e.target.value)}><option value="all">All assessments</option>{Object.entries(V).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}<option value="pending">In progress / failed</option></select></div>
      {loading ? <div className="hgrid">{[0, 1, 2].map(i => <div key={i} className="skel" style={{height: 280}} />)}</div>
      : !reports.length ? <div className="card" style={{textAlign: 'center', padding: 60}}><h2 className="sec" style={{fontSize: 26}}>No investigations yet.</h2><p className="mu">Your analysed videos and reports will appear here.</p></div>
      : !list.length ? <p className="mu">No investigations match your search.</p>
      : <div className="hgrid">{list.map(r => { const p = posts.find(x => x.id === (r.postId || r.id)); return (
        <div className="card hcard" key={r.id}>
          <div className="thumb">{p ? <video src={p.videoUrl + '#t=0.5'} preload="metadata" muted playsInline /> : ytThumb(r.url) ? <img src={ytThumb(r.url)} alt="" loading="lazy" /> : null}</div>
          <b>{r.title || r.url || 'Video'}</b>
          <div className="row"><span className="mu small">{when(r.updatedAt)}</span>{r.status === 'done' ? <Badge v={r.verdict} /> : <span className="mu small">{r.status === 'processing' ? 'In progress' : 'Failed'}</span>}</div>
          {r.explanation && <p className="mu small" style={{margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>{r.explanation}</p>}
          <button className="btn sm" onClick={() => onOpen(r.id)}>View Report</button></div>); })}</div>}
    </div>
  );
}

/* ---------- app ---------- */
export default function App() {
  const [tab, setTab] = useState<'feed' | 'url' | 'history'>('feed');
  const [posts, setPosts] = useState<Post[]>([]); const [reports, setReports] = useState<Report[]>([]); const [loadP, setLoadP] = useState(true); const [loadR, setLoadR] = useState(true);
  const [sel, setSel] = useState(0); const [open, setOpen] = useState<string>(); const [settings, setSettings] = useState(false); const [busy, setBusy] = useState('');
  const [url, setUrl] = useState(''); const [urlErr, setUrlErr] = useState(''); const [toasts, setToasts] = useState<{id: number; msg: string; kind: string}[]>([]); const [, force] = useState(0);
  const toast: ToastFn = useCallback((msg, kind = 'ok') => { const id = Math.random(); setToasts(t => [...t, {id, msg, kind}]); setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200); }, []);
  const loadPosts = useCallback(async (): Promise<Post[]> => { const d = await api('/posts'); setLoadP(false); if (Array.isArray(d)) { setPosts(d); return d; } toast(d.error || 'Could not load videos.', 'err'); return []; }, [toast]);
  const loadReports = useCallback(async () => { const d = await api('/reports'); if (Array.isArray(d)) setReports(d); setLoadR(false); }, []);
  useEffect(() => { loadPosts(); loadReports(); }, [loadPosts, loadReports]);
  const repOf = (id: string) => reports.find(r => r.sourceId === id || r.postId === id || r.id === id);
  const toDemo = (t: 'feed' | 'url') => { setTab(t); setTimeout(() => document.getElementById('demo')?.scrollIntoView({behavior: 'smooth'}), 60); };
  const start = async (body: object, pid = '') => {
    setBusy(pid || 'url'); const d = await api('/analyse', body); setBusy('');
    if (d.needKey) { toast(d.error, 'err'); setSettings(true); } else if (d.id) { setOpen(d.id); loadReports(); } else toast(d.error || 'Something went wrong.', 'err');
  };
  const submitUrl = () => { if (!ytOk(url)) return setUrlErr('Enter a public YouTube link, such as https://www.youtube.com/watch?v=… or https://youtu.be/…'); setUrlErr(''); start({url: url.trim()}); };
  const cur = posts[sel], curRep = cur && repOf(cur.id), hasKey = PROV.some(getKey);
  return (<>
    <header className="hdr"><div className="brand"><Ic n="M12 4a8 8 0 100 16 8 8 0 000-16zM21 21l-4.3-4.3" /> TruthLens</div>
      <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings" title={hasKey ? 'AI key set' : 'Add AI key'}><Ic n="gear" />{hasKey && <span className="keydot" />}</button></header>
    <div className="wrap">
      <section className="hero">
        <h1 className="hero-title rise">TruthLens — MerlionMinds Project</h1>
        <p className="sub rise" style={{animationDelay: '.12s'}}>See beyond the scroll. Discover what’s real.</p>
        <p className="desc rise" style={{animationDelay: '.24s'}}>An AI-powered video verification platform that helps you investigate claims, examine evidence, and make more informed decisions about the content you consume.</p>
        <div className="cta rise" style={{animationDelay: '.36s'}}><button className="btn primary" onClick={() => toDemo('feed')}>Explore Videos</button><button className="btn" onClick={() => toDemo('url')}>Analyse a Video</button></div>
        <div className="feats">{[['spark', 'AI-Powered Analysis', 'Gemini reads the video and isolates the claims worth checking.'], ['doc', 'Evidence-Based Insights', 'Each claim is weighed against what reliable sources say.'], ['shield', 'Transparent Source Verification', 'Every report links the sources it actually consulted.']].map(([i, t, d], k) =>
          <div className="feat rise" key={t} style={{animationDelay: .45 + k * .1 + 's'}}><Ic n={i} s={22} /><b>{t}</b><span>{d}</span></div>)}</div>
      </section>
      <div id="demo" style={{scrollMarginTop: 70}}>
        <div className="tabs" role="tablist">{([['feed', 'Explore Feed'], ['url', 'Analyse by URL'], ['history', 'History']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="panel" key={tab}>
          {tab === 'feed' && <>
            <div className="layout">
              <aside><h2 className="sec">Scroll. Select. Investigate.</h2><p className="mu">Browse videos in the phone, then let AI examine what they claim.</p>
                <ol className="steps"><li><i>1</i>Swipe or use the arrows to choose a video.</li><li><i>2</i>Press Analyse This Video.</li><li><i>3</i>Review claims, evidence and sources.</li></ol>
                <button className="btn" onClick={() => document.getElementById('upload')?.scrollIntoView({behavior: 'smooth'})}><Ic n="upload" s={16} />Add your own video</button></aside>
              <Phone posts={posts} loading={loadP} sel={sel} setSel={setSel} repOf={repOf} busy={busy} onAnalyse={id => start({postId: id}, id)} goUpload={() => document.getElementById('upload')?.scrollIntoView({behavior: 'smooth'})} />
              <aside><div className="card insight" aria-live="polite">
                <span className="mu small">Selected video</span><h3 style={{margin: '4px 0 8px', fontSize: 20, letterSpacing: '-.02em'}}>{cur?.title || '—'}</h3>
                {!cur ? <p className="mu small">No video selected.</p>
                : !curRep ? <p className="mu small">Not analysed yet. Press <b>Analyse This Video</b> to investigate its claims. Results come from the AI and live sources, never placeholders.</p>
                : curRep.status === 'processing' ? <><p className="mu small">Analysis in progress…</p><div className="bar"><i /></div><button className="btn sm" onClick={() => setOpen(curRep.id)}>Watch progress</button></>
                : curRep.status === 'error' ? <p className="mu small">The last analysis failed: {curRep.error}</p>
                : <><Badge v={curRep.verdict} /><p className="mu small" style={{margin: '6px 0'}}>Confidence {curRep.confidence}% · {when(curRep.updatedAt)}</p>
                  <p className="small" style={{display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '0 0 12px'}}>{curRep.explanation}</p><button className="btn sm" onClick={() => setOpen(curRep.id)}>Open full report</button></>}
              </div></aside>
            </div>
            <Upload toast={toast} onDone={async p => { const l = await loadPosts(); const i = l.findIndex(x => x.id === p.id); if (i >= 0) setSel(i); }} />
          </>}
          {tab === 'url' && <div className="card" style={{maxWidth: 640, margin: '0 auto', textAlign: 'center', padding: 'clamp(24px,5vw,44px)'}}>
            <h2 className="sec">Investigate Any Video</h2><p className="mu">Paste a video URL to begin your analysis.</p>
            <div style={{display: 'flex', gap: 8, margin: '22px 0 6px', flexWrap: 'wrap'}}><input className="field" style={{flex: '1 1 260px'}} type="url" inputMode="url" placeholder="https://www.youtube.com/watch?v=…" aria-label="Video URL" aria-invalid={!!urlErr} value={url} onChange={e => { setUrl(e.target.value); setUrlErr(''); }} onKeyDown={e => e.key === 'Enter' && submitUrl()} />
              <button className="btn primary" disabled={busy === 'url' || !url.trim()} onClick={submitUrl}><Ic n="link" s={16} />{busy === 'url' ? 'Starting…' : 'Analyse Video'}</button></div>
            {urlErr ? <p className="small" style={{color: '#d1242f', margin: '8px 0'}} role="alert">{urlErr}</p> : <p className="mu small">Public YouTube videos are supported today. Other platforms can’t be processed yet.</p>}
          </div>}
          {tab === 'history' && <History reports={reports} posts={posts} loading={loadR} onOpen={setOpen} />}
        </div>
      </div>
    </div>
    <footer className="footer"><q>Lets not swamped by useless content anymore</q><span className="mu small">Built by MerlionMinds | TruthLens AI</span></footer>
    {open && <ReportModal id={open} onClose={() => { setOpen(undefined); loadReports(); }} />}
    {settings && <Settings toast={toast} onClose={() => { setSettings(false); force(n => n + 1); }} />}
    <div className="toasts" aria-live="polite">{toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}</div>
  </>);
}
