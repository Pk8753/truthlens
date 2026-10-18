import crypto from 'crypto';
import { db } from './db.js';
import { DAILY_UPLOAD_LIMIT } from './config.js';

export const hash = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

// Helper: YouTube ID extraction & normalization
export const ytId = u => {
  try {
    const x = new URL(String(u || '').trim());
    if (!['http:', 'https:'].includes(x.protocol)) return null;
    const h = x.hostname.replace(/^(www\.|m\.)/, '');
    const ok = v => (/^[\w-]{11}$/.test(v || '') ? v : null);
    if (h === 'youtu.be') return ok(x.pathname.slice(1).split(/[?#]/)[0]);
    if (h === 'youtube.com') {
      if (x.pathname === '/watch') return ok(x.searchParams.get('v'));
      const m = x.pathname.match(/^\/(shorts|embed)\/([\w-]{11})/);
      if (m) return ok(m[2]);
    }
  } catch { }
  return null;
};

// Simple web text extractor for article URLs
export async function fetchArticleContent(targetUrl) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL protocol.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const resp = await fetch(targetUrl, {
    headers: { 'User-Agent': 'TruthLens-Bot/1.0 (+https://truthlens.ai)' },
    signal: controller.signal
  });
  clearTimeout(timeout);
  if (!resp.ok) throw new Error(`Could not fetch article (HTTP ${resp.status})`);
  const html = await resp.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Web Article';
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text: text.slice(0, 10000) };
}

// Upload rate limiter – tracks daily counts per IP in Firestore
export async function checkUploadLimit(ip, mediaType = 'video') {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `limits/${ip.replace(/[:.]/g, '_')}_${mediaType}_${today}`;
  const ref = db.doc(key);
  const snap = await ref.get();
  const count = snap.exists ? (snap.data().count || 0) : 0;
  if (count >= DAILY_UPLOAD_LIMIT) {
    return { allowed: false, count, limit: DAILY_UPLOAD_LIMIT };
  }
  await ref.set({ count: count + 1, updatedAt: Date.now() }, { merge: true });
  return { allowed: true, count: count + 1, limit: DAILY_UPLOAD_LIMIT };
}
