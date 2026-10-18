import { useState } from 'react';
import type { ToastFn } from '../types';
import { Ic } from '../ui';

function ArticleLab({
  onAnalyseArticle, busy, toast
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
        <input className="field" type="url" placeholder="https://news-outlet.com/article..." value={url} onChange={e => setUrl(e.target.value)} style={{ marginBottom: 14 }} />
        <div style={{ textAlign: 'center', margin: '8px 0', color: 'var(--mu)', fontSize: 13 }}>— OR PASTE TEXT —</div>
        <label className="l">Article Headline (optional)</label>
        <input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="Article Headline" />
        <label className="l">Bylined Author (optional)</label>
        <input className="field" value={author} onChange={e => setAuthor(e.target.value)} placeholder="Journalist / Author" />
        <label className="l">Article Body</label>
        <textarea className="field" rows={6} placeholder="Paste full article text or paragraphs here to inspect stylometry and factual claims…" value={text} onChange={e => setText(e.target.value)} />
        <button className="btn primary full" style={{ marginTop: 18 }} disabled={busy || (!url.trim() && text.trim().length < 50)} onClick={submit}>
          {busy ? 'Investigating Article…' : 'Run Article Forensic Analysis'}
        </button>
      </div>
    </div>
  );
}

export default ArticleLab;
