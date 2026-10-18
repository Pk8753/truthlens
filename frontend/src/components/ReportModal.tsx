import { useState, useEffect } from 'react';
import type { Report, MediaType, KeyFrame } from '../types';
import { Ic, Badge, RiskBadge, MediaBadge, V, when, formatMediaTime } from '../ui';
import { api } from '../api';
import { extractKeyFrames } from '../keyframes';

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
  const [copied, setCopied] = useState(false);

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
        ) : r!.status === 'error' ? (
          <div style={{ padding: '20px 0' }}>
            <h2 className="sec" style={{ fontSize: 26 }}>Investigation Incomplete</h2>
            <p className="mu">{r!.error}</p>
            <button className="btn primary sm" style={{ marginTop: 14 }} onClick={() => r && onRerun(r, { forceRescan: true })}>
              Retry Analysis
            </button>
          </div>
        ) : (
          <>
            <div className="report-actions">
              <div>
                <span className="small mu">Model: <b>{r!.model || 'Gemini'}</b> · {when(r!.updatedAt)}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={busy} onClick={() => onRerun(r!, { refreshFactCheckOnly: true })} title="Re-check claims without re-analyzing media">
                  <Ic n="search" s={14} /> Refresh Fact-Check
                </button>
                <button className="btn sm" disabled={busy} onClick={() => { if (window.confirm('Run full re-scan? This re-extracts media, OCR/audio, and claims from scratch.')) { onRerun(r!, { forceRescan: true }); } }} title="Re-run entire multimodal analysis">
                  <Ic n="spark" s={14} /> Full Re-Scan
                </button>
              </div>
            </div>

            <h2 className="sec" style={{ fontSize: 26, marginTop: 4 }}>{r!.title || 'Untitled Case'}</h2>
            <p className="mu small" style={{ margin: 0 }}>
              {r!.creator ? `Attributed to ${r!.creator} · ` : ''}Analysed {when(r!.updatedAt)}
            </p>
            {r!.url && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span className="small mu">Source:</span>
                <a
                  href={r!.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="small"
                  style={{ color: 'var(--blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, wordBreak: 'break-all' }}
                >
                  <span>{r!.url}</span>
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                </a>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, margin: '14px 0 6px', flexWrap: 'wrap', alignItems: 'center' }}>
              <Badge v={r!.verdict} />
              {r!.syntheticMedia && <RiskBadge risk={r!.syntheticMedia.risk} />}
            </div>

            <p className="mu small" style={{ margin: '0 0 14px' }}>
              Confidence: <b>{r!.confidence ?? '—'}%</b> — strength of available verifiable evidence.
            </p>
            <p style={{ marginTop: 10 }}>{r!.explanation}</p>

            {r!.audioId && (
              <div className="audio-player-box">
                <audio controls src={`/api/audio/${r!.audioId}`} style={{ width: '100%' }} />
              </div>
            )}

            {r!.syntheticMedia && (
              <div className="risk-card">
                <div className="row" style={{ marginBottom: 4 }}>
                  <b>
                    {mediaType === 'audio' ? 'Voice Synthesis & Acoustic Forensics'
                      : mediaType === 'article' ? 'AI Text Authorship & Stylometry'
                        : 'Synthetic Media & Deepfake Forensics'}
                  </b>
                  <RiskBadge risk={r!.syntheticMedia.risk} />
                </div>
                {mediaType === 'audio' && r!.syntheticMedia.cadenceScore !== undefined && (
                  <div className="meter-row">
                    <div className="row small"><span>Speech Cadence Naturalness:</span><b>{r!.syntheticMedia.cadenceScore}%</b></div>
                    <div className="meter-track"><div className="meter-fill" style={{ width: `${r!.syntheticMedia.cadenceScore}%`, background: r!.syntheticMedia.cadenceScore < 50 ? '#d1242f' : '#1a7f37' }} /></div>
                  </div>
                )}
                {mediaType === 'article' && (
                  <>
                    <div className="meter-row">
                      <div className="row small"><span>AI Authorship Likelihood:</span><b style={{ color: (r!.syntheticMedia.aiProbability || 0) > 60 ? '#d1242f' : '#1a7f37' }}>{r!.syntheticMedia.aiProbability || 0}%</b></div>
                      <div className="meter-track"><div className="meter-fill" style={{ width: `${r!.syntheticMedia.aiProbability || 0}%`, background: (r!.syntheticMedia.aiProbability || 0) > 60 ? '#d1242f' : '#1a7f37' }} /></div>
                    </div>
                    <div className="meter-row">
                      <div className="row small"><span>Sensationalism & Clickbait Index:</span><b>{r!.syntheticMedia.sensationalismScore || 0}%</b></div>
                      <div className="meter-track"><div className="meter-fill" style={{ width: `${r!.syntheticMedia.sensationalismScore || 0}%`, background: '#c2570c' }} /></div>
                    </div>
                  </>
                )}
                <p className="small" style={{ margin: '6px 0 4px' }}>{r!.syntheticMedia.reasoning}</p>
                {!!r!.syntheticMedia.anomalies?.length && (
                  <ul style={{ fontSize: 13, margin: '6px 0 0', paddingLeft: 18 }}>
                    {r!.syntheticMedia.anomalies.map((a, i) => <li key={i} className="mu">{a}</li>)}
                  </ul>
                )}
              </div>
            )}

            {!!r!.quotes?.length && (
              <>
                <h3>Extracted On-Record Quotes</h3>
                {r!.quotes.map((q, i) => (
                  <div className="quote-box" key={i}>
                    <p style={{ margin: '0 0 4px' }}>"{q.quote}"</p>
                    <span className="small mu">— {q.speaker || 'Speaker'}</span>
                  </div>
                ))}
              </>
            )}

            {!!r!.ocrText?.length && (
              <>
                <h3>On-Screen Text &amp; Chyrons (OCR)</h3>
                <div className="ocr-grid">
                  {r!.ocrText.map((o, i) => (
                    <div className="ocr-item" key={i}>
                      {o.timestamp && <span className="small mu" style={{ display: 'block', marginBottom: 2 }}>@{o.timestamp}</span>}
                      <span>{o.text}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!!r!.claims?.length && (
              <>
                <h3>Key Claims Verified</h3>
                <ul>
                  {r!.claims.map((c, i) => (
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

            {!!r!.misleading?.length && (
              <>
                <h3>Potentially Misleading Elements</h3>
                <ul>{r!.misleading.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </>
            )}

            <h3>Sources Consulted</h3>
            {r!.sources?.length ? (
              <ul>
                {r!.sources.map(s => (
                  <li key={s.uri}><a href={s.uri} target="_blank" rel="noreferrer noopener">{s.title}</a></li>
                ))}
              </ul>
            ) : (
              <p className="mu small">No external web sources retrieved. Treat assessment with caution.</p>
            )}

            {(r!.transcript || r!.postId) && (
              <section aria-label="Evidence review" style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid #e5e5e7' }}>
                <h3 style={{ marginTop: 0 }}>Transcript &amp; Media Evidence</h3>
                {r!.transcript?.trim() && (
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto', margin: '8px 0', padding: 14, borderRadius: 12, border: '1px solid #e5e5e7', background: '#f7f7f8', color: '#242428', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6 }}>
                    {r!.transcript}
                  </pre>
                )}
                {r!.postId && (
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

            {r!.url && (
              <section aria-label="Original source link" style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid #e5e5e7' }}>
                <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {r!.url.includes('youtube.com') || r!.url.includes('youtu.be') ? (
                    <>
                      <svg width={22} height={22} viewBox="0 0 24 24" fill="#ff0000" aria-hidden="true"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" /></svg>
                      Original YouTube Video Link
                    </>
                  ) : mediaType === 'article' ? (
                    <>
                      <span style={{ color: 'var(--blue)', display: 'inline-flex' }}><Ic n="article" s={20} /></span>
                      Original Article Link
                    </>
                  ) : (
                    <>
                      <span style={{ color: 'var(--blue)', display: 'inline-flex' }}><Ic n="link" s={20} /></span>
                      Original Source Reference Link
                    </>
                  )}
                </h3>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '14px 18px',
                  background: '#f7f7f8',
                  borderRadius: 12,
                  border: '1px solid #e5e5e7',
                  flexWrap: 'wrap'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 260px' }}>
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: (r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? '#fee2e2' : '#e8f1fd',
                      color: (r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? '#dc2626' : 'var(--blue)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      {(r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? (
                        <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" /></svg>
                      ) : (
                        <Ic n={mediaType === 'article' ? 'article' : 'link'} s={18} />
                      )}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="small mu" style={{ textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11, fontWeight: 600 }}>
                        {(r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? 'YouTube Source URL' : mediaType === 'article' ? 'Original Web Publication' : 'Source URL'}
                      </div>
                      <a
                        href={r!.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                          wordBreak: 'break-all',
                          fontSize: 14,
                          fontWeight: 500,
                          color: 'var(--blue)',
                          textDecoration: 'none'
                        }}
                      >
                        {r!.url}
                      </a>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn sm"
                      onClick={() => {
                        if (r!.url) {
                          navigator.clipboard.writeText(r!.url);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }
                      }}
                      title="Copy link to clipboard"
                    >
                      {copied ? '✓ Copied' : 'Copy Link'}
                    </button>
                    <a
                      href={r!.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="btn sm"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        background: (r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? '#cc0000' : 'var(--blue)',
                        color: '#fff',
                        border: 'none',
                        textDecoration: 'none',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <span>{(r!.url.includes('youtube.com') || r!.url.includes('youtu.be')) ? 'Watch on YouTube' : 'Open Original Article'}</span>
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                    </a>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default ReportModal;
