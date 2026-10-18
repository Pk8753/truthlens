import { BUCKET, VERDICTS, VALID_VERDICTS, PIPELINE_VERSION, MAX_CLAIMS } from './config.js';
import { generate, parseJsonResponse, extractGroundingSources, verifyClaimsWithGrounding } from './ai.js';
import { db, gcs } from './db.js';

const PUB = `https://storage.googleapis.com/${BUCKET}/`;
export const nameOf = p => p.gcsName || (p.videoUrl?.startsWith(PUB) ? decodeURIComponent(p.videoUrl.slice(PUB.length)) : null);

async function toPart(src, isVertex) {
  if (src.youtube) return { fileData: { fileUri: src.youtube, mimeType: 'video/mp4' } };
  if (isVertex && BUCKET && src.name) {
    return { fileData: { fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'video/mp4' } };
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 20 * 1024 * 1024) throw new Error('Video is larger than 20 MB for inline free-tier processing. Use a shorter clip.');
  return { inlineData: { mimeType: src.mime === 'video/quicktime' ? 'video/mov' : (src.mime || 'video/mp4'), data: b.toString('base64') } };
}

async function toAudioPart(src, isVertex) {
  if (src.url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(src.url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Failed to fetch remote audio (HTTP ${resp.status})`);
    const mime = (resp.headers.get('content-type') || 'audio/mp3').split(';')[0];
    const arrayBuffer = await resp.arrayBuffer();
    const b = Buffer.from(arrayBuffer);
    if (b.length > 20 * 1024 * 1024) throw new Error('Remote audio file exceeds 20 MB limit.');
    return { inlineData: { mimeType: mime, data: b.toString('base64') } };
  }
  if (isVertex && BUCKET && src.name) {
    return { fileData: { fileUri: `gs://${BUCKET}/${src.name}`, mimeType: src.mime || 'audio/mp3' } };
  }
  const [b] = await gcs.bucket(BUCKET).file(src.name).download();
  if (b.length > 20 * 1024 * 1024) throw new Error('Audio file exceeds 20 MB limit.');
  return { inlineData: { mimeType: src.mime || 'audio/mp3', data: b.toString('base64') } };
}

// -------------------------------------------------------
// VIDEO FORENSIC PIPELINE
// -------------------------------------------------------
export async function analyseVideo(ai, src, model, isVertex, options = {}) {
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;
  let ext = null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) ext = data;
    }
  }

  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const media = await toPart(src, isVertex);
    const singlePassPrompt = `MULTIMODAL FORENSIC VIDEO & FACT-CHECKING ANALYSIS.
Analyze this video across audio speech, visual frames, on-screen text, and factual accuracy in a single pass.

1. AUDIAL & VISUAL EXTRACTION:
- Provide a concise transcript of audible speech (max 3000 chars).
- Extract up to 6 notable on-screen text/chyron overlays with timestamps.

2. SYNTHETIC MEDIA & DEEPFAKE FORENSICS:
- Inspect for visual/audio manipulation: lip-sync desync, facial boundary warping, unnatural blinking, or synthetic voice cloning.
- Assign risk: "low" | "moderate" | "high" | "critical".

3. FACT-CHECKING & CLAIM VERIFICATION:
- Extract at most ${MAX_CLAIMS} checkable factual claims from speech or on_screen_text and immediately verify each claim.

Return ONLY valid JSON with this exact shape:
{
  "creator": string,
  "title": string,
  "transcript": string,
  "ocrText": [{"timestamp": string, "text": string}],
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "verdict": one of [${VERDICTS}],
  "confidence": integer 0-100,
  "explanation": string,
  "claims": [
    {
      "text": string,
      "origin": "speech" | "on_screen_text",
      "timestamp": string,
      "category": "health" | "engineering" | "general" | "politics" | "breaking_news",
      "verdict": one of [${VERDICTS}],
      "explanation": string
    }
  ],
  "misleading": [string],
  "nextSteps": [string],
  "limitations": string
}`;

    let response, searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [media, { text: singlePassPrompt }] }], {
          tools: [{ googleSearch: {} }], maxOutputTokens: 2500
        }, isVertex);
        searchUsed = true;
      } catch { searchUsed = false; }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [media, { text: singlePassPrompt }] }], {
        responseMimeType: 'application/json', maxOutputTokens: 2500
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);
    if (extractionRef) {
      await extractionRef.set({ ...resData, ...(src?.youtube ? { url: src.youtube } : {}), pipelineVersion: PIPELINE_VERSION, sourceId, mediaType: 'video', updatedAt: Date.now() }, { merge: true }).catch(() => { });
    }
    return normalizeVideoReport({ ...resData, ...(src?.youtube ? { url: src.youtube } : {}) }, resData, sources, searchUsed, true);
  }

  if (!ext) {
    const media = await toPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [media, {
        text: `MULTIMODAL FORENSIC VIDEO EXTRACTION.
1. Transcribe audible speech (max 3500 chars).
2. Extract notable on-screen text/chyrons with timestamps.
3. Evaluate synthetic media / deepfake risk ("low" | "moderate" | "high" | "critical").
4. Extract up to ${MAX_CLAIMS} atomic checkable factual claims.

Return ONLY JSON:
{
  "creator": string,
  "title": string,
  "transcript": string,
  "ocrText": [{"timestamp": string, "text": string}],
  "syntheticMedia": {
    "risk": "low" | "moderate" | "high" | "critical",
    "confidence": integer 0-100,
    "reasoning": string,
    "anomalies": [string]
  },
  "claims": [
    {"text": string, "origin": "speech" | "on_screen_text", "timestamp": string, "category": string}
  ]
}`
      }]
    }], { responseMimeType: 'application/json', maxOutputTokens: 2048 }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'video';
    if (src?.youtube) ext.url = src.youtube;
    ext.updatedAt = Date.now();
    if (extractionRef) await extractionRef.set(ext, { merge: true }).catch(() => { });
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeVideoReport(ext, {
      verdict: 'Insufficient Evidence', confidence: 0,
      explanation: 'No verifiable factual claims were extracted from spoken audio or on-screen text.',
      claims: [], misleading: [],
      nextSteps: ['Verify if the video is primarily opinion, entertainment, or artistic content.']
    }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Origin: ${c.origin || 'speech'}${c.timestamp ? ` @ ${c.timestamp}` : ''}] ${c.text}`).join('\n');
  const promptText = `Verify each claim independently:\n${compactClaims}\n\nReturn JSON:\n{\n  "verdict": one of [${VERDICTS}],\n  "confidence": integer 0-100,\n  "explanation": string,\n  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],\n  "misleading": [string],\n  "nextSteps": [string],\n  "limitations": string\n}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeVideoReport(ext, rep, sources, searchAvailable, false);
}

function normalizeVideoReport(ext, rep, sources, searchAvailable, isSinglePass) {
  const videoUrl = ext?.url;
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];
  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: ['speech', 'on_screen_text'].includes(c?.origin || rawClaims[i]?.origin) ? (c?.origin || rawClaims[i]?.origin) : 'speech',
    timestamp: String(c?.timestamp || rawClaims[i]?.timestamp || '').slice(0, 20),
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || 'No claim-level explanation returned.').slice(0, 1000)
  }));
  return {
    mediaType: 'video',
    ...(videoUrl ? { url: videoUrl } : {}),
    creator: String(ext.creator || '').slice(0, 120),
    title: String(ext.title || '').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Math.round(Number(rep.confidence) || 0))),
    explanation: String(rep.explanation || 'Analysis complete.').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5).map(x => String(x).slice(0, 300)) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3).map(x => String(x).slice(0, 300)) : [],
    limitations: [String(rep.limitations || ''), `Executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass Deep Forensic'} mode with ${searchAvailable ? 'live Google Search grounding' : 'internal model knowledge'}.`].filter(Boolean).join(' '),
    transcript: typeof ext.transcript === 'string' ? ext.transcript.trim().slice(0, 4500) : '',
    ocrText: Array.isArray(ext.ocrText) ? ext.ocrText.slice(0, 8).map(o => ({ timestamp: String(o.timestamp || '').slice(0, 20), text: String(o.text || '').slice(0, 300) })) : [],
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No forensic anomalies detected.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
    },
    sources, pipelineVersion: PIPELINE_VERSION
  };
}

// -------------------------------------------------------
// AUDIO FORENSIC PIPELINE
// -------------------------------------------------------
export async function analyseAudio(ai, src, model, isVertex, options = {}) {
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;
  let ext = null;

  if (extractionRef && !forceRescan) {
    const cachedExtDoc = await extractionRef.get();
    if (cachedExtDoc.exists) {
      const data = cachedExtDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) ext = data;
    }
  }

  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const audioPart = await toAudioPart(src, isVertex);
    const singlePrompt = `AUDIO FORENSIC, VOICE CLONE & FACT-CHECKING ANALYSIS.\nAnalyze this audio in a single pass for voice synthesis markers, transcription, and factual claim verification.\n\nReturn ONLY valid JSON:\n{\n  "title": string,\n  "speaker": string,\n  "transcript": string,\n  "syntheticMedia": {\n    "risk": "low" | "moderate" | "high" | "critical",\n    "confidence": integer 0-100,\n    "reasoning": string,\n    "anomalies": [string],\n    "cadenceScore": integer 0-100,\n    "voiceCloningDetected": boolean\n  },\n  "verdict": one of [${VERDICTS}],\n  "confidence": integer 0-100,\n  "explanation": string,\n  "claims": [\n    {"text": string, "timestamp": string, "category": string, "verdict": one of [${VERDICTS}], "explanation": string}\n  ],\n  "misleading": [string],\n  "nextSteps": [string],\n  "limitations": string\n}`;

    let response, searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [audioPart, { text: singlePrompt }] }], {
          tools: [{ googleSearch: {} }], maxOutputTokens: 2200
        }, isVertex);
        searchUsed = true;
      } catch { searchUsed = false; }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [audioPart, { text: singlePrompt }] }], {
        responseMimeType: 'application/json', maxOutputTokens: 2200
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);
    if (extractionRef) {
      await extractionRef.set({ ...resData, pipelineVersion: PIPELINE_VERSION, sourceId, mediaType: 'audio', updatedAt: Date.now() }, { merge: true }).catch(() => { });
    }
    return normalizeAudioReport(resData, resData, sources, searchUsed, true);
  }

  if (!ext) {
    const audioPart = await toAudioPart(src, isVertex);
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [audioPart, {
        text: `AUDIO FORENSIC & SYNTHETIC VOICE EXTRACTION.\nEvaluate prosody, breathing, voice cloning markers, transcribe speech, and extract up to ${MAX_CLAIMS} claims.\nReturn ONLY JSON:\n{\n  "title": string,\n  "speaker": string,\n  "transcript": string,\n  "syntheticMedia": {\n    "risk": "low" | "moderate" | "high" | "critical",\n    "confidence": integer 0-100,\n    "reasoning": string,\n    "anomalies": [string],\n    "cadenceScore": integer 0-100,\n    "voiceCloningDetected": boolean\n  },\n  "claims": [{"text": string, "timestamp": string, "category": string}]\n}`
      }]
    }], { responseMimeType: 'application/json', maxOutputTokens: 2048 }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'audio';
    ext.updatedAt = Date.now();
    if (extractionRef) await extractionRef.set(ext, { merge: true }).catch(() => { });
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeAudioReport(ext, { verdict: 'Insufficient Evidence', confidence: 0, explanation: 'No verifiable factual claims were extracted from spoken audio.', claims: [], misleading: [] }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Timestamp: ${c.timestamp || 'N/A'}] ${c.text}`).join('\n');
  const promptText = `Verify these spoken claims:\n${compactClaims}\n\nReturn JSON:\n{\n  "verdict": one of [${VERDICTS}],\n  "confidence": integer 0-100,\n  "explanation": string,\n  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],\n  "misleading": [string],\n  "nextSteps": [string],\n  "limitations": string\n}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeAudioReport(ext, rep, sources, searchAvailable, false);
}

function normalizeAudioReport(ext, rep, sources, searchAvailable, isSinglePass) {
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];
  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: 'speech',
    timestamp: String(c?.timestamp || rawClaims[i]?.timestamp || '').slice(0, 20),
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  }));
  return {
    mediaType: 'audio',
    creator: String(ext.speaker || 'Unknown Speaker').slice(0, 120),
    title: String(ext.title || 'Audio Recording').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    limitations: `Audio forensics executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass'} mode (${searchAvailable ? 'Live Search Grounded' : 'Model Knowledge'}).`,
    transcript: String(ext.transcript || '').trim().slice(0, 4500),
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No acoustic anomalies detected.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : [],
      cadenceScore: Number(ext.syntheticMedia?.cadenceScore) || 85,
      voiceCloningDetected: Boolean(ext.syntheticMedia?.voiceCloningDetected)
    },
    sources, pipelineVersion: PIPELINE_VERSION
  };
}

// -------------------------------------------------------
// ARTICLE FORENSIC PIPELINE
// -------------------------------------------------------
export async function analyseArticle(ai, input, model, isVertex, options = {}) {
  const { text, url, title, author } = input;
  const { sourceId, forceRescan = false, refreshFactCheckOnly = false, quotaMode = 'single_pass', useSearch = true } = options;
  const sourceText = String(text || '').trim().slice(0, 10000);
  const extractionRef = sourceId ? db.doc(`extractions/${sourceId}`) : null;

  let ext = null;
  if (extractionRef && !forceRescan) {
    const cachedDoc = await extractionRef.get();
    if (cachedDoc.exists) {
      const data = cachedDoc.data();
      if (data.pipelineVersion === PIPELINE_VERSION || refreshFactCheckOnly) ext = data;
    }
  }

  if (!ext && !sourceText) throw new Error('Please provide article text or a valid article URL to inspect.');

  if (!ext && quotaMode === 'single_pass' && !refreshFactCheckOnly) {
    const singlePrompt = `ARTICLE FORENSIC, AI STYLOMETRY & FACT-CHECKING ANALYSIS.\nAnalyze this article in a single pass.\n\nMetadata:\nTitle: ${title || 'Unknown'} | Author: ${author || 'Unknown'} | URL: ${url || 'N/A'}\n\nContent:\n${sourceText}\n\nReturn ONLY valid JSON:\n{\n  "detectedTitle": string,\n  "detectedAuthor": string,\n  "syntheticMedia": {\n    "risk": "low" | "moderate" | "high" | "critical",\n    "confidence": integer 0-100,\n    "aiProbability": integer 0-100,\n    "sensationalismScore": integer 0-100,\n    "reasoning": string,\n    "anomalies": [string]\n  },\n  "quotes": [{"speaker": string, "quote": string}],\n  "verdict": one of [${VERDICTS}],\n  "confidence": integer 0-100,\n  "explanation": string,\n  "claims": [\n    {"text": string, "category": string, "verdict": one of [${VERDICTS}], "explanation": string}\n  ],\n  "misleading": [string],\n  "nextSteps": [string],\n  "limitations": string\n}`;

    let response, searchUsed = false;
    if (useSearch) {
      try {
        response = await generate(ai, model, [{ role: 'user', parts: [{ text: singlePrompt }] }], {
          tools: [{ googleSearch: {} }], maxOutputTokens: 2200
        }, isVertex);
        searchUsed = true;
      } catch { searchUsed = false; }
    }
    if (!response) {
      response = await generate(ai, model, [{ role: 'user', parts: [{ text: singlePrompt }] }], {
        responseMimeType: 'application/json', maxOutputTokens: 2200
      }, isVertex);
    }

    const resData = parseJsonResponse(response);
    const sources = extractGroundingSources(response);
    if (extractionRef) {
      await extractionRef.set({ ...resData, ...(url ? { url } : {}), pipelineVersion: PIPELINE_VERSION, sourceId, mediaType: 'article', updatedAt: Date.now() }, { merge: true }).catch(() => { });
    }
    return normalizeArticleReport(resData, resData, { title, author, url }, sources, searchUsed, true);
  }

  if (!ext) {
    const extResponse = await generate(ai, model, [{
      role: 'user',
      parts: [{
        text: `ARTICLE & TEXT FORENSIC EXTRACTION.\nTitle: ${title || 'Unknown'} | Author: ${author || 'Unknown'}\nContent:\n${sourceText}\n\nReturn ONLY JSON:\n{\n  "detectedTitle": string,\n  "detectedAuthor": string,\n  "syntheticMedia": {\n    "risk": "low" | "moderate" | "high" | "critical",\n    "confidence": integer 0-100,\n    "aiProbability": integer 0-100,\n    "sensationalismScore": integer 0-100,\n    "reasoning": string,\n    "anomalies": [string]\n  },\n  "quotes": [{"speaker": string, "quote": string}],\n  "claims": [{"text": string, "category": string}]\n}`
      }]
    }], { responseMimeType: 'application/json', maxOutputTokens: 2048 }, isVertex);

    ext = parseJsonResponse(extResponse);
    ext.pipelineVersion = PIPELINE_VERSION;
    ext.sourceId = sourceId;
    ext.mediaType = 'article';
    if (url) ext.url = url;
    ext.updatedAt = Date.now();
    if (extractionRef) await extractionRef.set(ext, { merge: true }).catch(() => { });
  }

  const claims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS).filter(c => c?.text?.trim()) : [];
  if (!claims.length) {
    return normalizeArticleReport(ext, { verdict: 'Insufficient Evidence', confidence: 0, explanation: 'No verifiable factual claims were extracted from this article.', claims: [] }, { title, author, url: url || ext.url }, [], false, false);
  }

  const compactClaims = claims.map((c, i) => `${i + 1}. [Category: ${c.category || 'general'}] ${c.text}`).join('\n');
  const promptText = `Verify each article claim against primary authoritative reporting:\n${compactClaims}\n\nReturn JSON:\n{\n  "verdict": one of [${VERDICTS}],\n  "confidence": integer 0-100,\n  "explanation": string,\n  "claims": [{"text": string, "verdict": one of [${VERDICTS}], "explanation": string}],\n  "misleading": [string],\n  "nextSteps": [string],\n  "limitations": string\n}`;

  const { rep, sources, searchAvailable } = await verifyClaimsWithGrounding(ai, model, promptText, useSearch, isVertex);
  return normalizeArticleReport(ext, rep, { title, author, url: url || ext.url }, sources, searchAvailable, false);
}

function normalizeArticleReport(ext, rep, metaInput, sources, searchAvailable, isSinglePass) {
  const articleUrl = metaInput.url || ext?.url;
  const rawClaims = Array.isArray(ext.claims) ? ext.claims.slice(0, MAX_CLAIMS) : [];
  const repClaims = Array.isArray(rep.claims) ? rep.claims.slice(0, MAX_CLAIMS) : [];
  const claimResults = (repClaims.length ? repClaims : rawClaims).map((c, i) => ({
    text: String(c?.text || rawClaims[i]?.text || '').slice(0, 700),
    origin: 'article_text',
    verdict: VALID_VERDICTS.has(c?.verdict) ? c.verdict : 'Insufficient Evidence',
    explanation: String(c?.explanation || '').slice(0, 1000)
  }));
  return {
    mediaType: 'article',
    ...(articleUrl ? { url: articleUrl } : {}),
    creator: String(metaInput.author || ext.detectedAuthor || 'Unknown Journalist').slice(0, 120),
    title: String(metaInput.title || ext.detectedTitle || 'Untitled Article').slice(0, 200),
    verdict: VALID_VERDICTS.has(rep.verdict) ? rep.verdict : 'Insufficient Evidence',
    confidence: Math.max(0, Math.min(100, Number(rep.confidence) || 0)),
    explanation: String(rep.explanation || '').slice(0, 2500),
    claims: claimResults,
    quotes: Array.isArray(ext.quotes) ? ext.quotes.slice(0, 3) : [],
    misleading: Array.isArray(rep.misleading) ? rep.misleading.slice(0, 5) : [],
    nextSteps: Array.isArray(rep.nextSteps) ? rep.nextSteps.slice(0, 3) : [],
    limitations: `Article analysis executed in ${isSinglePass ? 'Single-Pass Quota-Saver' : 'Two-Pass'} mode (${searchAvailable ? 'Live Search Grounded' : 'Model Knowledge'}).`,
    syntheticMedia: {
      risk: ['low', 'moderate', 'high', 'critical'].includes(ext.syntheticMedia?.risk) ? ext.syntheticMedia.risk : 'low',
      confidence: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.confidence) || 75)),
      aiProbability: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.aiProbability) || 10)),
      sensationalismScore: Math.max(0, Math.min(100, Number(ext.syntheticMedia?.sensationalismScore) || 20)),
      reasoning: String(ext.syntheticMedia?.reasoning || 'No stylistic generative artifacts observed.').slice(0, 500),
      anomalies: Array.isArray(ext.syntheticMedia?.anomalies) ? ext.syntheticMedia.anomalies.slice(0, 5).map(a => String(a).slice(0, 200)) : []
    },
    sources, pipelineVersion: PIPELINE_VERSION
  };
}
