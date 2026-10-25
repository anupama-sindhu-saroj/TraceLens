// Feature 10: side panel for the selected span: attributes, HTTP status and that span's logs.
// Logs come from B's API: GET /api/logs?traceId=&spanId=  (array of log rows, or { logs: [...] }).
import { useEffect } from 'react';
import { api } from '../lib/api.js';
import { fmtMs, fmtTime } from '../lib/format.js';
import { usePolling } from '../hooks/usePolling.js';
import { LevelBadge, ServiceDot, StatusBadge } from './ui.jsx';

function parseAttrs(a) {
  if (!a) return {};
  if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
  return a;
}

function SpanLogs({ traceId, spanId }) {
  const { data, error, loading } = usePolling(async (signal) => {
    const res = await api(`/api/logs?traceId=${encodeURIComponent(traceId)}&spanId=${encodeURIComponent(spanId)}&limit=100`, { signal });
    return Array.isArray(res) ? res : (res.logs ?? res.rows ?? []);
  }, 0, [traceId, spanId]);

  if (loading) return <div className="muted">Loading logs...</div>;
  if (error) {
    return <div className="muted">{error.status === 404 ? 'Logs API (/api/logs) is not available yet.' : `Could not load logs: ${error.message}`}</div>;
  }
  if (!data || data.length === 0) return <div className="muted">No logs for this span.</div>;
  return (
    <div className="stack">
      {data.map((l, i) => {
        const time = l.time_ms ?? l.timeMs ?? l.time;
        const attrs = parseAttrs(l.attributes);
        return (
          <div key={i} className="logline">
            <div><span className="muted mono">{time ? fmtTime(time) : ''}</span> <LevelBadge level={l.level} /></div>
            <div>{l.message}</div>
            {Object.keys(attrs).length > 0 && <div className="muted mono small">{Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join('  ')}</div>}
          </div>
        );
      })}
    </div>
  );
}

export default function SpanPanel({ span, traceId, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const attrs = Object.entries(parseAttrs(span.attributes)).sort(([a], [b]) => a.localeCompare(b));
  return (
    <aside className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{span.name}</div>
          <div className="muted"><ServiceDot name={span.serviceName} />{span.serviceName} - {span.kind ?? 'SPAN'}</div>
        </div>
        <button className="btn small" onClick={onClose} aria-label="Close panel">Close</button>
      </div>

      <dl className="kv">
        <dt>HTTP status</dt><dd><StatusBadge status={span.httpStatus} /></dd>
        <dt>Span status</dt><dd>{span.statusCode ?? 'UNSET'}</dd>
        <dt>Duration</dt><dd>{fmtMs(span.durationMs)}</dd>
        <dt>Starts at</dt><dd>+{fmtMs(span.offsetMs)} from trace start</dd>
        <dt>Span ID</dt><dd className="mono">{span.spanId}</dd>
        <dt>Parent</dt><dd className="mono">{span.parentSpanId ?? (span.missingParent ? 'missing (not received)' : 'none (root)')}</dd>
      </dl>

      <h4>Attributes</h4>
      {attrs.length === 0
        ? <div className="muted">No attributes.</div>
        : <table className="table compact"><tbody>{attrs.map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td className="mono wrap">{String(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>)}</tbody></table>}

      <h4>Logs for this span</h4>
      <SpanLogs traceId={traceId} spanId={span.spanId} />
    </aside>
  );
}
