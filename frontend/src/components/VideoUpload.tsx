import { useRef, useState } from 'react';
import type { ToastFn } from '../types';
import { Ic } from '../ui';
import { DAILY_LIMIT } from '../api';

// Demo limit popup
function DemoLimitPopup({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="sheet" onClick={e => e.stopPropagation()} style={{ textAlign: 'center', maxWidth: 480 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🚦</div>
        <h2 className="sec" style={{ fontSize: 26, marginBottom: 8 }}>Demo Mode Limit Reached</h2>
        <p className="mu" style={{ marginBottom: 16 }}>
          TruthLens is currently in <b>demo mode</b> with a limit of <b>{DAILY_LIMIT} uploads per day</b> per media type. This restriction helps protect shared AI quota resources during the demo period.
        </p>
        <p className="mu small" style={{ marginBottom: 20 }}>
          Limits reset daily at midnight UTC. For unlimited access, deploy your own instance with a dedicated Gemini API key.
        </p>
        <button className="btn primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

function VideoUpload({
  onDone,
  toast,
  onLimitReached
}: {
  onDone: (p: any) => void;
  toast: ToastFn;
  onLimitReached: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [prev, setPrev] = useState('');
  const [title, setTitle] = useState('');
  const [creator, setCreator] = useState('');
  const [caption, setCaption] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const inp = useRef<HTMLInputElement>(null);

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
    const q = new URLSearchParams({ title: title.trim() || file.name, creator: creator.trim() || 'Uploader', caption: caption.trim() });
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload?' + q);
    x.setRequestHeader('Content-Type', file.type);
    x.upload.onprogress = e => e.lengthComputable && setPct(Math.round(e.loaded / e.total * 100));
    x.onload = () => {
      setPct(null);
      let d: any = {};
      try { d = JSON.parse(x.responseText); } catch { }
      if (x.status === 429 || d.limitReached) {
        onLimitReached();
      } else if (x.status < 300) {
        toast(d.duplicate ? 'Duplicate video recognized.' : 'Video added to feed.');
        onDone(d);
        setFile(null); setPrev(''); setTitle(''); setCreator(''); setCaption('');
      } else {
        toast(d.error || 'Upload failed.', 'err');
      }
    };
    x.onerror = () => { setPct(null); toast('Network error.', 'err'); };
    setPct(0);
    x.send(file);
  };

  return (
    <section id="upload" style={{ marginTop: 56 }}>
      <div className="grid2">
        <div>
          <h2 className="sec">Add Video to Feed</h2>
          <p className="mu">Upload clips to inspect speech transcripts, on-screen chyrons, and synthetic media risks.</p>
          <p className="mu small" style={{ marginTop: 8 }}>
            Supports MP4, WebM, MOV · Max 25 MB · {DAILY_LIMIT} uploads/day (demo mode)
          </p>
        </div>
        <div>
          <div
            className={'drop' + (over ? ' over' : '')}
            onDragOver={e => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
          >
            <Ic n="upload" s={28} />
            <p style={{ margin: '8px 0' }}>Drag video here or</p>
            <button className="btn primary sm" id="upload-video-btn" style={{ background: 'var(--blue)', borderColor: 'var(--blue)', color: '#fff' }} onClick={() => inp.current?.click()}>
              <Ic n="upload" s={14} /> Upload Video Clip
            </button>
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

// YouTube analysis section
export function YouTubeSection({
  url, setUrl, busy, onAnalyse, toast
}: {
  url: string;
  setUrl: (u: string) => void;
  busy: boolean;
  onAnalyse: () => void;
  toast: ToastFn;
}) {
  const ytOk = (u: string) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)[\w-]{11}|youtu\.be\/[\w-]{11})/.test(u.trim());
  return (
    <section id="youtube-section" style={{ marginTop: 56 }}>
      <div className="grid2">
        <div>
          <h2 className="sec">Analyse YouTube Video</h2>
          <p className="mu">Paste any public YouTube URL to extract speech, on-screen chyrons, and run deepfake forensics — no download needed.</p>
          <p className="mu small" style={{ marginTop: 8 }}>Supports youtube.com and youtu.be links, including Shorts.</p>
        </div>
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <svg width={22} height={22} viewBox="0 0 24 24" fill="#ff0000" aria-hidden="true"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" /></svg>
            <b style={{ fontSize: 16 }}>YouTube URL</b>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input id="url-input" className="field" placeholder="https://youtube.com/watch?v=…" value={url} onChange={e => setUrl(e.target.value)} />
          </div>
          <button
            className="btn primary full"
            id="analyse-yt-btn"
            disabled={busy || !url.trim()}
            onClick={() => {
              if (ytOk(url)) onAnalyse();
              else toast('Please enter a valid YouTube link.', 'err');
            }}
          >
            <svg width={16} height={16} viewBox="0 0 24 24" fill="#fff" aria-hidden="true" style={{ marginRight: 6 }}><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" /></svg>
            {busy ? 'Analysing…' : 'Analyse YouTube Video'}
          </button>
        </div>
      </div>
    </section>
  );
}

export { VideoUpload, DemoLimitPopup };
