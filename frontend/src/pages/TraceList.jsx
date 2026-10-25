// Feature 8: filterable trace list. All filters live in the URL (?service=&status=&range=&minMs=&sort=&page=).
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtMs, fmtDateTime, fmtNum } from '../lib/format.js';
import { traceLink } from '../lib/links.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { usePolling } from '../hooks/usePolling.js';
import { EmptyState, ErrorState, ServiceDot, ServiceSelect, SkeletonRows, StatusBadge, TimeRangeSelect, rangeMinutes } from '../components/ui.jsx';

const PAGE = 50;

export default function TraceList() {
  const nav = useNavigate();
  const [service, setService] = useUrlState('service', '');
  const [status, setStatus] = useUrlState('status', '');
  const [range, setRange] = useUrlState('range', '1h');
  const [minMs, setMinMs] = useUrlState('minMs', '');
  const [sort, setSort] = useUrlState('sort', 'recent');
  const [page, setPage] = useUrlState('page', '0');
  const pageNo = Math.max(0, Number(page) || 0);

  const { data, error, loading } = usePolling(async (signal) => {
    const p = new URLSearchParams({ limit: PAGE, offset: pageNo * PAGE, from: Date.now() - rangeMinutes(range) * 60_000 });
    if (service) p.set('service', service);
    if (status) p.set('status', status);
    if (minMs) p.set('minDurationMs', minMs);
    if (sort === 'duration') p.set('sort', 'duration');
    return api(`/api/traces?${p}`, { signal });
  }, 10_000, [service, status, range, minMs, sort, pageNo]);

  // any filter change goes back to page 1
  const filter = (set) => (v) => { set(v); setPage('0'); };
  const traces = data?.traces ?? [];
  const maxDur = Math.max(1, ...traces.map((t) => t.durationMs));

  return (
    <div>
      <div className="toolbar">
        <h2>Traces</h2>
        <ServiceSelect value={service} onChange={filter(setService)} />
        <select className="input" value={status} onChange={(e) => filter(setStatus)(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="2xx">2xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
          <option value="error">Has an error span</option>
        </select>
        <select className="input" value={minMs} onChange={(e) => filter(setMinMs)(e.target.value)} aria-label="Min duration">
          <option value="">Any duration</option>
          <option value="100">&gt; 100 ms</option>
          <option value="500">&gt; 500 ms</option>
          <option value="1000">&gt; 1 s</option>
          <option value="2000">&gt; 2 s</option>
        </select>
        <TimeRangeSelect value={range} onChange={filter(setRange)} />
        <select className="input" value={sort} onChange={(e) => filter(setSort)(e.target.value)} aria-label="Sort">
          <option value="recent">Newest first</option>
          <option value="duration">Slowest first</option>
        </select>
        <span className="muted">{data ? `${fmtNum(data.total)} traces` : ''}</span>
      </div>

      {error && !data && <ErrorState error={error} />}
      {loading && !data && <SkeletonRows rows={8} />}
      {data && traces.length === 0 && <EmptyState title="No traces match these filters" hint="Try a longer time range, or start the load generator." />}
      {traces.length > 0 && (
        <table className="table clickable">
          <thead>
            <tr><th>Time</th><th>Root request</th><th>Services</th><th className="dur-col">Duration</th><th>Status</th><th>Spans</th><th>Trace ID</th></tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.traceId} onClick={() => nav(traceLink(t.traceId))} className={t.hasError ? 'row-error' : ''}>
                <td className="nowrap">{fmtDateTime(t.startMs)}</td>
                <td>{t.rootName}</td>
                <td className="nowrap">{t.services.map((s) => <span key={s} className="svc"><ServiceDot name={s} />{s}</span>)}</td>
                <td className="dur-col">
                  <div className="durbar"><i style={{ width: `${Math.max(2, (t.durationMs / maxDur) * 100)}%` }} /></div>
                  <span>{fmtMs(t.durationMs)}</span>
                </td>
                <td><StatusBadge status={t.httpStatus} />{t.hasError && t.httpStatus < 500 && <span className="badge red" title={`${t.errorSpans} span(s) failed`}>err</span>}</td>
                <td>{t.spanCount}</td>
                <td className="mono"><Link to={traceLink(t.traceId)} onClick={(e) => e.stopPropagation()}>{t.traceId.slice(0, 12)}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total > PAGE && (
        <div className="pager">
          <button className="btn" disabled={pageNo === 0} onClick={() => setPage(String(pageNo - 1))}>Previous</button>
          <span className="muted">Page {pageNo + 1} of {Math.ceil(data.total / PAGE)}</span>
          <button className="btn" disabled={(pageNo + 1) * PAGE >= data.total} onClick={() => setPage(String(pageNo + 1))}>Next</button>
        </div>
      )}
    </div>
  );
}
