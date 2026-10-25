// Shared UI pieces (plan: owner B, used by A's pages). A wrote the first versions because they were not in the
// repo yet; B may restyle/extend them, but keep the export names and props.
import { serviceColor } from '../lib/serviceColor.js';

export const TIME_RANGES = [
  ['5m', 5], ['15m', 15], ['1h', 60], ['6h', 360], ['24h', 1440],
];
export const rangeMinutes = (key) => (TIME_RANGES.find(([k]) => k === key) ?? TIME_RANGES[1])[1];

export function TimeRangeSelect({ value, onChange }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Time range">
      {TIME_RANGES.map(([k]) => <option key={k} value={k}>Last {k}</option>)}
    </select>
  );
}

export function ServiceSelect({ value, onChange, services = ['gateway', 'cart', 'inventory', 'payment'], allLabel = 'All services' }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Service">
      <option value="">{allLabel}</option>
      {services.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

export function ServiceDot({ name }) {
  return <span className="dot" style={{ background: serviceColor(name) }} />;
}

// HTTP status -> badge. 2xx green, 4xx amber, 5xx red.
export function statusTone(status) {
  if (status === null || status === undefined) return 'grey';
  if (status >= 500) return 'red';
  if (status >= 400) return 'amber';
  return 'green';
}
export function StatusBadge({ status }) {
  return <span className={`badge ${statusTone(status)}`}>{status ?? '-'}</span>;
}

const LEVEL_TONE = { DEBUG: 'grey', INFO: 'blue', WARN: 'amber', ERROR: 'red' };
export function LevelBadge({ level }) {
  return <span className={`badge ${LEVEL_TONE[level] ?? 'grey'}`}>{level}</span>;
}

// health: healthy | degraded | failing | unknown (from server/src/shared/health.js)
const HEALTH_TONE = { healthy: 'green', degraded: 'amber', failing: 'red', unknown: 'grey' };
export function HealthBadge({ health }) {
  return <span className={`badge ${HEALTH_TONE[health] ?? 'grey'}`}>{health}</span>;
}

export function EmptyState({ title = 'Nothing here yet', hint }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export function ErrorState({ error }) {
  return <div className="empty error">Could not load data: {String(error?.message ?? error)}</div>;
}

export function Skeleton({ height = 16, width = '100%' }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function SkeletonRows({ rows = 6 }) {
  return <div className="stack">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={28} />)}</div>;
}
