// Features 17 and 18: Anomalies page (owner: B). The detector's alarms, grouped into incidents with ONE root cause each,
// plus the evidence: why that service is blamed, the slow/failing traces, the logs and the node on the topology map.
//   /anomalies?range=24h&severity=CRITICAL&service=payment&open=<incident id>
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePolling } from '../hooks/usePolling.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { EmptyState, ErrorState, ServiceDot, SkeletonRows, ServiceSelect } from '../components/ui.jsx';
import { METRIC_LABEL, groupIncidents, logsLink, topologyLink } from '../lib/incidents.js';
import { traceLink } from '../lib/links.js';
import { ago, fmtDateTime, fmtMs, fmtNum, fmtPct, fmtTime } from '../lib/format.js';

const RANGES = [['1h', 60], ['6h', 360], ['24h', 1440], ['7d', 10080]];
const POLL_MS = 10_000;
const val = (metric, v) => (v === null || v === undefined ? '-' : metric === 'error_rate' ? fmtPct(v) : fmtMs(v));

const RELATION_LABEL = { 'same-cause': 'same root cause', 'call-path': 'on the call path', concurrent: 'only close in time' };
const offset = (s) => (Math.abs(s) < 5 ? 'same time' : `${Math.abs(s) >= 90 ? `${Math.round(Math.abs(s) / 60)} min` : `${Math.abs(s)} s`} ${s < 0 ? 'earlier' : 'later'}`);

// Which spans spiked, and which other alarms belong to the same incident (the "p99 spiked during an error cluster" part).
function Correlation({ c }) {
  if (!c) return null;
  const ops = c.slowOperations ?? [];
  const rel = c.relatedAnomalies ?? [];
  return (
    <div className="an-corr">
      <h4>Spans whose p99 spiked</h4>
      {c.summary && <p className="an-summary">{c.summary}</p>}
      {ops.length > 0 && (
        <table className="table compact an-samples">
          <thead><tr><th>Operation</th><th>Normal p99</th><th>Now</th><th>Change</th><th>Spans</th><th>Failed</th></tr></thead>
          <tbody>
            {ops.map((o) => (
              <tr key={`${o.service}|${o.operation}|${o.kind}`} className={o.inRootCause ? 'an-hot' : ''}>
                <td><ServiceDot name={o.service} />{o.service} <span className="muted small">{o.operation}{o.kind ? ` · ${o.kind.toLowerCase()}` : ''}</span></td>
                <td>{fmtMs(o.baselineP99Ms)}</td>
                <td>{fmtMs(o.currentP99Ms)}</td>
                <td><span className="an-ratio">{o.ratio}×</span></td>
                <td>{fmtNum(o.spans)}</td>
                <td>{o.errors > 0 ? <span className={o.errorRate >= 0.05 ? 'an-ratio' : 'muted'}>{fmtNum(o.errors)} ({fmtPct(o.errorRate)})</span> : <span className="muted">0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rel.length > 0 && (
        <>
          <h4>Other alarms around the same time</h4>
          <div className="an-rel">
            {rel.map((r) => (
              <div key={r.id} className="an-relrow">
                <ServiceDot name={r.service} />{r.service} {METRIC_LABEL[r.metric] ?? r.metric}
                <span className={`badge ${r.severity === 'CRITICAL' ? 'red' : 'amber'}`}>{r.severity}</span>
                <span className="muted small">{offset(r.offsetSec)} · {RELATION_LABEL[r.relation] ?? r.relation}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Why({ id }) {
  const { data, error, loading } = usePolling((signal) => api(`/api/anomalies/${encodeURIComponent(id)}/explain`, { signal }), 0, [id]);
  if (loading) return <div className="muted small">Working out why…</div>;
  if (error) return <div className="muted small">Could not load the explanation: {error.message}</div>;
  const names = Object.keys(data.votes);
  const max = Math.max(1, ...Object.values(data.votes));
  return (
    <div className="an-why">
      <p className="an-summary">{data.summary}</p>
      {names.length > 0 && (
        <div className="an-votes">
          {names.sort((a, b) => data.votes[b] - data.votes[a]).map((s) => (
            <div key={s} className="an-vote"><span className="an-vname"><ServiceDot name={s} />{s}</span>
              <span className="an-vbar"><i style={{ width: `${(data.votes[s] / max) * 100}%` }} /></span>
              <span className="muted small">{data.votes[s]} of {data.tracesAnalyzed} traces</span></div>
          ))}
        </div>
      )}
      {data.samples.length > 0 && (
        <table className="table compact an-samples">
          <thead><tr><th>Trace</th><th>Problem starts in</th><th>{data.method === 'self-time' ? 'Its own time' : 'Its duration'}</th><th>Whole trace</th></tr></thead>
          <tbody>
            {data.samples.slice(0, 5).map((x) => (
              <tr key={x.traceId}>
                <td><Link className="mono" to={traceLink(x.traceId, x.spanId)}>{x.traceId.slice(0, 10)}…</Link></td>
                <td><ServiceDot name={x.service} />{x.service} <span className="muted small">{x.spanName}</span></td>
                <td>{fmtMs(data.method === 'self-time' ? x.selfMs : x.spanDurationMs)}</td>
                <td>{fmtMs(x.traceDurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Correlation c={data.correlation} />
      <div className="muted small">Method: {data.method === 'self-time' ? 'the service with the most time spent on its own work (not waiting for others) wins the vote' : 'the deepest failing span, whose callees did not fail, wins the vote'}.</div>
    </div>
  );
}

function IncidentCard({ inc, open, onToggle }) {
  const crit = inc.severity === 'CRITICAL';
  return (
    <div className={`an-card ${crit ? 'red' : 'amber'}${open ? ' open' : ''}`}>
      <button className="an-head" onClick={onToggle} aria-expanded={open}>
        <span className={`badge ${crit ? 'red' : 'amber'}`}>{inc.severity}</span>
        <span className="an-title"><ServiceDot name={inc.rootCause} /><b>{inc.rootCause}</b> <span className="muted">is the root cause</span></span>
        <span className="an-meta muted small">
          {inc.alarms.length} alarm{inc.alarms.length === 1 ? '' : 's'}
          {inc.affected.length > 0 && <> · also affects {inc.affected.join(', ')}</>}
          {' · '}{ago(inc.endMs)}
        </span>
        <span className="an-caret">{open ? '▾' : '▸'}</span>
      </button>

      <div className="an-alarms">
        {inc.alarms.map((a) => (
          <span key={a.id} className="an-alarm">
            <ServiceDot name={a.service_name} />{a.service_name} {METRIC_LABEL[a.metric] ?? a.metric}: <b>{val(a.metric, a.baseline)}</b> → <b>{val(a.metric, a.current)}</b>
            {a.ratio ? <span className="an-ratio"> {a.ratio.toFixed(1)}×</span> : null}
            {a.service_name !== inc.rootCause && <span className="muted small"> (symptom)</span>}
          </span>
        ))}
      </div>

      {open && (
        <div className="an-body">
          <h4>Why {inc.rootCause}?</h4>
          <Why id={inc.primary.id} />

          <h4>Alarms</h4>
          <table className="table compact">
            <thead><tr><th>Detected</th><th>Service</th><th>Metric</th><th>Normal</th><th>Now</th><th>Change</th><th>Severity</th></tr></thead>
            <tbody>
              {inc.alarms.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap" title={fmtDateTime(a.detected_at_ms)}>{fmtTime(a.detected_at_ms)}</td>
                  <td><ServiceDot name={a.service_name} />{a.service_name}</td>
                  <td>{METRIC_LABEL[a.metric] ?? a.metric}</td>
                  <td>{val(a.metric, a.baseline)}</td>
                  <td>{val(a.metric, a.current)}</td>
                  <td>{a.ratio ? `${a.ratio.toFixed(1)}×` : '-'}</td>
                  <td><span className={`badge ${a.severity === 'CRITICAL' ? 'red' : 'amber'}`}>{a.severity}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">
            {fmtNum(inc.primary.details?.spans_in_window)} requests in the checked window, {fmtNum(inc.primary.details?.bad_spans)} of them bad. Compared with the 30 minutes before it.
          </div>

          <h4>Evidence</h4>
          <div className="an-links">
            <Link className="btn small" to={topologyLink(inc)}>Show {inc.rootCause} on the map</Link>
            <Link className="btn small" to={logsLink(inc)}>Warnings and errors from {inc.rootCause}</Link>
            <Link className="btn small" to={`/traces?service=${encodeURIComponent(inc.rootCause)}&minMs=500`}>Slow {inc.rootCause} traces</Link>
            {inc.traceIds.slice(0, 3).map((t, i) => <Link key={t} className="btn small mono" to={traceLink(t)}>Trace {i + 1}: {t.slice(0, 8)}…</Link>)}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Anomalies() {
  const [range, setRange] = useUrlState('range', '24h');
  const [severity, setSeverity] = useUrlState('severity', '');
  const [service, setService] = useUrlState('service', '');
  const [openId, setOpenId] = useUrlState('open', '');
  const minutes = (RANGES.find(([k]) => k === range) ?? RANGES[2])[1];

  const { data, error, loading } = usePolling(async (signal) => {
    const qs = new URLSearchParams({ limit: '500', from: String(Date.now() - minutes * 60_000) });
    if (severity) qs.set('severity', severity);
    const res = await api(`/api/anomalies?${qs}`, { signal });
    return res.anomalies ?? res;
  }, POLL_MS, [minutes, severity]);

  // The service filter matches the root cause or any service with an alarm, so "payment" also finds the gateway's symptom.
  const incidents = useMemo(() => {
    const all = groupIncidents(data ?? []);
    return service ? all.filter((i) => i.rootCause === service || i.alarms.some((a) => a.service_name === service)) : all;
  }, [data, service]);
  const critical = incidents.filter((i) => i.severity === 'CRITICAL').length;

  return (
    <div className="an">
      <div className="toolbar">
        <h2>Anomalies</h2>
        <select className="input" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          {RANGES.map(([k]) => <option key={k} value={k}>Last {k}</option>)}
        </select>
        <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="">Any severity</option>
          <option value="CRITICAL">Critical</option>
          <option value="WARNING">Warning</option>
        </select>
        <ServiceSelect value={service} onChange={setService} />
        {data && <span className="muted small an-count">{incidents.length} incident{incidents.length === 1 ? '' : 's'}{critical ? ` · ${critical} critical` : ''}</span>}
      </div>

      {error && !data && <ErrorState error={error} />}
      {loading && !data && <SkeletonRows rows={4} />}
      {data && incidents.length === 0 && (
        <EmptyState title={`No anomalies in the last ${range}`}
          hint="Everything looks normal. To see one, open Demo Controls (bottom right) and make a service slow or flaky; the detector reports it within a couple of minutes." />
      )}
      <div className="stack">
        {incidents.map((inc) => (
          <IncidentCard key={inc.id} inc={inc} open={openId === inc.id} onToggle={() => setOpenId(openId === inc.id ? '' : inc.id)} />
        ))}
      </div>
    </div>
  );
}
