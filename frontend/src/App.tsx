import { useCallback, useEffect, useRef, useState } from 'react';
import type { Post, Report, DashboardStats, TabId, ToastFn } from './types';
import { api, PROV, getKey } from './api';
import { Ic, Badge, RiskBadge, when, ytOk } from './ui';
import ReportModal from './components/ReportModal';
import Overview from './components/Overview';
import Phone from './components/Phone';
import { VideoUpload, YouTubeSection, DemoLimitPopup } from './components/VideoUpload';
import ArticleLab from './components/ArticleLab';
import History from './components/History';
import Settings from './components/Settings';

// ---------- App ----------
export default function App() {
  const [tab, setTab] = useState<TabId>('video');
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
  const [showDemoPopup, setShowDemoPopup] = useState(false);

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
    if (d.needKey) { toast(d.error, 'err'); setSettings(true); }
    else if (d.id) { setOpen(d.id); loadReports(); loadStats(); }
    else toast(d.error || 'Investigation failed to initialize.', 'err');
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
    if (d.needKey) { toast(d.error, 'err'); setSettings(true); }
    else if (d.id) { toast(options.forceRescan ? 'Full re-scan dispatched.' : 'Fact-check refreshed.'); loadReports(); loadStats(); }
    else toast(d.error || 'Re-run failed.', 'err');
  };

  const scrollTo = (id: string, focusId?: string) => {
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      if (focusId) document.getElementById(focusId)?.focus();
    }, 60);
  };

  const goUpload = () => scrollTo('upload');
  const goYouTube = () => scrollTo('youtube-section', 'url-input');

  const cur = posts[sel], curRep = cur && repOf(cur.id), hasKey = PROV.some(getKey);

  // Tab definitions — Command Hub moved to last
  const TABS: { id: TabId; label: string }[] = [
    { id: 'video', label: 'Explore Videos' },
    { id: 'article', label: 'Article Lab' },
    { id: 'history', label: 'Dossier Log' },
    { id: 'overview', label: 'Command Hub' }
  ];

  return (
    <>
      <header className="hdr">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => setTab('video')}>
          <Ic n="M12 4a8 8 0 100 16 8 8 0 000-16zM21 21l-4.3-4.3" /> TruthLens
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings" title={hasKey ? 'AI key set' : 'Add AI key'}>
          <Ic n="gear" />{hasKey && <span className="keydot" />}
        </button>
      </header>

      <div className="wrap">
        <section className="hero">
          <h1 className="hero-title rise">TruthLens — Multimodal Verification</h1>
          <p className="sub rise" style={{ animationDelay: '.12s' }}>See beyond the scroll. Discover what's real.</p>
          <p className="desc rise" style={{ animationDelay: '.24s' }}>
            An AI intelligence engine engineered for newsrooms and publishers to detect synthetic media, evaluate on-screen text, verify claims, and combat misinformation in real time.
          </p>
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
            {TABS.map(({ id, label }) => (
              <button key={id} role="tab" aria-selected={tab === id} className={'tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {/* Tab Panels */}
          <div className="panel" key={tab}>
            {tab === 'overview' && (
              <Overview stats={stats} onOpenReport={setOpen} onSwitchTab={t => { setTab(t); }} />
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
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn primary" id="upload-clip-btn" style={{ background: 'var(--blue)', borderColor: 'var(--blue)', color: '#fff' }} onClick={goUpload}>
                        <Ic n="upload" s={16} /> Upload Video Clip
                      </button>
                      <button className="btn" onClick={goYouTube}>
                        <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z" /></svg>
                        Analyse YouTube URL
                      </button>
                    </div>
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
                    goUpload={goUpload}
                    goYouTube={goYouTube}
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
                  </aside>
                </div>

                {/* Upload section */}
                <VideoUpload
                  toast={toast}
                  onLimitReached={() => setShowDemoPopup(true)}
                  onDone={async p => {
                    const l = await loadPosts();
                    const i = l.findIndex(x => x.id === p.id);
                    if (i >= 0) setSel(i);
                  }}
                />

                {/* YouTube analyse section */}
                <YouTubeSection
                  url={url}
                  setUrl={setUrl}
                  busy={busy === 'url'}
                  onAnalyse={() => startAnalysis('/analyse/video', { url: url.trim() }, 'url')}
                  toast={toast}
                />
              </>
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
                onRerun={handleRerun}
              />
            )}
          </div>
        </div>
      </div>

      {/* Footer with disclaimer and copyright */}
      <footer className="footer">
        <q>Empowering newsrooms and readers with transparent media verification.</q>
        <span className="mu small">Built with Gemini &amp; Vertex AI on Google Cloud</span>
        <div className="footer-meta">
          <p className="footer-disclaimer">
            <strong>AI Disclaimer:</strong> TruthLens uses AI to assist verification — outputs are probabilistic, not definitive proof. Always corroborate findings with primary sources before publication.
          </p>
          <p className="footer-copyright">
            © {new Date().getFullYear()} TruthLens. All rights reserved. Video content rights belong to their respective creators.
            Media analysis is provided for journalistic research and educational purposes only.
          </p>
          <p className="footer-links mu small">
            <span>Demo Mode · 10 uploads/day limit</span>
          </p>
        </div>
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

      {showDemoPopup && <DemoLimitPopup onClose={() => setShowDemoPopup(false)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </>
  );
}
