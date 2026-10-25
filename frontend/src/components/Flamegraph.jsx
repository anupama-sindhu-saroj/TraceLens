// Feature 9: trace waterfall. Bar length = duration, indent = parent/child, color = HTTP status
// (green 2xx, amber 4xx, red 5xx). Click a row to select it (Span Panel opens), caret to collapse.
import { useMemo, useState } from 'react';
import { fmtMs } from '../lib/format.js';
import { serviceColor } from '../lib/serviceColor.js';

export function spanColor(s) {
  if (s.httpStatus >= 500) return '#ef4444';
  if (s.httpStatus >= 400) return '#f59e0b';
  if (s.httpStatus >= 100) return '#22c55e';
  if (s.statusCode === 'ERROR') return '#ef4444';
  return '#64748b'; // internal span without an HTTP status
}

function buildRows(spans, collapsed) {
  const children = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parentSpanId) {
      if (!children.has(s.parentSpanId)) children.set(s.parentSpanId, []);
      children.get(s.parentSpanId).push(s);
    } else roots.push(s);
  }
  const byStart = (a, b) => a.offsetMs - b.offsetMs;
  const rows = [];
  const seen = new Set();
  const walk = (s, depth) => {
    if (seen.has(s.spanId)) return; // malformed data: never loop
    seen.add(s.spanId);
    const kids = (children.get(s.spanId) ?? []).sort(byStart);
    rows.push({ span: s, depth, kids: kids.length });
    if (!collapsed.has(s.spanId)) kids.forEach((k) => walk(k, depth + 1));
  };
  roots.sort(byStart).forEach((r) => walk(r, 0));
  return rows;
}

export default function Flamegraph({ spans, totalMs, selectedId, onSelect }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const rows = useMemo(() => buildRows(spans, collapsed), [spans, collapsed]);
  const total = Math.max(totalMs, 0.001);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const toggle = (id) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const parents = spans.filter((s) => spans.some((c) => c.parentSpanId === s.spanId)).map((s) => s.spanId);

  return (
    <div className="flame">
      <div className="flame-head">
        <div className="flame-label">
          <button className="btn small" onClick={() => setCollapsed(new Set())}>Expand all</button>{' '}
          <button className="btn small" onClick={() => setCollapsed(new Set(parents))}>Collapse all</button>
        </div>
        <div className="flame-track axis">
          {ticks.map((f) => <span key={f} style={{ left: `${f * 100}%` }} className={f === 1 ? 'end' : ''}>{fmtMs(total * f)}</span>)}
        </div>
      </div>
      {rows.map(({ span: s, depth, kids }) => {
        const left = (s.offsetMs / total) * 100;
        const width = Math.max(0.4, (s.durationMs / total) * 100);
        const textInside = width > 18;
        const tip = `${s.serviceName}: ${s.name}\n${fmtMs(s.durationMs)} (starts +${fmtMs(s.offsetMs)})\n${s.httpStatus ? `HTTP ${s.httpStatus}` : `status ${s.statusCode ?? 'UNSET'}`}`;
        return (
          <div
            key={s.spanId}
            className={`flame-row${s.spanId === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(s.spanId)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s.spanId); }}
            role="button"
            tabIndex={0}
            data-span-id={s.spanId}
            title={tip}
          >
            <div className="flame-label" style={{ paddingLeft: 8 + depth * 14 }}>
              {kids > 0
                ? <span className="caret" onClick={(e) => { e.stopPropagation(); toggle(s.spanId); }}>{collapsed.has(s.spanId) ? '▸' : '▾'}</span>
                : <span className="caret" />}
              <i className="dot" style={{ background: serviceColor(s.serviceName) }} />
              <span className="flame-svc">{s.serviceName}</span>
              <span className="flame-name">{s.name}</span>
            </div>
            <div className="flame-track">
              <div className="bar" style={{ left: `${left}%`, width: `${width}%`, background: spanColor(s) }}>
                {textInside && <span className="bar-text">{fmtMs(s.durationMs)}</span>}
              </div>
              {!textInside && (
                <span className="bar-out" style={left > 80 ? { right: `${100 - left + 0.5}%` } : { left: `${left + width + 0.5}%` }}>{fmtMs(s.durationMs)}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
