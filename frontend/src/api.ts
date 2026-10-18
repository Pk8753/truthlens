// Model & provider configuration
export type Prov = 'gemini' | 'vertex';
export type QuotaMode = 'single_pass' | 'two_pass';
export const DAILY_LIMIT = 10;

export const MODEL_OPTIONS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (Recommended · Best Accuracy & Speed)' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Balanced)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (Max Quota · 30 RPM Free Tier)' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' }
] as const;

export type ModelId = typeof MODEL_OPTIONS[number]['id'];
export const DEFAULT_MODEL: ModelId = 'gemini-3.5-flash';
export const getModel = (): ModelId => MODEL_OPTIONS.find(m => m.id === localStorage.getItem('ai_model'))?.id || DEFAULT_MODEL;
export const normalizeModel = (value: string): ModelId => MODEL_OPTIONS.find(m => m.id === value)?.id || DEFAULT_MODEL;
export const getQuotaMode = (): QuotaMode => (localStorage.getItem('ai_quota_mode') === 'two_pass' ? 'two_pass' : 'single_pass');
export const getUseSearch = (): boolean => localStorage.getItem('ai_use_search') !== 'false';

export const PROV: Prov[] = ['gemini', 'vertex'];
export const getKey = (p: Prov) => localStorage.getItem('ai_key_' + p) || sessionStorage.getItem('ai_key_' + p) || '';
export const setKey = (p: Prov, k: string, remember: boolean) => {
  localStorage.removeItem('ai_key_' + p);
  sessionStorage.removeItem('ai_key_' + p);
  if (k) (remember ? localStorage : sessionStorage).setItem('ai_key_' + p, k);
};
export const active = (): Prov => {
  const a = localStorage.getItem('ai_active') as Prov;
  return a && getKey(a) ? a : PROV.find(getKey) || 'gemini';
};

export const api = async (path: string, body?: unknown) => {
  const p = active(), k = getKey(p);
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-ai-model': getModel(),
    'x-quota-mode': getQuotaMode(),
    'x-use-search': String(getUseSearch())
  };
  if (k) { h['x-ai-key'] = k; h['x-ai-provider'] = p; }
  try {
    const r = await fetch('/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: h,
      body: body ? JSON.stringify(body) : undefined
    });
    return await r.json();
  } catch {
    return { error: 'Could not reach the server. Check your connection.' };
  }
};
