import { useCallback, useEffect, useRef, useState } from 'react';

type MediaType = 'video' | 'audio' | 'article';
type Post = { id: string; creator: string; title: string; caption?: string; videoUrl: string };
type Claim = {
  text: string;
  origin?: 'speech' | 'on_screen_text' | 'article_text';
  timestamp?: string;
  verdict: string;
  explanation: string;
};
type OcrBlock = { timestamp?: string; text: string };
type Quote = { speaker: string; quote: string };
type SyntheticMedia = {
  risk: 'low' | 'moderate' | 'high' | 'critical';
  confidence: number;
  reasoning: string;
  anomalies?: string[];
  cadenceScore?: number;
  voiceCloningDetected?: boolean;
  aiProbability?: number;
  sensationalismScore?: number;
};
type Report = {
  id: string;
  mediaType?: MediaType;
  status: 'processing' | 'done' | 'error';
  creator?: string;
  title?: string;
  url?: string;
  postId?: string;
  audioId?: string;
  sourceId?: string;
  model?: string;
  verdict?: string;
  confidence?: number;
  explanation?: string;
  claims?: Claim[];
  ocrText?: OcrBlock[];
  quotes?: Quote[];
  syntheticMedia?: SyntheticMedia;
  sources?: { uri: string; title: string }[];
  misleading?: string[];
  nextSteps?: string[];
  limitations?: string;
  transcript?: string;
  error?: string;
  updatedAt?: number;
};
type DashboardStats = {
  total: number;
  byType: { video: number; audio: number; article: number };
  byVerdict: Record<string, number>;
  byRisk: Record<string, number>;
  threatRate: number;
  recent: Report[];
};
type ToastFn = (msg: string, kind?: 'ok' | 'err') => void;
type Prov = 'gemini' | 'vertex';

// Replace MODEL_OPTIONS and helper functions at the top of frontend/src/App.tsx (lines 59-92):

const MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Recommended · Best Accuracy & Speed)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Balanced)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (Max Quota · 30 RPM Free Tier)' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' }
] as const;
type ModelId = typeof MODEL_OPTIONS[number]['id'];
const DEFAULT_MODEL: ModelId = 'gemini-3.5-flash';
const getModel = (): ModelId => MODEL_OPTIONS.find(m => m.id === localStorage.getItem('ai_model'))?.id || DEFAULT_MODEL;
const normalizeModel = (value: string): ModelId => MODEL_OPTIONS.find(m => m.id === value)?.id || DEFAULT_MODEL;

type QuotaMode = 'single_pass' | 'two_pass';
const getQuotaMode = (): QuotaMode => (localStorage.getItem('ai_quota_mode') === 'two_pass' ? 'two_pass' : 'single_pass');
const getUseSearch = (): boolean => localStorage.getItem('ai_use_search') !== 'false';

const PROV: Prov[] = ['gemini', 'vertex'];
const getKey = (p: Prov) => localStorage.getItem('ai_key_' + p) || sessionStorage.getItem('ai_key_' + p) || '';
const setKey = (p: Prov, k: string, remember: boolean) => {
  localStorage.removeItem('ai_key_' + p);
  sessionStorage.removeItem('ai_key_' + p);
  if (k) (remember ? localStorage : sessionStorage).setItem('ai_key_' + p, k);
};
const active = (): Prov => {
  const a = localStorage.getItem('ai_active') as Prov;
  return a && getKey(a) ? a : PROV.find(getKey) || 'gemini';
};
const api = async (path: string, body?: unknown) => {
  const p = active(), k = getKey(p);
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-ai-model': getModel(),
    'x-quota-mode': getQuotaMode(),
    'x-use-search': String(getUseSearch())
  };
  if (k) { h['x-ai-key'] = k; h['x-ai-provider'] = p; }
  try {
    const r = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: h,
      body: body ? JSON.stringify(body) : undefined
    });
    return await r.json();
  } catch {
    return { error: 'Could not reach the server. Check your connection.' };
  }
};

const IC: Record<string, string> = {
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3 1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8 1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M7 4l13 8-13 8z', pause: 'M8 4v16M16 4v16', up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5', upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z', vol: 'M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 010 6', mute: 'M11 5L6 9H3v6h3l5 4zM17 9l5 6M22 9l-5 6', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', doc: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  audio: 'M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v3',
  article: 'M4 4h16v16H4zM4 9h16M9 4v16',
  check: 'M20 6L9 17l-5-5',
  alert: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
};
const Ic = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={n in IC ? IC[n] : n} />
  </svg>
);

const V: Record<string, { label: string; c: string }> = {
  Supported: { label: 'Verified', c: '#1a7f37' },
  Contradicted: { label: 'Contradicted', c: '#d1242f' },
  Misleading: { label: 'Potentially misleading', c: '#c2570c' },
  Mixed: { label: 'Mixed evidence', c: '#9a6700' },
  'Insufficient Evidence': { label: 'Inconclusive', c: '#6e6e73' }
};
const Badge = ({ v }: { v?: string }) => {
  const x = V[v || ''] || { label: v || '—', c: '#6e6e73' };
  return <span className="badge" style={{ color: x.c, background: x.c + '14', borderColor: x.c + '40' }}>{x.label}</span>;
};

const RISK_THEME: Record<string, { label: string; c: string }> = {
  low: { label: 'Synthetic Risk: Low', c: '#1a7f37' },
  moderate: { label: 'Synthetic Risk: Moderate', c: '#c2570c' },
  high: { label: 'Synthetic Risk: High', c: '#d1242f' },
  critical: { label: 'Synthetic Risk: Critical', c: '#82071e' }
};
const RiskBadge = ({ risk }: { risk?: string }) => {
  const t = RISK_THEME[risk || 'low'] || RISK_THEME.low;
  return <span className="badge" style={{ color: t.c, background: t.c + '14', borderColor: t.c + '40' }}>{t.label}</span>;
};

const MediaBadge = ({ type }: { type?: MediaType }) => {
  const t = type || 'video';
  const label = t === 'video' ? 'Video' : t === 'audio' ? 'Audio' : 'Article';
  const icon = t === 'video' ? 'play' : t === 'audio' ? 'audio' : 'doc';
  return (
    <span className={`media-badge ${t}`}>
      <Ic n={icon} s={12} /> {label}
    </span>
  );
};

const ytThumb = (u?: string) => {
  const m = u?.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : '';
};
const ytOk = (u: string) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)[\w-]{11}|youtu\.be\/[\w-]{11})/.test(u.trim());
const when = (t?: number) => (t ? new Date(t).toLocaleString() : '');

type KeyFrame = { timestamp: number; dataUrl: string };
const formatMediaTime = (time: number) => {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

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
    const onError = () => finish(new Error('Decode error.'));
    const timer = window.setTimeout(() => finish(new Error('Timeout.')), timeoutMs);
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
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
        frames.push({ timestamp, dataUrl: canvas.toDataURL('image/jpeg', 0.72) });
      } catch { }
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/* ---------- unified report modal (video / audio / article) ---------- */
function ReportModal({
  id,
  onClose,
  onRerun,
  rerunBusy
}: {
  id: string;
  onClose: () => void;
  onRerun: (report: Report, options: { forceRescan?: boolean; refreshFactCheckOnly?: boolean }) => void;
  rerunBusy?: boolean;
}) {
  const [r, setR] = useState<Report>();
  const [sec, setSec] = useState(0);
  const [frames, setFrames] = useState<KeyFrame[]>([]);
  const [framesLoading, setFramesLoading] = useState(false);

  useEffect(() => {
    let t: number, dead = false;
    const tick = async () => {
      const d: Report = await api('/reports/' + id);
      if (dead) return;
      setR(d);
      if (d.status === 'processing') t = window.setTimeout(tick, 3000);
    };
    tick();
    const c = window.setInterval(() => setSec(s => s + 1), 1000);
    return () => { dead = true; clearTimeout(t); clearInterval(c); };
  }, [id]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const reportId = r?.id;
  const reportStatus = r?.status;
  const reportPostId = r?.postId;

  useEffect(() => {
    let cancelled = false;
    setFrames([]);
    if (!reportId || reportStatus !== 'done' || !reportPostId) {
      setFramesLoading(false);
      return () => { cancelled = true; };
    }
    setFramesLoading(true);
    extractKeyFrames(`/api/video/${encodeURIComponent(reportPostId)}`)
      .then(items => { if (!cancelled) setFrames(items); })
      .catch(() => { })
      .finally(() => { if (!cancelled) setFramesLoading(false); });
    return () => { cancelled = true; };
  }, [reportId, reportStatus, reportPostId]);

  const busy = !r || r.status === 'processing' || rerunBusy;
  const mediaType = r?.mediaType || 'video';

  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label="Investigation Report">
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MediaBadge type={mediaType} />
            <span className="mu small">Investigation Report</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
        </div>

        {busy ? (
          <div style={{ padding: '30px 0' }}>
            <h2 className="sec" style={{ fontSize: 26 }}>Analyzing Evidence…</h2>
            <p className="mu">Evaluating forensic integrity, detecting synthetic media, and checking authoritative sources with Google Search grounding.</p>
            <div className="bar"><i /></div>
            <span className="mu small">Elapsed {sec}s</span>
          </div>
        ) : r.status === 'error' ? (
          <div style={{ padding: '20px 0' }}>
            <h2 className="sec" style={{ fontSize: 26 }}>Investigation Incomplete</h2>
            <p className="mu">{r.error}</p>
            <button className="btn primary sm" style={{ marginTop: 14 }} onClick={() => r && onRerun(r, { forceRescan: true })}>
              Retry Analysis
            </button>
          </div>
        ) : (
          <>
            {/* Action Bar for Re-analysis */}
            <div className="report-actions">
              <div>
                <span className="small mu">Model: <b>{r.model || 'Gemini'}</b> · {when(r.updatedAt)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => onRerun(r, { refreshFactCheckOnly: true })}
                  title="Re-check claims against current live search without re-analyzing media"
                >
                  <Ic n="search" s={14} /> Refresh Fact-Check
                </button>
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Run full re-scan? This re-extracts media, OCR/audio, and claims from scratch.')) {
                      onRerun(r, { forceRescan: true });
                    }
                  }}
                  title="Re-run entire multimodal analysis"
                >
                  <Ic n="spark" s={14} /> Full Re-Scan
                </button>
              </div>
            </div>

            <h2 className="sec" style={{ fontSize: 26, marginTop: 4 }}>{r.title || 'Untitled Case'}</h2>
            <p className="mu small" style={{ margin: 0 }}>
              {r.creator ? `Attributed to ${r.creator} · ` : ''}Analysed {when(r.updatedAt)}
            </p>

            <div style={{ display: 'flex', gap: 8, margin: '14px 0 6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge v={r.verdict} />
              {r.syntheticMedia && <RiskBadge risk={r.syntheticMedia.risk} />}
            </div>

            <p className="mu small" style={{ margin: '0 0 14px' }}>
              Confidence: <b>{r.confidence ?? '—'}%</b> — strength of available verifiable evidence.
            </p>

            <p style={{ marginTop: 10 }}>{r.explanation}</p>

            {/* Media Player Embed (if Audio) */}
            {r.audioId && (
              <div className="audio-player-box">
                <audio controls src={`/api/audio/${r.audioId}`} style={{ width: '100%' }} />
              </div>
            )}

            {/* Synthetic Media & Forensics Box */}
            {r.syntheticMedia && (
              <div className="risk-card">
                <div className="row" style={{ marginBottom: 4 }}>
                  <b>
                    {mediaType === 'audio' ? 'Voice Synthesis & Acoustic Forensics'
                      : mediaType === 'article' ? 'AI Text Authorship & Stylometry'
                        : 'Synthetic Media & Deepfake Forensics'}
                  </b>
                  <RiskBadge risk={r.syntheticMedia.risk} />
                </div>

                {mediaType === 'audio' && r.syntheticMedia.cadenceScore !== undefined && (
                  <div className="meter-row">
                    <div className="row small">
                      <span>Speech Cadence Naturalness:</span>
                      <b>{r.syntheticMedia.cadenceScore}%</b>
                    </div>
                    <div className="meter-track">
                      <div className="meter-fill" style={{ width: `${r.syntheticMedia.cadenceScore}%`, background: r.syntheticMedia.cadenceScore < 50 ? '#d1242f' : '#1a7f37' }} />
                    </div>
                  </div>
                )}

                {mediaType === 'article' && (
                  <>
                    <div className="meter-row">
                      <div className="row small">
                        <span>AI Authorship Likelihood:</span>
                        <b style={{ color: (r.syntheticMedia.aiProbability || 0) > 60 ? '#d1242f' : '#1a7f37' }}>{r.syntheticMedia.aiProbability || 0}%</b>
                      </div>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${r.syntheticMedia.aiProbability || 0}%`, background: (r.syntheticMedia.aiProbability || 0) > 60 ? '#d1242f' : '#1a7f37' }} />
                      </div>
                    </div>
                    <div className="meter-row">
                      <div className="row small">
                        <span>Sensationalism & Clickbait Index:</span>
                        <b>{r.syntheticMedia.sensationalismScore || 0}%</b>
                      </div>
                      <div className="meter-track">
                        <div className="meter-fill" style={{ width: `${r.syntheticMedia.sensationalismScore || 0}%`, background: '#c2570c' }} />
                      </div>
                    </div>
                  </>
                )}

                <p className="small" style={{ margin: '6px 0 4px' }}>{r.syntheticMedia.reasoning}</p>

                {!!r.syntheticMedia.anomalies?.length && (
                  <ul style={{ fontSize: 13, margin: '6px 0 0', paddingLeft: 18 }}>
                    {r.syntheticMedia.anomalies.map((a, i) => <li key={i} className="mu">{a}</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* Quotes Analyzed (Articles) */}
            {!!r.quotes?.length && (
              <>
                <h3>Extracted On-Record Quotes</h3>
                {r.quotes.map((q, i) => (
                  <div className="quote-box" key={i}>
                    <p style={{ margin: '0 0 4px' }}>“{q.quote}”</p>
                    <span className="small mu">— {q.speaker || 'Speaker'}</span>
                  </div>
                ))}
              </>
            )}

            {/* On-Screen Text & Headlines (OCR) */}
            {!!r.ocrText?.length && (
              <>
                <h3>On-Screen Text &amp; Chyrons (OCR)</h3>
                <div className="ocr-grid">
                  {r.ocrText.map((o, i) => (
                    <div className="ocr-item" key={i}>
                      {o.timestamp && <span className="small mu" style={{ display: 'block', marginBottom: 2 }}>@{o.timestamp}</span>}
                      <span>{o.text}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Key Claims */}
            {!!r.claims?.length && (
              <>
                <h3>Key Claims Verified</h3>
                <ul>
                  {r.claims.map((c, i) => (
                    <li key={i}>
                      <div style={{ marginBottom: 4 }}>
                        <Badge v={c.verdict} />
                        <span className="tag" style={{ background: c.origin === 'on_screen_text' ? '#e8f1fd' : c.origin === 'article_text' ? '#f0e6ff' : '#f2f2f7', color: c.origin === 'on_screen_text' ? '#0071e3' : c.origin === 'article_text' ? '#6b21a8' : '#6e6e73' }}>
                          {c.origin === 'on_screen_text' ? 'On-Screen' : c.origin === 'article_text' ? 'Text' : 'Spoken'}
                        </span>
                        {c.timestamp && <span className="small mu">@{c.timestamp} </span>}
                        <b>{c.text}</b>
                      </div>
                      <div className="mu small">{c.explanation}</div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {!!r.misleading?.length && (
              <>
                <h3>Potentially Misleading Elements</h3>
                <ul>{r.misleading.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </>
            )}

            <h3>Sources Consulted</h3>
            {r.sources?.length ? (
              <ul>
                {r.sources.map(s => (
                  <li key={s.uri}><a href={s.uri} target="_blank" rel="noreferrer noopener">{s.title}</a></li>
                ))}
              </ul>
            ) : (
              <p className="mu small">No external web sources retrieved. Treat assessment with caution.</p>
            )}

            {/* Transcript & Key Frames (Video/Audio) */}
            {(r.transcript || r.postId) && (
              <section aria-label="Evidence review" style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid #e5e5e7' }}>
                <h3 style={{ marginTop: 0 }}>Transcript &amp; Media Evidence</h3>
                {r.transcript?.trim() && (
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto', margin: '8px 0', padding: 14, borderRadius: 12, border: '1px solid #e5e5e7', background: '#f7f7f8', color: '#242428', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6 }}>
                    {r.transcript}
                  </pre>
                )}
                {r.postId && (
                  <>
                    <h4 style={{ margin: '14px 0 8px' }}>Key-Frame Captures</h4>
                    {framesLoading ? (
                      <p className="mu small">Extracting representative frames…</p>
                    ) : frames.length ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
                        {frames.map((frame, i) => (
                          <figure key={i} style={{ margin: 0 }}>
                            <img src={frame.dataUrl} alt={`Frame at ${formatMediaTime(frame.timestamp)}`} loading="lazy" style={{ display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'contain', background: '#111', borderRadius: 8 }} />
                            <figcaption className="mu small" style={{ marginTop: 4 }}>At {formatMediaTime(frame.timestamp)}</figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- overview command hub ---------- */
function Overview({
  stats,
  onOpenReport,
  onSwitchTab
}: {
  stats: DashboardStats | null;
  onOpenReport: (id: string) => void;
  onSwitchTab: (tab: 'video' | 'audio' | 'article') => void;
}) {
  return (
    <div>
      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Total Cases Processed</span>
          <div className="kpi-num">{stats?.total ?? '—'}</div>
          <span className="kpi-sub">Cross-modal investigations</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Synthetic Threat Rate</span>
          <div className="kpi-num threat-rate">{stats ? `${stats.threatRate}%` : '—'}</div>
          <span className="kpi-sub">High/Critical deepfake risk</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Verified Claims</span>
          <div className="kpi-num" style={{ color: '#1a7f37' }}>{stats?.byVerdict?.Supported ?? 0}</div>
          <span className="kpi-sub">Corroborated by primary sources</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Contradicted / Debunked</span>
          <div className="kpi-num" style={{ color: '#d1242f' }}>{stats?.byVerdict?.Contradicted ?? 0}</div>
          <span className="kpi-sub">Disproven or false assertions</span>
        </div>
      </div>

      {/* Priority Threat Stream */}
      {stats && stats.recent.filter(r => r.syntheticMedia?.risk === 'high' || r.syntheticMedia?.risk === 'critical').length > 0 && (
        <div className="alert-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#d1242f' }}><Ic n="alert" s={22} /></span>
            <div>
              <b>Critical Synthetic Media Detected</b>
              <div className="mu small">Recent cases flagged with high deepfake or voice cloning probability</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {stats.recent.filter(r => r.syntheticMedia?.risk === 'high' || r.syntheticMedia?.risk === 'critical').slice(0, 3).map(r => (
              <button key={r.id} className="btn sm" onClick={() => onOpenReport(r.id)}>
                <MediaBadge type={r.mediaType} /> {r.title?.slice(0, 24)}…
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick Launch Studios */}
      <h3 style={{ fontSize: 16, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--mu)', margin: '24px 0 12px' }}>
        Forensic Investigation Studios
      </h3>
      <div className="action-grid">
        <div className="action-card" onClick={() => onSwitchTab('video')}>
          <b><Ic n="play" s={20} /> Video Forensic Lab</b>
          <p>Analyze viral clips, YouTube links, face-swaps, on-screen chyrons, and spoken claims.</p>
          <span className="small" style={{ color: 'var(--blue)', fontWeight: 600 }}>Launch Video Studio →</span>
        </div>
        <div className="action-card" onClick={() => onSwitchTab('audio')}>
          <b><Ic n="audio" s={20} /> Audio &amp; Voice Clone Lab</b>
          <p>Scan voice notes, podcasts, and recordings for synthetic voice cloning, cadence, and prosody.</p>
          <span className="small" style={{ color: 'var(--blue)', fontWeight: 600 }}>Launch Audio Studio →</span>
        </div>
        <div className="action-card" onClick={() => onSwitchTab('article')}>
          <b><Ic n="article" s={20} /> Article &amp; AI Text Lab</b>
          <p>Inspect articles for generative AI authorship, clickbait sensationalism, and quote integrity.</p>
          <span className="small" style={{ color: 'var(--blue)', fontWeight: 600 }}>Launch Article Studio →</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- audio forensic lab component ---------- */
function AudioLab({
  onAnalyseAudio,
  busy,
  toast
}: {
  onAnalyseAudio: (body: object) => void;
  busy: boolean;
  toast: ToastFn;
}) {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [creator, setCreator] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const inp = useRef<HTMLInputElement>(null);

  const pick = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name)) {
      return toast('Please choose an audio file (MP3, WAV, M4A).', 'err');
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.\w+$/, ''));
  };

  const uploadAndAnalyse = () => {
    if (!file) return;
    const q = new URLSearchParams({
      title: title.trim() || file.name,
      creator: creator.trim() || 'Audio Source'
    });
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload/audio?' + q);
    x.setRequestHeader('Content-Type', file.type || 'audio/mp3');
    x.upload.onprogress = e => e.lengthComputable && setPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => {
      setPct(null);
      let d: any = {};
      try { d = JSON.parse(x.responseText); } catch { }
      if (x.status < 300 && d.id) {
        toast('Audio ingested. Running acoustic forensics…');
        onAnalyseAudio({ audioId: d.id });
        setFile(null);
        setTitle('');
        setCreator('');
      } else {
        toast(d.error || 'Audio upload failed.', 'err');
      }
    };
    x.onerror = () => { setPct(null); toast('Network error uploading audio.', 'err'); };
    setPct(0);
    x.send(file);
  };

  return (
    <div className="grid2">
      <div>
        <h2 className="sec">Audio &amp; Voice Clone Forensics</h2>
        <p className="mu">Scan audio recordings and podcasts for synthetic voice cloning, neural TTS cadence, and checkable claims.</p>
        <p className="mu small">Detects robotic pitch cadence, unnatural breathing absence, and emotional flatlining characteristic of generated voices.</p>
      </div>

      <div className="card">
        <h3>Analyze Remote Audio URL</h3>
        <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
          <input
            className="field"
            type="url"
            placeholder="https://example.com/recording.mp3"
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !url.trim()} onClick={() => onAnalyseAudio({ url: url.trim() })}>
            Analyze
          </button>
        </div>

        <div style={{ margin: '20px 0', borderTop: '1px solid var(--line)', paddingTop: 18 }}>
          <h3>Upload Audio File</h3>
          <div className="drop" onClick={() => inp.current?.click()} style={{ cursor: 'pointer' }}>
            <Ic n="audio" s={28} />
            <p style={{ margin: '8px 0' }}>Click or drag MP3, WAV, or M4A file here</p>
            <input ref={inp} type="file" accept="audio/*" hidden onChange={e => pick(e.target.files?.[0])} />
            {file && <p className="small">Selected: <b>{file.name}</b></p>}
          </div>

          {file && (
            <div style={{ marginTop: 14 }}>
              <label className="l">Recording Title</label>
              <input className="field" value={title} onChange={e => setTitle(e.target.value)} />
              <label className="l">Speaker / Source</label>
              <input className="field" value={creator} onChange={e => setCreator(e.target.value)} />
              {pct !== null && <div className="prog"><i style={{ width: pct + '%' }} /></div>}
              <button className="btn primary full" style={{ marginTop: 14 }} disabled={busy || pct !== null} onClick={uploadAndAnalyse}>
                {pct !== null ? `Uploading ${pct}%` : 'Ingest & Run Audio Forensics'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- article forensic lab component ---------- */
function ArticleLab({
  onAnalyseArticle,
  busy,
  toast
}: {
  onAnalyseArticle: (body: object) => void;
  busy: boolean;
  toast: ToastFn;
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');

  const submit = () => {
    if (!url.trim() && text.trim().length < 50) {
      return toast('Please enter an article URL or paste at least 50 characters of text.', 'err');
    }
    onAnalyseArticle({
      url: url.trim() || undefined,
      text: text.trim() || undefined,
      title: title.trim() || undefined,
      author: author.trim() || undefined
    });
  };

  return (
    <div className="grid2">
      <div>
        <h2 className="sec">Article &amp; AI Text Forensics</h2>
        <p className="mu">Investigate written articles and claims for synthetic AI authorship, clickbait sensationalism, and quote misattributions.</p>
        <p className="mu small">Cross-references cited facts and named quotes with primary sources and live web documentation.</p>
      </div>

      <div className="card">
        <h3>Inspect Web Article by URL</h3>
        <input
          className="field"
          type="url"
          placeholder="https://news-outlet.com/article..."
          value={url}
          onChange={e => setUrl(e.target.value)}
          style={{ marginBottom: 14 }}
        />

        <div style={{ textAlign: 'center', margin: '8px 0', color: 'var(--mu)', fontSize: 13 }}>— OR PASTE TEXT —</div>

        <label className="l">Article Headline (optional)</label>
        <input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="Article Headline" />

        <label className="l">Bylined Author (optional)</label>
        <input className="field" value={author} onChange={e => setAuthor(e.target.value)} placeholder="Journalist / Author" />

        <label className="l">Article Body</label>
        <textarea
          className="field"
          rows={6}
          placeholder="Paste full article text or paragraphs here to inspect stylometry and factual claims…"
          value={text}
          onChange={e => setText(e.target.value)}
        />

        <button className="btn primary full" style={{ marginTop: 18 }} disabled={busy || (!url.trim() && text.trim().length < 50)} onClick={submit}>
          {busy ? 'Investigating Article…' : 'Run Article Forensic Analysis'}
        </button>
      </div>
    </div>
  );
}

/* ---------- smartphone feed with zero-cost report viewing ---------- */
function Phone({
  posts,
  loading,
  sel,
  setSel,
  repOf,
  busy,
  onAnalyse,
  onOpen,
  goUpload
}: {
  posts: Post[];
  loading: boolean;
  sel: number;
  setSel: (i: number) => void;
  repOf: (id: string) => Report | undefined;
  busy: string;
  onAnalyse: (id: string) => void;
  onOpen: (id: string) => void;
  goUpload: () => void;
}) {
  const sc = useRef<HTMLDivElement>(null);
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [bad, setBad] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const root = sc.current;
    if (!root) return;
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > 0.6) setSel(Number((e.target as HTMLElement).dataset.i));
    }), { root, threshold: [0.6] });
    root.querySelectorAll('.slide').forEach(s => io.observe(s));
    return () => io.disconnect();
  }, [posts.length, setSel]);

  useEffect(() => {
    vids.current.forEach((v, i) => {
      if (!v) return;
      if (i === sel) {
        v.muted = muted;
        v.play().catch(() => setPlaying(false));
      } else {
        v.pause();
      }
    });
  }, [sel, muted, posts.length]);

  const go = (i: number) => i >= 0 && i < posts.length && setSel(i);
  const toggle = () => {
    const v = vids.current[sel];
    if (v) v.paused ? v.play().catch(() => { }) : v.pause();
  };

  return (
    <div className="phone" aria-label="Video feed">
      <div className="island" />
      <div className="screen">
        {loading ? (
          <div className="skel" style={{ height: '100%', borderRadius: 0 }} />
        ) : !posts.length ? (
          <div className="empty-phone">
            <b>No videos yet</b>
            <span style={{ opacity: .7, fontSize: 14 }}>Add a video to start investigating.</span>
            <button className="btn sm" onClick={goUpload}>Add a video</button>
          </div>
        ) : (
          <>
            <div className="scroller" ref={sc} tabIndex={0}>
              {posts.map((p, i) => {
                const r = repOf(p.id);
                return (
                  <div className="slide" key={p.id} data-i={i}>
                    {bad[p.id] ? (
                      <div className="vfail"><span>Video could not be loaded.</span></div>
                    ) : (
                      <video
                        ref={el => { vids.current[i] = el; }}
                        src={p.videoUrl}
                        loop
                        playsInline
                        muted={muted}
                        preload={Math.abs(i - sel) <= 1 ? 'auto' : 'metadata'}
                        onClick={toggle}
                        onError={() => setBad(b => ({ ...b, [p.id]: true }))}
                        onPlay={() => i === sel && setPlaying(true)}
                        onPause={() => i === sel && setPlaying(false)}
                      />
                    )}
                    <div className="shade" />
                    {r && (
                      <span className="chip">
                        {r.status === 'done' ? (
                          <>● {V[r.verdict || '']?.label || 'Analysed'}</>
                        ) : r.status === 'processing' ? 'Analysing…' : 'Analysis failed'}
                      </span>
                    )}
                    <div className="meta">
                      <b>{p.title}</b>
                      <span>@{p.creator}</span>
                      {p.caption && <p>{p.caption}</p>}
                      <button
                        className="btn primary full"
                        disabled={busy === p.id}
                        onClick={() => {
                          if (r?.status === 'done') {
                            onOpen(r.id);
                          } else {
                            onAnalyse(p.id);
                          }
                        }}
                      >
                        <Ic n="spark" s={16} />
                        {busy === p.id ? 'Starting…' : r?.status === 'done' ? 'View Report' : 'Analyse This Video'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="rail">
              <button onClick={() => go(sel - 1)} disabled={sel === 0} aria-label="Previous video"><Ic n="up" /></button>
              <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Ic n={playing ? 'pause' : 'play'} /></button>
              <button onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'}><Ic n={muted ? 'mute' : 'vol'} /></button>
              <button onClick={() => go(sel + 1)} disabled={sel >= posts.length - 1} aria-label="Next video"><Ic n="down" /></button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- upload video ---------- */
function Upload({ onDone, toast }: { onDone: (p: Post) => void; toast: ToastFn }) {
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState('');
  const [title, setTitle] = useState('');
  const [creator, setCreator] = useState('');
  const [caption, setCaption] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const inp = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (prev) URL.revokeObjectURL(prev); }, [prev]);

  const pick = (f?: File) => {
    if (!f) return;
    if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(f.type)) return toast('Choose an MP4, WebM or MOV video.', 'err');
    if (f.size > 25 * 1024 * 1024) return toast('Video exceeds 25 MB.', 'err');
    setFile(f);
    setPrev(URL.createObjectURL(f));
    if (!title) setTitle(f.name.replace(/\.\w+$/, ''));
  };

  const send = () => {
    if (!file) return;
    const q = new URLSearchParams({
      title: title.trim() || file.name,
      creator: creator.trim() || 'Uploader',
      caption: caption.trim()
    });
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload?' + q);
    x.setRequestHeader('Content-Type', file.type);
    x.upload.onprogress = e => e.lengthComputable && setPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => {
      setPct(null);
      let d: any = {};
      try { d = JSON.parse(x.responseText); } catch { }
      if (x.status < 300) {
        toast(d.duplicate ? 'Duplicate video recognized.' : 'Video added to feed.');
        onDone(d);
        setFile(null);
        setPrev('');
        setTitle('');
        setCreator('');
        setCaption('');
      } else {
        toast(d.error || 'Upload failed.', 'err');
      }
    };
    x.onerror = () => { setPct(null); toast('Network error.', 'err'); };
    setPct(0);
    x.send(file);
  };

  return (
    <section id="upload" style={{ marginTop: 70 }}>
      <div className="grid2">
        <div>
          <h2 className="sec">Add Video to Feed</h2>
          <p className="mu">Upload clips to inspect speech transcripts, on-screen chyrons, and synthetic media risks.</p>
        </div>
        <div>
          <div className={'drop' + (over ? ' over' : '')} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
            <Ic n="upload" s={28} />
            <p style={{ margin: '8px 0' }}>Drag video here or</p>
            <button className="btn sm" onClick={() => inp.current?.click()}>Choose file</button>
            <input ref={inp} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={e => pick(e.target.files?.[0])} />
            {prev && <video src={prev} controls muted playsInline style={{ width: '100%', marginTop: 10 }} />}
          </div>
          <label className="l">Title</label><input className="field" value={title} onChange={e => setTitle(e.target.value)} />
          <label className="l">Creator</label><input className="field" value={creator} onChange={e => setCreator(e.target.value)} />
          {pct !== null && <div className="prog"><i style={{ width: pct + '%' }} /></div>}
          <button className="btn primary" style={{ marginTop: 14 }} disabled={!file || pct !== null} onClick={send}>
            {pct !== null ? `Uploading ${pct}%` : 'Upload Video'}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ---------- unified history & case dossier ---------- */
function History({
  reports,
  posts,
  loading,
  onOpen
}: {
  reports: Report[];
  posts: Post[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [f, setF] = useState('all');
  const [mediaFilter, setMediaFilter] = useState<'all' | MediaType>('all');

  const list = reports.filter(r => {
    const matchType = mediaFilter === 'all' || (r.mediaType || 'video') === mediaFilter;
    const matchVerdict = f === 'all' || (f === 'pending' ? r.status !== 'done' : r.verdict === f);
    const matchText = `${r.title || ''} ${r.creator || ''} ${r.url || ''} ${r.explanation || ''}`.toLowerCase().includes(q.toLowerCase());
    return matchType && matchVerdict && matchText;
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <span style={{ position: 'absolute', left: 12, top: 11, color: '#6e6e73' }}><Ic n="search" s={16} /></span>
          <input className="field" style={{ paddingLeft: 36 }} placeholder="Search investigations dossier…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="field" style={{ width: 'auto' }} value={mediaFilter} onChange={e => setMediaFilter(e.target.value as any)}>
          <option value="all">All Formats</option>
          <option value="video">Videos</option>
          <option value="audio">Audios</option>
          <option value="article">Articles</option>
        </select>
        <select className="field" style={{ width: 'auto' }} value={f} onChange={e => setF(e.target.value)}>
          <option value="all">All Verdicts</option>
          {Object.entries(V).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
          <option value="pending">In Progress / Failed</option>
        </select>
      </div>

      {loading ? (
        <div className="hgrid">{[0, 1, 2].map(i => <div key={i} className="skel" style={{ height: 240 }} />)}</div>
      ) : !list.length ? (
        <div className="card" style={{ textAlign: 'center', padding: 50 }}>
          <h2 className="sec" style={{ fontSize: 24 }}>No investigations found</h2>
          <p className="mu">No cases match your filters.</p>
        </div>
      ) : (
        <div className="hgrid">
          {list.map(r => {
            const p = posts.find(x => x.id === (r.postId || r.id));
            const type = r.mediaType || 'video';
            return (
              <div className="card hcard" key={r.id}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <MediaBadge type={type} />
                  <span className="mu small">{when(r.updatedAt)}</span>
                </div>
                {type === 'video' && (
                  <div className="thumb">
                    {p ? <video src={p.videoUrl + '#t=0.5'} preload="metadata" muted playsInline /> : ytThumb(r.url) ? <img src={ytThumb(r.url)} alt="" loading="lazy" /> : null}
                  </div>
                )}
                <b>{r.title || r.url || 'Investigation Case'}</b>
                <div className="row">
                  {r.status === 'done' ? <Badge v={r.verdict} /> : <span className="mu small">In Progress</span>}
                  {r.syntheticMedia && <RiskBadge risk={r.syntheticMedia.risk} />}
                </div>
                {r.explanation && (
                  <p className="mu small" style={{ margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {r.explanation}
                  </p>
                )}
                <button className="btn sm" onClick={() => onOpen(r.id)}>View Dossier</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- settings ---------- */
function Settings({ onClose, toast }: { onClose: () => void; toast: ToastFn }) {
  const [vals, setVals] = useState<Record<Prov, string>>({ gemini: getKey('gemini'), vertex: getKey('vertex') });
  const [rem, setRem] = useState(!!(localStorage.getItem('ai_key_gemini') || localStorage.getItem('ai_key_vertex')));
  const [model, setModel] = useState<ModelId>(getModel);
  const [quotaMode, setQuotaMode] = useState<QuotaMode>(getQuotaMode);
  const [useSearch, setUseSearch] = useState<boolean>(getUseSearch);
  const [, setAct] = useState<Prov>(active());
  const [st, setSt] = useState<Record<string, string>>({});

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = (p: Prov) => {
    const k = vals[p].trim();
    if (k.length < 20) return toast('Key looks too short.', 'err');
    setKey(p, k, rem);
    localStorage.setItem('ai_active', p);
    setAct(p);
    setSt(s => ({ ...s, [p]: 'Saved.' }));
    toast('Key saved in this browser.');
  };
  const remove = (p: Prov) => {
    setKey(p, '', false);
    setVals(v => ({ ...v, [p]: '' }));
    setSt(s => ({ ...s, [p]: '' }));
    toast('Key removed.');
  };
  const test = async (p: Prov) => {
    if (!getKey(p)) return toast('Save the key first.', 'err');
    localStorage.setItem('ai_active', p);
    setAct(p);
    setSt(s => ({ ...s, [p]: 'Checking with server…' }));
    const d = await api('/check-key', {});
    setSt(s => ({ ...s, [p]: d.ok ? `Confirmed ✓ (${d.resolvedModel})` : d.error || 'Key rejected.' }));
  };

  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label="AI Configuration">
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="row">
          <h2 className="sec" style={{ fontSize: 26, margin: 0 }}>AI &amp; Quota Configuration</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
        </div>
        <p className="mu small">Optimize execution for Google AI Studio Free-Tier limits or Vertex AI.</p>

        <label className="l">Analysis Model</label>
        <select
          className="field"
          value={model}
          onChange={e => {
            const next = normalizeModel(e.target.value);
            setModel(next);
            localStorage.setItem('ai_model', next);
          }}
        >
          {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>

        <label className="l" style={{ marginTop: 12 }}>Execution Pipeline Mode</label>
        <select
          className="field"
          value={quotaMode}
          onChange={e => {
            const next = e.target.value === 'two_pass' ? 'two_pass' : 'single_pass';
            setQuotaMode(next);
            localStorage.setItem('ai_quota_mode', next);
          }}
        >
          <option value="single_pass">Single-Pass Quota Saver (1 API Call · Best for AI Studio Free Tier)</option>
          <option value="two_pass">Two-Pass Deep Forensic (2 API Calls · Decoupled Extraction &amp; Search)</option>
        </select>

        <label className="small" style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={useSearch}
            onChange={e => {
              setUseSearch(e.target.checked);
              localStorage.setItem('ai_use_search', String(e.target.checked));
            }}
          />
          <span>Enable Google Search Grounding (auto-falls back to model knowledge if daily search quota is exhausted)</span>
        </label>

        <div className="card" style={{ marginTop: 14 }}>
          <b>Google AI Studio (Gemini API Key)</b>
          <input className="field" type="password" value={vals.gemini} onChange={e => setVals(v => ({ ...v, gemini: e.target.value }))} placeholder="Paste AIza... Gemini key" style={{ margin: '8px 0' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={() => save('gemini')}>Save</button>
            <button className="btn sm" onClick={() => test('gemini')}>Test</button>
            <button className="btn sm" onClick={() => remove('gemini')}>Remove</button>
          </div>
          {st.gemini && <p className="small mu" style={{ margin: '8px 0 0' }}>{st.gemini}</p>}
        </div>

        <label className="small" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <input type="checkbox" checked={rem} onChange={e => setRem(e.target.checked)} />
          <span>Remember keys across browser restarts</span>
        </label>
      </div>
    </div>
  );
}

/* ---------- app main workbench ---------- */
export default function App() {
  const [tab, setTab] = useState<'video' | 'overview' | 'audio' | 'article' | 'history'>('video');
  const [posts, setPosts] = useState<Post[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loadP, setLoadP] = useState(true);
  const [loadR, setLoadR] = useState(true);
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState('');
  const [url, setUrl] = useState('');
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const [, force] = useState(0);

  const toast: ToastFn = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);

  const loadPosts = useCallback(async (): Promise<Post[]> => {
    const d = await api('/posts');
    setLoadP(false);
    if (Array.isArray(d)) { setPosts(d); return d; }
    return [];
  }, []);

  const loadReports = useCallback(async () => {
    const d = await api('/reports');
    if (Array.isArray(d)) setReports(d);
    setLoadR(false);
  }, []);

  const loadStats = useCallback(async () => {
    const s = await api('/dashboard/stats');
    if (s && !s.error) setStats(s);
  }, []);

  useEffect(() => {
    loadPosts();
    loadReports();
    loadStats();
  }, [loadPosts, loadReports, loadStats]);

  const repOf = (id: string) => reports.find(r => r.sourceId === id || r.postId === id || r.id === id);

  const startAnalysis = async (endpoint: string, body: object, pid = '') => {
    setBusy(pid || 'busy');
    const d = await api(endpoint, body);
    setBusy('');
    if (d.needKey) {
      toast(d.error, 'err');
      setSettings(true);
    } else if (d.id) {
      setOpen(d.id);
      loadReports();
      loadStats();
    } else {
      toast(d.error || 'Investigation failed to initialize.', 'err');
    }
  };

  const handleRerun = async (report: Report, options: { forceRescan?: boolean; refreshFactCheckOnly?: boolean }) => {
    const type = report.mediaType || 'video';
    const endpoint = type === 'audio' ? '/analyse/audio' : type === 'article' ? '/analyse/article' : '/analyse/video';
    const body = {
      ...(report.postId ? { postId: report.postId } : {}),
      ...(report.audioId ? { audioId: report.audioId } : {}),
      ...(report.url ? { url: report.url } : {}),
      ...options
    };
    setBusy(report.id);
    const d = await api(endpoint, body);
    setBusy('');
    if (d.needKey) {
      toast(d.error, 'err');
      setSettings(true);
    } else if (d.id) {
      toast(options.forceRescan ? 'Full re-scan dispatched.' : 'Fact-check refreshed against live sources.');
      loadReports();
      loadStats();
    } else {
      toast(d.error || 'Re-run failed.', 'err');
    }
  };

  const toDemo = (tabName: 'video' | 'overview' | 'audio' | 'article' | 'history', focusUrl = false) => {
    setTab(tabName);
    setTimeout(() => {
      document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' });
      if (focusUrl) {
        document.getElementById('url-input')?.focus();
      }
    }, 60);
  };

  const cur = posts[sel], curRep = cur && repOf(cur.id), hasKey = PROV.some(getKey);

  return (
    <>
      <header className="hdr">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => toDemo('video')}>
          <Ic n="M12 4a8 8 0 100 16 8 8 0 000-16zM21 21l-4.3-4.3" /> TruthLens
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings" title={hasKey ? 'AI key set' : 'Add AI key'}>
          <Ic n="gear" />{hasKey && <span className="keydot" />}
        </button>
      </header>

      <div className="wrap">
        <section className="hero">
          <h1 className="hero-title rise">TruthLens — Multimodal Verification</h1>
          <p className="sub rise" style={{ animationDelay: '.12s' }}>See beyond the scroll. Discover what’s real.</p>
          <p className="desc rise" style={{ animationDelay: '.24s' }}>
            An AI intelligence engine engineered for newsrooms and publishers to detect synthetic media, evaluate on-screen text, verify claims, and combat misinformation in real time.
          </p>
          <div className="cta rise" style={{ animationDelay: '.36s' }}>
            <button className="btn primary" onClick={() => toDemo('video')}>Explore Videos</button>
            <button className="btn" onClick={() => toDemo('video', true)}>Analyse a Video</button>
            <button className="btn" onClick={() => toDemo('overview')}>Command Hub</button>
          </div>
          <div className="feats">
            {[
              ['spark', 'Multimodal Intelligence', 'Analyzes audio transcripts, on-screen chyrons (OCR), and visual scene cues.'],
              ['shield', 'Deepfake & Forensic Checks', 'Detects lip-sync lag, facial warping, synthetic voice markers, and visual anomalies.'],
              ['doc', 'Live Grounded Verification', 'Verifies extracted claims against primary sources via Google Search Grounding.']
            ].map(([i, t, d], k) => (
              <div className="feat rise" key={t} style={{ animationDelay: .45 + k * .1 + 's' }}>
                <Ic n={i} s={22} /><b>{t}</b><span>{d}</span>
              </div>
            ))}
          </div>
        </section>

        <div id="demo" style={{ scrollMarginTop: 70 }}>
          {/* Navigation Tabs */}
          <div className="tabs" role="tablist" style={{ maxWidth: 720 }}>
            {([
              ['video', 'Explore Videos'],
              ['overview', 'Command Hub'],
              ['audio', 'Audio Lab'],
              ['article', 'Article Lab'],
              ['history', 'Dossier Log']
            ] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>

        {/* Tab Panels */}
        <div className="panel" key={tab}>
          {tab === 'overview' && (
            <Overview
              stats={stats}
              onOpenReport={setOpen}
              onSwitchTab={setTab}
            />
          )}

          {tab === 'video' && (
            <>
              <div className="layout">
                <aside>
                  <h2 className="sec">Video Forensic Studio</h2>
                  <p className="mu">Examine spoken claims, on-screen news tickers, and synthetic visual anomalies.</p>
                  <ol className="steps">
                    <li><i>1</i>Select or upload video.</li>
                    <li><i>2</i>Inspect speech transcripts &amp; OCR text.</li>
                    <li><i>3</i>Verify claims against primary ground truth.</li>
                  </ol>
                  <button className="btn" onClick={() => document.getElementById('upload')?.scrollIntoView({ behavior: 'smooth' })}>
                    <Ic n="upload" s={16} />Upload video clip
                  </button>
                </aside>

                <Phone
                  posts={posts}
                  loading={loadP}
                  sel={sel}
                  setSel={setSel}
                  repOf={repOf}
                  busy={busy}
                  onAnalyse={id => startAnalysis('/analyse/video', { postId: id }, id)}
                  onOpen={setOpen}
                  goUpload={() => document.getElementById('upload')?.scrollIntoView({ behavior: 'smooth' })}
                />

                <aside>
                  <div className="card insight">
                    <span className="mu small">Selected Video</span>
                    <h3 style={{ margin: '4px 0 8px', fontSize: 20 }}>{cur?.title || '—'}</h3>
                    {!cur ? (
                      <p className="mu small">No video selected.</p>
                    ) : !curRep ? (
                      <p className="mu small">Not analyzed yet. Press <b>Analyse This Video</b> to start.</p>
                    ) : curRep.status === 'processing' ? (
                      <>
                        <p className="mu small">Analysis in progress…</p>
                        <div className="bar"><i /></div>
                        <button className="btn sm" onClick={() => setOpen(curRep.id)}>Watch progress</button>
                      </>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Badge v={curRep.verdict} />
                          {curRep.syntheticMedia && <RiskBadge risk={curRep.syntheticMedia.risk} />}
                        </div>
                        <p className="mu small" style={{ margin: '6px 0' }}>Confidence {curRep.confidence}%</p>
                        <p className="small" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: '0 0 12px' }}>
                          {curRep.explanation}
                        </p>
                        <button className="btn sm" onClick={() => setOpen(curRep.id)}>Open Full Dossier</button>
                      </>
                    )}
                  </div>

                  <div className="card" style={{ marginTop: 18 }}>
                    <b>Analyze YouTube URL</b>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <input id="url-input" className="field" placeholder="https://youtube.com/watch?v=…" value={url} onChange={e => setUrl(e.target.value)} />
                      <button className="btn primary sm" disabled={busy === 'url' || !url.trim()} onClick={() => { if (ytOk(url)) startAnalysis('/analyse/video', { url: url.trim() }, 'url'); else toast('Please enter a valid YouTube link.', 'err'); }}>
                        Analyze
                      </button>
                    </div>
                  </div>
                </aside>
              </div>

              <Upload
                toast={toast}
                onDone={async p => {
                  const l = await loadPosts();
                  const i = l.findIndex(x => x.id === p.id);
                  if (i >= 0) setSel(i);
                }}
              />
            </>
          )}

          {tab === 'audio' && (
            <AudioLab
              busy={busy === 'audio'}
              toast={toast}
              onAnalyseAudio={body => startAnalysis('/analyse/audio', body, 'audio')}
            />
          )}

          {tab === 'article' && (
            <ArticleLab
              busy={busy === 'article'}
              toast={toast}
              onAnalyseArticle={body => startAnalysis('/analyse/article', body, 'article')}
            />
          )}

          {tab === 'history' && (
            <History
              reports={reports}
              posts={posts}
              loading={loadR}
              onOpen={setOpen}
            />
          )}
        </div>
        </div>
      </div>

      <footer className="footer">
        <q>Empowering newsrooms and readers with transparent media verification.</q>
        <span className="mu small">Built with Gemini &amp; Vertex AI on Google Cloud</span>
      </footer>

      {open && (
        <ReportModal
          id={open}
          onClose={() => { setOpen(undefined); loadReports(); loadStats(); }}
          onRerun={handleRerun}
          rerunBusy={busy === open}
        />
      )}

      {settings && <Settings toast={toast} onClose={() => { setSettings(false); force(n => n + 1); }} />}

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </>
  );
}
