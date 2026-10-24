// Turns the detector's separate alarms into incidents (owner: B). Pure functions, unit tested.
// One real problem usually raises several alarms (payment p99, payment errors, gateway p99 as a side effect).
// Alarms that point at the same root cause and follow each other within GAP_MS belong to one incident.
export const GAP_MS = 10 * 60_000;
const RANK = { CRITICAL: 2, WARNING: 1 };
const PRE_MS = 2 * 60_000;   // logs link: start a little before the first alarm window
const POST_MS = 60_000;      // ... and end a little after the last one

export function groupIncidents(anomalies, gapMs = GAP_MS) {
  const byKey = new Map();
  for (const a of [...anomalies].sort((x, y) => x.detected_at_ms - y.detected_at_ms)) {
    const key = a.root_cause || a.service_name;
    const list = byKey.get(key) ?? [];
    const open = list[list.length - 1];
    if (open && a.detected_at_ms - open.endMs <= gapMs) { open.alarms.push(a); open.endMs = a.detected_at_ms; } else {
      list.push({ rootCause: key, startMs: a.detected_at_ms, endMs: a.detected_at_ms, alarms: [a] });
    }
    byKey.set(key, list);
  }
  const out = [];
  for (const list of byKey.values()) {
    for (const inc of list) {
      const services = [...new Set(inc.alarms.map((a) => a.service_name))];
      const ids = [];
      for (const a of inc.alarms) for (const t of a.details?.related_trace_ids ?? []) if (!ids.includes(t)) ids.push(t);
      const primary = inc.alarms.find((a) => a.service_name === inc.rootCause) ?? inc.alarms[0];
      out.push({
        ...inc,
        id: `${inc.rootCause}@${inc.startMs}`,
        severity: inc.alarms.reduce((s, a) => (RANK[a.severity] > RANK[s] ? a.severity : s), 'WARNING'),
        affected: services.filter((s) => s !== inc.rootCause),
        traceIds: ids.slice(0, 6),
        primary,
        window: {
          from: Math.min(...inc.alarms.map((a) => a.details?.window?.from_ms ?? a.detected_at_ms)),
          to: Math.max(...inc.alarms.map((a) => a.details?.window?.to_ms ?? a.detected_at_ms)),
        },
      });
    }
  }
  return out.sort((a, b) => b.endMs - a.endMs);
}

export const logsLink = (inc) => {
  const q = encodeURIComponent(`service:${inc.rootCause} level:WARN,ERROR`);
  return `/logs?q=${q}&from=${Math.floor(inc.window.from - PRE_MS)}&to=${Math.ceil(inc.window.to + POST_MS)}`;
};

// Smallest Topology range that still contains the incident, so its node has data on the map.
export function topologyRange(ageMs) {
  const m = ageMs / 60_000;
  if (m <= 1) return '1m';
  if (m <= 2) return '2m';
  if (m <= 5) return '5m';
  if (m <= 15) return '15m';
  if (m <= 60) return '1h';
  if (m <= 360) return '6h';
  return '24h';
}
export const topologyLink = (inc, now = Date.now()) => `/topology?range=${topologyRange(now - inc.startMs + 60_000)}&select=${encodeURIComponent(`node:${inc.rootCause}`)}`;

export const METRIC_LABEL = { p99_latency: 'p99 latency', error_rate: 'error rate' };
