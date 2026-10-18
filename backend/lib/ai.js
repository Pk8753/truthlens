import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, MODEL_ALIASES, MODEL, FALLBACK_MODEL, MIN_REQUEST_INTERVAL_MS, MAX_CONCURRENT_JOBS } from './config.js';

const inFlight = new Map();
let activeJobs = 0;
const jobQueue = [];
let lastApiCallTime = 0;
let rateLimitChain = Promise.resolve();

export { inFlight };

export function acquireSlot() {
  return new Promise(resolve => {
    if (activeJobs < MAX_CONCURRENT_JOBS) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(resolve);
    }
  });
}

export function releaseSlot() {
  activeJobs--;
  if (jobQueue.length > 0) {
    activeJobs++;
    const next = jobQueue.shift();
    next();
  }
}

export function getQueueStats() {
  return { queueDepth: jobQueue.length, activeJobs };
}

// Global Token-Bucket Pacer: Prevents burst 429 errors on AI Studio Free Tier
export async function paceRequest(isVertex = false) {
  if (isVertex) return;
  rateLimitChain = rateLimitChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastApiCallTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    lastApiCallTime = Date.now();
  });
  return rateLimitChain;
}

export const keyOf = req => req.get('x-ai-key') || GEMINI_API_KEY;
export const isVertexOf = req => req.get('x-ai-provider') === 'vertex';
export const quotaModeOf = req => {
  const m = req.get('x-quota-mode') || req.body?.quotaMode || 'single_pass';
  return ['single_pass', 'two_pass'].includes(m) ? m : 'single_pass';
};
export const useSearchOf = req => {
  const h = req.get('x-use-search');
  if (h !== undefined) return h !== 'false';
  if (req.body?.useSearch !== undefined) return Boolean(req.body.useSearch);
  return true;
};
export const clientFor = req => {
  const k = keyOf(req);
  return k ? new GoogleGenAI(isVertexOf(req) ? { vertexai: true, apiKey: k } : { apiKey: k }) : null;
};
export const modelOf = req => {
  const requested = req.get('x-ai-model');
  if (!requested) return MODEL_ALIASES[MODEL] || 'gemini-2.5-flash';
  return MODEL_ALIASES[requested] || null;
};
export const clean = (e, k) => {
  let m = String(e?.message || e);
  if (k) m = m.split(k).join('***');
  return m.slice(0, 300);
};

export function isQuotaError(e) {
  const s = `${e?.status || ''} ${e?.code || ''} ${e?.message || ''}`.toLowerCase();
  return /429|resource_exhausted|rate.?limit|quota|too many requests/.test(s);
}

export function publicAiError(e, key) {
  if (isQuotaError(e)) {
    return 'Gemini Free-Tier Quota reached (RPM/RPD). Enable "Single-Pass Quota Saver" or switch model to Gemini 2.5 Flash Lite in Settings.';
  }
  const status = Number(e?.status || e?.code);
  if (status === 401 || status === 403) {
    return 'The AI key or provider configuration was rejected. Check your key, enabled APIs, and billing status.';
  }
  return clean(e, key);
}

// Resilient Generate with Pacing + Model Auto-Fallback
export async function generate(ai, model, contents, config = {}, isVertex = false) {
  await paceRequest(isVertex);
  try {
    return await ai.models.generateContent({
      model,
      contents,
      config: { candidateCount: 1, temperature: 0.1, ...config }
    });
  } catch (e) {
    if (isQuotaError(e) && model !== FALLBACK_MODEL) {
      console.warn(`Quota reached on ${model}. Auto-falling back to ${FALLBACK_MODEL} after 4.5s cooldown...`);
      await new Promise(r => setTimeout(r, 4500));
      await paceRequest(isVertex);
      return await ai.models.generateContent({
        model: FALLBACK_MODEL,
        contents,
        config: { candidateCount: 1, temperature: 0.1, ...config }
      });
    }
    throw e;
  }
}

export function parseJsonResponse(response) {
  const raw = response?.text;
  if (!raw) throw new Error('The AI returned an empty response. Please try again.');
  try { return JSON.parse(raw); }
  catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try { return JSON.parse(match[1]); } catch { }
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch { }
    }
    throw new Error('The AI returned an invalid structured response. Please retry.');
  }
}

export function extractGroundingSources(response) {
  const grounding = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return [...new Map(
    grounding.filter(g => g?.web?.uri).map(g => [g.web.uri, { uri: g.web.uri, title: g.web.title || g.web.uri }])
  ).values()].slice(0, 8);
}

export async function verifyClaimsWithGrounding(ai, model, promptText, useSearch = true, isVertex = false) {
  let verifyResponse;
  let searchAvailable = useSearch;

  if (useSearch) {
    try {
      verifyResponse = await generate(ai, model, [{
        role: 'user',
        parts: [{ text: `${promptText}\n\nIMPORTANT: Return ONLY raw valid JSON matching the schema with no markdown commentary.` }]
      }], {
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 2048
      }, isVertex);
    } catch (e) {
      console.warn('Google Search Grounding unavailable or quota reached. Falling back to internal knowledge base:', e?.message);
      searchAvailable = false;
    }
  }

  if (!verifyResponse) {
    verifyResponse = await generate(ai, model, [{
      role: 'user',
      parts: [{ text: `${promptText}\n\nNOTE: Verify each claim using your authoritative knowledge base. Return ONLY valid JSON.` }]
    }], {
      responseMimeType: 'application/json',
      maxOutputTokens: 2048
    }, isVertex);
  }

  const rep = parseJsonResponse(verifyResponse);
  const sources = extractGroundingSources(verifyResponse);
  return { rep, sources, searchAvailable };
}
