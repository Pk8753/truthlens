// Shared icon paths and UI primitives
import type { MediaType } from './types';

export const IC: Record<string, string> = {
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3 1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8 1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M7 4l13 8-13 8z',
  pause: 'M8 4v16M16 4v16',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  vol: 'M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 010 6',
  mute: 'M11 5L6 9H3v6h3l5 4zM17 9l5 6M22 9l-5 6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  doc: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  audio: 'M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v3',
  article: 'M4 4h16v16H4zM4 9h16M9 4v16',
  check: 'M20 6L9 17l-5-5',
  alert: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  yt: 'M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z',
  bar: 'M3 3v18h18M7 16l4-4 4 4 4-8',
  pie: 'M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10z',
  trend: 'M23 6l-9.5 9.5-5-5L1 18',
  warn: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01'
};

export const Ic = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={n in IC ? IC[n] : n} />
  </svg>
);

export const V: Record<string, { label: string; c: string }> = {
  Supported: { label: 'Verified', c: '#1a7f37' },
  Contradicted: { label: 'Contradicted', c: '#d1242f' },
  Misleading: { label: 'Potentially misleading', c: '#c2570c' },
  Mixed: { label: 'Mixed evidence', c: '#9a6700' },
  'Insufficient Evidence': { label: 'Inconclusive', c: '#6e6e73' }
};

export const Badge = ({ v }: { v?: string }) => {
  const x = V[v || ''] || { label: v || '—', c: '#6e6e73' };
  return <span className="badge" style={{ color: x.c, background: x.c + '14', borderColor: x.c + '40' }}>{x.label}</span>;
};

export const RISK_THEME: Record<string, { label: string; c: string }> = {
  low: { label: 'Synthetic Risk: Low', c: '#1a7f37' },
  moderate: { label: 'Synthetic Risk: Moderate', c: '#c2570c' },
  high: { label: 'Synthetic Risk: High', c: '#d1242f' },
  critical: { label: 'Synthetic Risk: Critical', c: '#82071e' }
};

export const RiskBadge = ({ risk }: { risk?: string }) => {
  const t = RISK_THEME[risk || 'low'] || RISK_THEME.low;
  return <span className="badge" style={{ color: t.c, background: t.c + '14', borderColor: t.c + '40' }}>{t.label}</span>;
};

export const MediaBadge = ({ type }: { type?: MediaType }) => {
  const t = type || 'video';
  const label = t === 'video' ? 'Video' : t === 'audio' ? 'Audio' : 'Article';
  const icon = t === 'video' ? 'play' : t === 'audio' ? 'audio' : 'doc';
  return (
    <span className={`media-badge ${t}`}>
      <Ic n={icon} s={12} /> {label}
    </span>
  );
};

export const ytThumb = (u?: string) => {
  const m = u?.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : '';
};
export const ytOk = (u: string) => /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)[\w-]{11}|youtu\.be\/[\w-]{11})/.test(u.trim());
export const when = (t?: number) => (t ? new Date(t).toLocaleString() : '');

export const formatMediaTime = (time: number) => {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
