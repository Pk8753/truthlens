import { useState } from 'react';
import type { Report, Post, ToastFn } from '../types';
import { Badge, RiskBadge, MediaBadge, Ic, V, ytThumb, when } from '../ui';

function History({
  reports, posts, loading, onOpen, onRerun
}: {
  reports: Report[];
  posts: Post[];
  loading: boolean;
  onOpen: (id: string) => void;
  onRerun?: (report: Report, options: { forceRescan?: boolean }) => void;
}) {
  const [q, setQ] = useState('');
  const [f, setF] = useState('all');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'video' | 'audio' | 'article'>('all');

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
                {r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="small"
                    style={{ color: 'var(--blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, margin: '2px 0 6px', wordBreak: 'break-all' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url}</span>
                    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                  </a>
                )}
                <div className="row">
                  {r.status === 'done' ? <Badge v={r.verdict} /> : <span className="mu small">In Progress</span>}
                  {r.syntheticMedia && <RiskBadge risk={r.syntheticMedia.risk} />}
                </div>
                {r.explanation && (
                  <p className="mu small" style={{ margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {r.explanation}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => onOpen(r.id)}>View Dossier</button>
                  {onRerun && r.status === 'error' && (
                    <button className="btn sm" onClick={() => onRerun(r, { forceRescan: true })} title="Re-run failed analysis">
                      <Ic n="spark" s={13} /> Retry
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default History;
