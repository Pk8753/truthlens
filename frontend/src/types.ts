// Shared types for TruthLens frontend

export type MediaType = 'video' | 'audio' | 'article';

export type Post = {
  id: string;
  creator: string;
  title: string;
  caption?: string;
  videoUrl: string;
};

export type Claim = {
  text: string;
  origin?: 'speech' | 'on_screen_text' | 'article_text';
  timestamp?: string;
  verdict: string;
  explanation: string;
};

export type OcrBlock = { timestamp?: string; text: string };
export type Quote = { speaker: string; quote: string };

export type SyntheticMedia = {
  risk: 'low' | 'moderate' | 'high' | 'critical';
  confidence: number;
  reasoning: string;
  anomalies?: string[];
  cadenceScore?: number;
  voiceCloningDetected?: boolean;
  aiProbability?: number;
  sensationalismScore?: number;
};

export type Report = {
  id: string;
  mediaType?: MediaType;
  status: 'processing' | 'done' | 'error';
  creator?: string;
  title?: string;
  url?: string;
  postId?: string;
  audioId?: string;
  sourceId?: string;
  model?: string;
  verdict?: string;
  confidence?: number;
  explanation?: string;
  claims?: Claim[];
  ocrText?: OcrBlock[];
  quotes?: Quote[];
  syntheticMedia?: SyntheticMedia;
  sources?: { uri: string; title: string }[];
  misleading?: string[];
  nextSteps?: string[];
  limitations?: string;
  transcript?: string;
  error?: string;
  updatedAt?: number;
};

export type DashboardStats = {
  total: number;
  byType: { video: number; audio: number; article: number };
  byVerdict: Record<string, number>;
  byRisk: Record<string, number>;
  threatRate: number;
  recent: Report[];
};

export type ToastFn = (msg: string, kind?: 'ok' | 'err') => void;
export type Prov = 'gemini' | 'vertex';
export type QuotaMode = 'single_pass' | 'two_pass';

export type TabId = 'video' | 'audio' | 'article' | 'history' | 'overview';

export type KeyFrame = { timestamp: number; dataUrl: string };
