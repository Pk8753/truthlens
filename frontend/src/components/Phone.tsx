import { useRef, useState } from 'react';
import { useEffect } from 'react';
import type { Post, Report, ToastFn } from '../types';
import { Ic, V } from '../ui';

function Phone({
  posts, loading, sel, setSel, repOf, busy, onAnalyse, onOpen, goUpload, goYouTube
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
  goYouTube: () => void;
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
      if (i === sel) { v.muted = muted; v.play().catch(() => setPlaying(false)); }
      else v.pause();
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
            <button className="btn sm" onClick={goUpload}>Upload Video</button>
            <button className="btn sm" onClick={goYouTube} style={{ marginTop: 6 }}>Analyse YouTube URL</button>
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
                        loop playsInline muted={muted}
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
                        {r.status === 'done' ? (<>● {V[r.verdict || '']?.label || 'Analysed'}</>) : r.status === 'processing' ? 'Analysing…' : 'Analysis failed'}
                      </span>
                    )}
                    <div className="meta">
                      <b>{p.title}</b>
                      <span>@{p.creator}</span>
                      {p.caption && <p>{p.caption}</p>}
                      <button
                        className="btn primary full"
                        disabled={busy === p.id}
                        onClick={() => { if (r?.status === 'done') onOpen(r.id); else onAnalyse(p.id); }}
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

export default Phone;
