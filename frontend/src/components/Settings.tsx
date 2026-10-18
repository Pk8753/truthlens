import { useEffect, useState } from 'react';
import type { Prov, QuotaMode, ModelId } from '../api';
import { Ic } from '../ui';
import { MODEL_OPTIONS, getKey, setKey, getModel, normalizeModel, getQuotaMode, getUseSearch, active, PROV, api } from '../api';
import type { ToastFn } from '../types';

function Settings({ onClose, toast }: { onClose: () => void; toast: ToastFn }) {
  const [vals, setVals] = useState<Record<Prov, string>>({ gemini: getKey('gemini'), vertex: getKey('vertex') });
  const [rem, setRem] = useState(!!(localStorage.getItem('ai_key_gemini') || localStorage.getItem('ai_key_vertex')));
  const [model, setModel] = useState<ModelId>(getModel);
  const [quotaMode, setQuotaMode] = useState<QuotaMode>(getQuotaMode);
  const [useSearch, setUseSearch] = useState<boolean>(getUseSearch);
  const [, setAct] = useState<Prov>(active());
  const [st, setSt] = useState<Record<string, string>>({});

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = (p: Prov) => {
    const k = vals[p].trim();
    if (k.length < 20) return toast('Key looks too short.', 'err');
    setKey(p, k, rem);
    localStorage.setItem('ai_active', p);
    setAct(p);
    setSt(s => ({ ...s, [p]: 'Saved.' }));
    toast('Key saved in this browser.');
  };
  const remove = (p: Prov) => {
    setKey(p, '', false);
    setVals(v => ({ ...v, [p]: '' }));
    setSt(s => ({ ...s, [p]: '' }));
    toast('Key removed.');
  };
  const test = async (p: Prov) => {
    if (!getKey(p)) return toast('Save the key first.', 'err');
    localStorage.setItem('ai_active', p);
    setAct(p);
    setSt(s => ({ ...s, [p]: 'Checking with server…' }));
    const d = await api('/check-key', {});
    setSt(s => ({ ...s, [p]: d.ok ? `Confirmed ✓ (${d.resolvedModel})` : d.error || 'Key rejected.' }));
  };

  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label="AI Configuration">
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="row">
          <h2 className="sec" style={{ fontSize: 26, margin: 0 }}>AI &amp; Quota Configuration</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
        </div>
        <p className="mu small">Optimize execution for Google AI Studio Free-Tier limits or Vertex AI.</p>

        <label className="l">Analysis Model</label>
        <select className="field" value={model} onChange={e => { const next = normalizeModel(e.target.value); setModel(next); localStorage.setItem('ai_model', next); }}>
          {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>

        <label className="l" style={{ marginTop: 12 }}>Execution Pipeline Mode</label>
        <select className="field" value={quotaMode} onChange={e => { const next = e.target.value === 'two_pass' ? 'two_pass' : 'single_pass'; setQuotaMode(next as QuotaMode); localStorage.setItem('ai_quota_mode', next); }}>
          <option value="single_pass">Single-Pass Quota Saver (1 API Call · Best for AI Studio Free Tier)</option>
          <option value="two_pass">Two-Pass Deep Forensic (2 API Calls · Decoupled Extraction &amp; Search)</option>
        </select>

        <label className="small" style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input type="checkbox" checked={useSearch} onChange={e => { setUseSearch(e.target.checked); localStorage.setItem('ai_use_search', String(e.target.checked)); }} />
          <span>Enable Google Search Grounding (auto-falls back to model knowledge if daily search quota is exhausted)</span>
        </label>

        <div className="card" style={{ marginTop: 14 }}>
          <b>Google AI Studio (Gemini API Key)</b>
          <input className="field" type="password" value={vals.gemini} onChange={e => setVals(v => ({ ...v, gemini: e.target.value }))} placeholder="Paste AIza... Gemini key" style={{ margin: '8px 0' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={() => save('gemini')}>Save</button>
            <button className="btn sm" onClick={() => test('gemini')}>Test</button>
            <button className="btn sm" onClick={() => remove('gemini')}>Remove</button>
          </div>
          {st.gemini && <p className="small mu" style={{ margin: '8px 0 0' }}>{st.gemini}</p>}
        </div>

        <label className="small" style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <input type="checkbox" checked={rem} onChange={e => setRem(e.target.checked)} />
          <span>Remember keys across browser restarts</span>
        </label>
      </div>
    </div>
  );
}

export default Settings;
