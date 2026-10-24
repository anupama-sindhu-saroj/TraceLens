// The severity timeline above the log table (like the Cloud Logging histogram). Bars are stacked by severity;
// click a bar to zoom into that time slice. Plain HTML bars, no chart library.
import { useState } from 'react';
import { LEVELS, LEVEL_COLORS } from '../lib/logQuery.js';

const STACK = ['DEBUG', 'INFO', 'WARN', 'ERROR']; // ERROR on top

function label(ms, spanMs) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return spanMs > 24 * 3600_000 ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}` : time;
}

export default function LogHistogram({ data, onZoom }) {
  const [hover, setHover] = useState(null);
  if (!data) return <div className="lg-hist lg-hist-empty" />;
  const { buckets, bucketMs, from, to } = data;
  const max = Math.max(1, ...buckets.map((b) => LEVELS.reduce((a, l) => a + b[l], 0)));
  const spanMs = to - from;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * spanMs);
  const hb = hover === null ? null : buckets[hover];
  const total = (b) => LEVELS.reduce((a, l) => a + b[l], 0);

  return (
    <div className="lg-hist">
      <div className="lg-hist-head">
        <span className="muted small">{data.total.toLocaleString()} logs</span>
        <span className="lg-legend">
          {LEVELS.map((l) => <span key={l}><i style={{ background: LEVEL_COLORS[l] }} />{l.toLowerCase()}</span>)}
        </span>
        <span className="hover-readout small mono">
          {hb ? `${label(hb.t, spanMs)} · ${total(hb)} logs${hb.ERROR ? ` · ${hb.ERROR} error` : ''}${hb.WARN ? ` · ${hb.WARN} warn` : ''}` : 'click a bar to zoom in'}
        </span>
      </div>
      <div className="lg-bars" onMouseLeave={() => setHover(null)}>
        {buckets.map((b, i) => {
          const t = total(b);
          return (
            <div key={b.t} className={`lg-col${hover === i ? ' on' : ''}`} onMouseEnter={() => setHover(i)}
              onClick={() => t > 0 && onZoom(b.t, b.t + bucketMs)} role="button" aria-label={`${t} logs at ${label(b.t, spanMs)}`}>
              <div className="lg-stack" style={{ height: `${(t / max) * 100}%` }}>
                {STACK.map((l) => b[l] > 0 && <div key={l} style={{ flex: b[l], background: LEVEL_COLORS[l] }} />)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="lg-axis small muted">
        {ticks.map((t, i) => <span key={i}>{label(t, spanMs)}</span>)}
      </div>
    </div>
  );
}
