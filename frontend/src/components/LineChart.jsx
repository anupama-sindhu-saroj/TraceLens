import { useState } from 'react';

// Dependency-free SVG line chart. points: [{ t, <key>: number|null }]; series: [{ key, label, color }].
// null values leave a gap. format(v) renders axis/tooltip numbers.
export default function LineChart({ points, series, format = (v) => String(v), height = 180 }) {
  const [hover, setHover] = useState(null);
  const W = 600; const H = height; const L = 48; const R = 8; const T = 8; const B = 22;
  if (!points || points.length < 2) return <div className="empty">No data in this range</div>;

  const values = points.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v !== null && v !== undefined);
  const max = Math.max(1e-9, ...values) * 1.1;
  const t0 = points[0].t; const t1 = points[points.length - 1].t;
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => T + (1 - v / max) * (H - T - B);

  const paths = series.map((s) => {
    let d = ''; let pen = false;
    for (const p of points) {
      const v = p[s.key];
      if (v === null || v === undefined) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return { ...s, d };
  });
  const ticks = [0, 0.5, 1].map((f) => f * max / 1.1);
  const timeLabel = (t) => new Date(t).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - L) / (W - L - R)) * (t1 - t0);
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i; });
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="chart">
      <div className="legend">
        {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
        {hp && (
          <span className="hover-readout">
            {timeLabel(hp.t)} - {series.map((s) => `${s.label}: ${hp[s.key] === null || hp[s.key] === undefined ? '-' : format(hp[s.key])}`).join(', ')}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#262a33" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#7d8696">{format(v)}</text>
          </g>
        ))}
        <text x={L} y={H - 6} fontSize="10" fill="#7d8696">{timeLabel(t0)}</text>
        <text x={W - R} y={H - 6} fontSize="10" fill="#7d8696" textAnchor="end">{timeLabel(t1)}</text>
        {paths.map((s) => <path key={s.key} d={s.d} fill="none" stroke={s.color} strokeWidth="1.8" />)}
        {hp && <line x1={x(hp.t)} x2={x(hp.t)} y1={T} y2={H - B} stroke="#4a5160" strokeDasharray="3 3" />}
      </svg>
    </div>
  );
}
