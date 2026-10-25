// Feature 15: Dashboard. Cards, 2 line charts, service health table, top 5 recent anomalies.
// Polls /api/stats/* every 5 s. Recent anomalies come from B's GET /api/anomalies (shown empty until it exists).
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ago, fmtMs, fmtNum, fmtPct } from '../lib/format.js';
import { useUrlState } from '../hooks/useUrlState.js';
import { usePolling } from '../hooks/usePolling.js';
import { EmptyState, ErrorState, HealthBadge, ServiceDot, Skeleton, TimeRangeSelect, rangeMinutes } from '../components/ui.jsx';
import LineChart from '../components/LineChart.jsx';

function Card({ label, value, tone, sub }) {
  return (
    <div className={`card ${tone ?? ''}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

// Accept B's rows in snake_case (DB columns) or camelCase.
function normalizeAnomaly(a) {
  return {
    id: a.id,
    service: a.service_name ?? a.service,
    metric: a.metric,
    baseline: a.baseline,
    current: a.current,
    ratio: a.ratio,
    severity: a.severity,
    rootCause: a.root_cause ?? a.rootCause,
    at: a.detected_at_ms ?? a.detectedAtMs,
  };
}
const fmtMetric = (a, v) => (a.metric === 'error_rate' ? fmtPct(v) : fmtMs(v));
const metricLabel = (m) => (m === 'error_rate' ? 'error rate' : 'p99');

export default function Dashboard() {
  const [range, setRange] = useUrlState('range', '15m');
  const minutes = rangeMinutes(range);

  const { data, error, loading } = usePolling(async (signal) => {
    const [overview, series, services] = await Promise.all([
      api(`/api/stats/overview?minutes=${minutes}`, { signal }),
      api(`/api/stats/timeseries?minutes=${minutes}`, { signal }),
      api(`/api/stats/services?minutes=${minutes}`, { signal }),
    ]);
    // B's endpoint: missing (404) or failing must not break the whole dashboard.
    let anomalies = null;
    try {
      const res = await api('/api/anomalies?limit=20', { signal });
      anomalies = (Array.isArray(res) ? res : (res.anomalies ?? [])).map(normalizeAnomaly)
        .sort((a, b) => b.at - a.at).slice(0, 5);
    } catch { /* anomalies stay null */ }
    return { overview, series, services, anomalies };
  }, 5000, [minutes]);

  const o = data?.overview;
  return (
    <div>
      <div className="toolbar">
        <h2>Dashboard</h2>
        <TimeRangeSelect value={range} onChange={setRange} />
        <span className="muted">refreshes every 5 s</span>
      </div>

      {error && !data && <ErrorState error={error} />}
      {loading && !data && <div className="cards">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} height={84} />)}</div>}

      {data && (
        <>
          <div className="cards">
            <Card label="Total requests" value={fmtNum(o.totalRequests)} sub={`last ${range}`} />
            <Card label="Error rate" value={fmtPct(o.errorRate)} tone={o.errorRate >= 0.1 ? 'red' : o.errorRate >= 0.03 ? 'amber' : ''} />
            <Card label="Avg latency" value={fmtMs(o.avgLatencyMs)} />
            <Card label="p99 latency" value={fmtMs(o.p99LatencyMs)} tone={o.p99LatencyMs >= 1000 ? 'red' : o.p99LatencyMs >= 500 ? 'amber' : ''} />
            <Card label="Active services" value={o.activeServices} sub="seen in last 5 min" />
          </div>

          <div className="charts">
            <div className="panel-box">
              <h3>Requests per {data.series.bucketSec}s</h3>
              <LineChart
                points={data.series.points}
                series={[{ key: 'requests', label: 'requests', color: '#4f8cff' }, { key: 'errors', label: 'errors', color: '#ef4444' }]}
                format={(v) => String(Math.round(v))}
              />
            </div>
            <div className="panel-box">
              <h3>Latency</h3>
              <LineChart
                points={data.series.points}
                series={[{ key: 'avgMs', label: 'avg', color: '#22c55e' }, { key: 'p99Ms', label: 'p99', color: '#f59e0b' }]}
                format={fmtMs}
              />
            </div>
          </div>

          <div className="charts">
            <div className="panel-box">
              <h3>Service health</h3>
              {data.services.services.length === 0
                ? <EmptyState title="No service data in this range" hint="Start the demo services and the load generator." />
                : (
                  <table className="table">
                    <thead><tr><th>Service</th><th>Status</th><th>Requests</th><th>Error rate</th><th>Avg</th><th>p99</th></tr></thead>
                    <tbody>
                      {data.services.services.map((s) => (
                        <tr key={s.service}>
                          <td><ServiceDot name={s.service} />{s.service}</td>
                          <td><HealthBadge health={s.health} /></td>
                          <td>{fmtNum(s.requests)}</td>
                          <td>{fmtPct(s.errorRate)}</td>
                          <td>{fmtMs(s.avgLatencyMs)}</td>
                          <td>{fmtMs(s.p99LatencyMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            <div className="panel-box">
              <h3>Recent anomalies <Link to="/anomalies" className="small">view all</Link></h3>
              {data.anomalies === null && <div className="muted">Anomalies API is not available yet.</div>}
              {data.anomalies?.length === 0 && <EmptyState title="No anomalies" hint="Everything looks normal." />}
              {data.anomalies?.map((a) => (
                <Link to="/anomalies" key={a.id} className={`anomaly ${a.severity === 'CRITICAL' ? 'red' : 'amber'}`}>
                  <div><span className={`badge ${a.severity === 'CRITICAL' ? 'red' : 'amber'}`}>{a.severity}</span> <strong>{a.service}</strong> <span className="muted">{ago(a.at)}</span></div>
                  <div>{metricLabel(a.metric)}: {fmtMetric(a, a.baseline)} to {fmtMetric(a, a.current)}{a.ratio ? ` (${a.ratio >= 10 ? Math.round(a.ratio) : a.ratio.toFixed(1)}x)` : ''}</div>
                  {a.rootCause && <div className="muted">Likely root cause: {a.rootCause}</div>}
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
