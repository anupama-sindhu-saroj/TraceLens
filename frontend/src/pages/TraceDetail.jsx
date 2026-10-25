// Feature 9 + 10 + 13: waterfall for one trace, with the Span Panel. ?span=<id> highlights and opens a span
// (this is what B's "View trace" button on the Log Explorer links to, see lib/links.js).
import { useCallback, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtMs } from '../lib/format.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { usePolling } from '../hooks/usePolling.js';
import { EmptyState, ErrorState, ServiceDot, SkeletonRows } from '../components/ui.jsx';
import Flamegraph from '../components/Flamegraph.jsx';
import SpanPanel from '../components/SpanPanel.jsx';

export default function TraceDetail() {
  const { traceId } = useParams();
  const [spanId, setSpanId] = useUrlState('span', '');
  const { data: trace, error, loading } = usePolling((signal) => api(`/api/traces/${encodeURIComponent(traceId)}`, { signal }), 0, [traceId]);

  const selected = trace?.spans.find((s) => s.spanId === spanId) ?? null;
  const close = useCallback(() => setSpanId(''), [setSpanId]);

  // Coming from a log ("View trace"): scroll the highlighted span into view once the trace has loaded.
  useEffect(() => {
    if (!trace || !spanId) return;
    document.querySelector(`[data-span-id="${CSS.escape(spanId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [trace, spanId]);

  if (loading) return <SkeletonRows rows={8} />;
  if (error?.status === 404) return <EmptyState title="Trace not found" hint="It may be older than the retained data, or not ingested yet." />;
  if (error) return <ErrorState error={error} />;

  return (
    <div>
      <div className="toolbar">
        <Link to="/traces" className="btn">&larr; All traces</Link>
        <h2>Trace <span className="mono">{trace.traceId.slice(0, 12)}</span></h2>
      </div>
      <div className="summary">
        <div><span className="muted">Started</span> {fmtDateTime(trace.startMs)}</div>
        <div><span className="muted">Duration</span> {fmtMs(trace.durationMs)}</div>
        <div><span className="muted">Spans</span> {trace.spanCount}</div>
        <div><span className="muted">Errors</span> <span className={trace.errorSpans ? 'bad' : ''}>{trace.errorSpans}</span></div>
        <div><span className="muted">Logs</span> {trace.logCount}</div>
        <div>{trace.services.map((s) => <span key={s} className="svc"><ServiceDot name={s} />{s}</span>)}</div>
      </div>
      {spanId && !selected && <div className="notice">Span <span className="mono">{spanId}</span> is not part of this trace.</div>}
      <div className={`split${selected ? ' open' : ''}`}>
        <Flamegraph spans={trace.spans} totalMs={trace.durationMs} selectedId={spanId} onSelect={setSpanId} />
        {selected && <SpanPanel span={selected} traceId={trace.traceId} onClose={close} />}
      </div>
    </div>
  );
}
