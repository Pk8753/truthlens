import type { DashboardStats, Report } from '../types';
import { Ic, Badge, RiskBadge, MediaBadge, V } from '../ui';

// Mini bar chart component
function BarChart({ data, colors }: { data: Record<string, number>; colors: Record<string, string> }) {
  const max = Math.max(...Object.values(data), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Object.entries(data).filter(([, v]) => v > 0).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 120, fontSize: 12, color: 'var(--mu)', textTransform: 'capitalize', flexShrink: 0 }}>{k}</span>
          <div style={{ flex: 1, height: 10, background: '#ececf0', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${(v / max) * 100}%`, height: '100%', background: colors[k] || 'var(--blue)', borderRadius: 99, transition: 'width .5s ease' }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, width: 28, textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// Donut-style ring display (pure CSS)
function RingMetric({ value, label, color }: { value: number; label: string; color: string }) {
  const pct = Math.min(100, Math.max(0, value));
  const deg = pct * 3.6;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: `conic-gradient(${color} ${deg}deg, #ececf0 ${deg}deg)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative'
      }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color }}>{pct}%</span>
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--mu)', textAlign: 'center', maxWidth: 80 }}>{label}</span>
    </div>
  );
}

function Overview({
  stats,
  onOpenReport,
  onSwitchTab
}: {
  stats: DashboardStats | null;
  onOpenReport: (id: string) => void;
  onSwitchTab: (tab: 'video' | 'audio' | 'article') => void;
}) {
  const verdictColors: Record<string, string> = {
    Supported: '#1a7f37', Contradicted: '#d1242f', Misleading: '#c2570c',
    Mixed: '#9a6700', 'Insufficient Evidence': '#6e6e73'
  };
  const riskColors: Record<string, string> = {
    low: '#1a7f37', moderate: '#c2570c', high: '#d1242f', critical: '#82071e'
  };

  return (
    <div>
      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Total Cases Processed</span>
          <div className="kpi-num">{stats?.total ?? '—'}</div>
          <span className="kpi-sub">Cross-modal investigations</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Synthetic Threat Rate</span>
          <div className="kpi-num threat-rate">{stats ? `${stats.threatRate}%` : '—'}</div>
          <span className="kpi-sub">High/Critical deepfake risk</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Verified Claims</span>
          <div className="kpi-num" style={{ color: '#1a7f37' }}>{stats?.byVerdict?.Supported ?? 0}</div>
          <span className="kpi-sub">Corroborated by primary sources</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Contradicted / Debunked</span>
          <div className="kpi-num" style={{ color: '#d1242f' }}>{stats?.byVerdict?.Contradicted ?? 0}</div>
          <span className="kpi-sub">Disproven or false assertions</span>
        </div>
      </div>

      {/* Threat Alert */}
      {stats && stats.recent.filter(r => r.syntheticMedia?.risk === 'high' || r.syntheticMedia?.risk === 'critical').length > 0 && (
        <div className="alert-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#d1242f' }}><Ic n="alert" s={22} /></span>
            <div>
              <b>Critical Synthetic Media Detected</b>
              <div className="mu small">Recent cases flagged with high deepfake or voice cloning probability</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {stats.recent.filter(r => r.syntheticMedia?.risk === 'high' || r.syntheticMedia?.risk === 'critical').slice(0, 3).map(r => (
              <button key={r.id} className="btn sm" onClick={() => onOpenReport(r.id)}>
                <MediaBadge type={r.mediaType} /> {r.title?.slice(0, 24)}…
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Analytics Charts */}
      {stats && stats.total > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, margin: '24px 0' }}>
          {/* Verdict Distribution */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Ic n="bar" s={18} />
              <b style={{ fontSize: 14 }}>Verdict Distribution</b>
            </div>
            <BarChart data={stats.byVerdict} colors={verdictColors} />
          </div>

          {/* Risk Levels */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Ic n="shield" s={18} />
              <b style={{ fontSize: 14 }}>Synthetic Media Risk Levels</b>
            </div>
            <BarChart data={stats.byRisk} colors={riskColors} />
          </div>

          {/* Media Type Rings */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Ic n="pie" s={18} />
              <b style={{ fontSize: 14 }}>Analysis by Media Type</b>
            </div>
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap', paddingTop: 8 }}>
              <RingMetric
                value={stats.total ? Math.round((stats.byType.video / stats.total) * 100) : 0}
                label="Video"
                color="#0071e3"
              />
              <RingMetric
                value={stats.total ? Math.round((stats.byType.audio / stats.total) * 100) : 0}
                label="Audio"
                color="#c2570c"
              />
              <RingMetric
                value={stats.total ? Math.round((stats.byType.article / stats.total) * 100) : 0}
                label="Article"
                color="#6b21a8"
              />
            </div>
          </div>

          {/* Threat Rate Gauge */}
          <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Ic n="trend" s={18} />
              <b style={{ fontSize: 14 }}>Overall Threat Index</b>
            </div>
            <RingMetric value={stats.threatRate} label="High/Critical Synthetic Risk" color="#d1242f" />
            <p className="mu small" style={{ margin: 0, textAlign: 'center' }}>
              {stats.threatRate > 20 ? '⚠ Elevated threat level across recent cases' : 'Threat level within normal range'}
            </p>
          </div>
        </div>
      )}

      {/* Quick Launch Studios */}
      <h3 style={{ fontSize: 16, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--mu)', margin: '24px 0 12px' }}>
        Forensic Investigation Studios
      </h3>
      <div className="action-grid">
        <div className="action-card" onClick={() => onSwitchTab('video')}>
          <b><Ic n="play" s={20} /> Video Forensic Lab</b>
          <p>Analyze viral clips, YouTube links, face-swaps, on-screen chyrons, and spoken claims.</p>
          <span className="small" style={{ color: 'var(--blue)', fontWeight: 600 }}>Launch Video Studio →</span>
        </div>
        <div className="action-card" onClick={() => onSwitchTab('article')}>
          <b><Ic n="article" s={20} /> Article &amp; AI Text Lab</b>
          <p>Inspect articles for generative AI authorship, clickbait sensationalism, and quote integrity.</p>
          <span className="small" style={{ color: 'var(--blue)', fontWeight: 600 }}>Launch Article Studio →</span>
        </div>
      </div>
    </div>
  );
}

export default Overview;
