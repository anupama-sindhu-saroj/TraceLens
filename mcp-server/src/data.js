'use strict';
// The real work of every tool, in one place. Each builder calls the REST API and returns BOTH
//   text  - what an AI reads (compact, aligned, with the ids needed for the next call)
//   data  - the same facts as plain JSON (structured output for scripts and other agents)
// Tools (tools.js) and resources (resources.js) are thin wrappers around these.
const F = require('./format');

const MAX_MINUTES = 7 * 24 * 60;

class ToolInputError extends Error {}

// "2026-10-23T11:55:00Z" or epoch milliseconds -> epoch milliseconds
function parseTime(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  const ms = /^\d{10,}$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(ms)) throw new ToolInputError(`${label} must be an ISO 8601 time such as 2026-10-23T11:55:00Z (got "${s}").`);
  return ms;
}

// Either an explicit from/to, or "the last N minutes".
function windowOf(args, defaultMinutes, now = Date.now()) {
  const from = parseTime(args.from, 'from');
  const to = parseTime(args.to, 'to');
  if (from !== null && to !== null && to <= from) throw new ToolInputError('to must be after from.');
  if (from !== null || to !== null) return { from, to, label: `${from !== null ? F.iso(from) : 'the beginning'} to ${to !== null ? F.iso(to) : 'now'}` };
  const minutes = args.minutes ?? defaultMinutes;
  return { from: now - minutes * 60_000, to: null, label: `the last ${minutes} minute${minutes === 1 ? '' : 's'}` };
}

const HEALTH_ORDER = { failing: 0, degraded: 1, healthy: 2, unknown: 3 };
const byHealth = (a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || String(a.service).localeCompare(String(b.service));

const unit = (metric, v) => (metric === 'error_rate' ? F.fmtPct(v) : F.fmtMs(v));

function anomalyData(a) {
  const d = a.details ?? {};
  return {
    id: a.id,
    severity: a.severity,
    service: a.service_name,
    metric: a.metric,
    baseline: a.baseline,
    current: a.current,
    ratio: a.ratio ?? null,
    rootCause: a.root_cause ?? null,
    detectedAtMs: a.detected_at_ms,
    badSpans: d.bad_spans ?? null,
    spansInWindow: d.spans_in_window ?? null,
    sampleTraceIds: d.related_trace_ids ?? [],
  };
}

function anomalyLine(a, now) {
  const d = a.details ?? {};
  const lines = [
    `${a.id}  [${a.severity}]  ${a.service_name} ${a.metric}: ${unit(a.metric, a.baseline)} -> ${unit(a.metric, a.current)} (${F.fmtRatio(a.ratio)} the baseline)  detected ${F.iso(a.detected_at_ms)} (${F.ago(a.detected_at_ms, now)})`,
    `    root cause: ${a.root_cause ?? 'unknown'}${d.bad_spans !== undefined ? `  |  ${d.bad_spans} bad of ${d.spans_in_window} requests in the window` : ''}`,
  ];
  const ids = d.related_trace_ids ?? [];
  if (ids.length) lines.push(`    sample traces: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` (+${ids.length - 3} more)` : ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------- service health
async function healthReport(api, { service, minutes = 15 } = {}) {
  const now = Date.now();
  const stats = await api.get('/api/stats/services', { minutes });
  let list = [...(stats.services ?? [])].sort(byHealth);
  const empty = { windowMinutes: minutes, services: [], needsAttention: [], anomalies: [] };
  if (service) {
    const known = list.map((s) => s.service);
    list = list.filter((s) => s.service === service);
    if (!list.length) return { text: `No traffic for "${service}" in the last ${minutes} minutes. Services with traffic: ${known.join(', ') || 'none'}.`, data: empty };
  }
  if (!list.length) return { text: `No service reported any requests in the last ${minutes} minutes. Is traffic flowing (npm run loadgen)?`, data: empty };

  const rows = list.map((s) => ({
    service: s.service,
    health: s.health.toUpperCase(),
    requests: F.fmtNum(s.requests),
    errors: `${F.fmtNum(s.errors)} (${F.fmtPct(s.errorRate)})`,
    avg: F.fmtMs(s.avgLatencyMs),
    p99: F.fmtMs(s.p99LatencyMs),
    seen: F.ago(s.lastSeenMs, now),
  }));
  const out = [`Service health, last ${minutes} minute${minutes === 1 ? '' : 's'} (server-side spans; only 5xx counts as an error):`, '',
    F.table(rows, [
      { key: 'service', label: 'SERVICE' }, { key: 'health', label: 'HEALTH' }, { key: 'requests', label: 'REQUESTS' },
      { key: 'errors', label: 'ERRORS' }, { key: 'avg', label: 'AVG' }, { key: 'p99', label: 'P99' }, { key: 'seen', label: 'LAST SEEN' },
    ])];

  const bad = list.filter((s) => s.health === 'failing' || s.health === 'degraded');
  out.push('');
  out.push(bad.length
    ? `Needs attention: ${bad.map((s) => `${s.service} (${s.health})`).join(', ')}.`
    : 'All services with traffic look healthy.');

  // Recent alarms, so the agent sees the detector's verdict next to the numbers. Best effort: health still works without it.
  let anomalies = [];
  try {
    const recent = await api.get('/api/anomalies', { from: now - 30 * 60_000, limit: 20, service });
    const names = new Set(list.map((s) => s.service));
    const rel = (recent.anomalies ?? []).filter((a) => names.has(a.service_name));
    if (rel.length) {
      out.push('', 'Anomalies in the last 30 minutes (use explain_anomaly with an id):');
      for (const a of rel.slice(0, 5)) out.push(anomalyLine(a, now));
    }
    anomalies = rel.slice(0, 5).map(anomalyData);
  } catch { /* ignore */ }

  return {
    text: out.join('\n'),
    data: {
      windowMinutes: minutes,
      services: list.map((s) => ({
        service: s.service, health: s.health, requests: s.requests, errors: s.errors, errorRate: s.errorRate,
        avgLatencyMs: s.avgLatencyMs ?? null, p99LatencyMs: s.p99LatencyMs ?? null, lastSeenMs: s.lastSeenMs ?? null,
      })),
      needsAttention: bad.map((s) => ({ service: s.service, health: s.health })),
      anomalies,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- anomalies
async function anomalyList(api, args = {}) {
  const now = Date.now();
  const win = windowOf(args, 60, now);
  const res = await api.get('/api/anomalies', {
    service: args.service, severity: args.severity, metric: args.metric, from: win.from ?? undefined, to: win.to ?? undefined, limit: args.limit ?? 20,
  });
  const list = res.anomalies ?? [];
  const window = { fromMs: win.from, toMs: win.to };
  if (!list.length) {
    return {
      text: `No anomalies in ${win.label}${args.service ? ` for ${args.service}` : ''}. `
        + 'The detector compares the last 2 minutes with the previous 30 and stays quiet when traffic is low, so a fresh fault can take 1 to 2 minutes to show up.',
      data: { window, count: 0, anomalies: [] },
    };
  }
  const critical = list.filter((a) => a.severity === 'CRITICAL').length;
  const causes = [...new Set(list.map((a) => a.root_cause).filter(Boolean))];
  return {
    text: [
      `${list.length} anomal${list.length === 1 ? 'y' : 'ies'} in ${win.label} (${critical} critical)${causes.length ? `; root cause: ${causes.join(', ')}` : ''}:`,
      '',
      ...list.map((a) => anomalyLine(a, now)),
    ].join('\n'),
    data: { window, count: list.length, anomalies: list.map(anomalyData) },
  };
}

async function anomalyExplain(api, anomalyId) {
  const now = Date.now();
  const id = encodeURIComponent(anomalyId);
  const [a, ex] = await Promise.all([api.get(`/api/anomalies/${id}`), api.get(`/api/anomalies/${id}/explain`)]);
  const w = a.details?.window;
  const out = [
    `Anomaly ${a.id}  [${a.severity}]`,
    `${a.service_name} ${a.metric}: ${unit(a.metric, a.baseline)} -> ${unit(a.metric, a.current)} (${F.fmtRatio(a.ratio)} the baseline), detected ${F.iso(a.detected_at_ms)} (${F.ago(a.detected_at_ms, now)})`,
    '',
    `Root cause: ${ex.rootCause ?? 'unknown'}${ex.rootCause && ex.rootCause !== a.service_name ? `  (the alarm was raised on ${a.service_name}, but the problem starts downstream)` : ''}`,
    `Method: ${ex.method === 'self-time' ? 'self-time (the span that spent the longest on its own work, not waiting for others)' : 'deepest error (the first span in the call chain that failed)'}; ${ex.tracesAnalyzed} trace${ex.tracesAnalyzed === 1 ? '' : 's'} analysed`,
    ex.summary,
  ];
  const votes = Object.entries(ex.votes ?? {}).sort((x, y) => y[1] - x[1]);
  if (votes.length) out.push(`Votes: ${votes.map(([s, n]) => `${s} ${n}/${ex.tracesAnalyzed}`).join(', ')}`);
  if ((ex.samples ?? []).length) {
    out.push('', 'Sample traces:');
    for (const s of ex.samples.slice(0, 5)) {
      out.push(`- ${s.traceId}: ${s.service} ${s.spanName} took ${F.fmtMs(s.spanDurationMs)}${s.selfMs !== null && s.selfMs !== undefined ? ` (${F.fmtMs(s.selfMs)} own time)` : ''} in a ${F.fmtMs(s.traceDurationMs)} trace`);
    }
  }
  const cor = {
    slowOperations: ex.correlation?.slowOperations ?? [],
    relatedAnomalies: ex.correlation?.relatedAnomalies ?? [],
    latencyWithErrors: Boolean(ex.correlation?.latencyWithErrors),
    summary: ex.correlation?.summary ?? '',
  };
  if (cor.summary) out.push('', `Correlation: ${cor.summary}`);
  if (cor.slowOperations.length) {
    out.push('', 'Operations whose p99 spiked in this window (vs the 30 min baseline):');
    for (const o of cor.slowOperations) {
      out.push(`- ${o.service} ${o.operation}${o.kind ? ` [${o.kind}]` : ''}: p99 ${F.fmtMs(o.baselineP99Ms)} -> ${F.fmtMs(o.currentP99Ms)} (${o.ratio}x), ${o.spans} spans, ${o.errors} failed${o.inRootCause ? '  <-- root-cause service' : ''}`);
    }
  }
  if (cor.relatedAnomalies.length) {
    out.push('', 'Other alarms within 5 minutes:');
    for (const r of cor.relatedAnomalies) {
      const off = Math.abs(r.offsetSec) < 5 ? 'same time' : `${Math.abs(r.offsetSec)} s ${r.offsetSec < 0 ? 'earlier' : 'later'}`;
      out.push(`- ${r.id}: ${r.service} ${r.metric} [${r.severity}]${r.ratio ? ` ${F.fmtRatio(r.ratio)}` : ''}, ${off} - ${r.relation === 'same-cause' ? 'same root cause' : r.relation === 'call-path' ? 'on the call path of the sample traces' : 'only close in time'}`);
    }
  }
  out.push('', 'Next: get_trace with one of the trace ids above to see the full call tree, or search_logs'
    + ` with service="${ex.rootCause ?? a.service_name}" level=["ERROR","WARN"]${w ? ` from="${F.iso(w.from_ms)}"` : ''} to read what that service logged.`);
  return {
    text: out.join('\n'),
    data: {
      ...anomalyData(a),
      rootCause: ex.rootCause ?? null,
      method: ex.method,
      tracesAnalyzed: ex.tracesAnalyzed,
      votes: ex.votes ?? {},
      summary: ex.summary,
      correlation: cor,
      samples: (ex.samples ?? []).map((s) => ({
        traceId: s.traceId, service: s.service, spanId: s.spanId, spanName: s.spanName,
        spanDurationMs: s.spanDurationMs, selfMs: s.selfMs ?? null, traceDurationMs: s.traceDurationMs,
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------- traces
async function traceSearch(api, args = {}) {
  const now = Date.now();
  const win = windowOf(args, 15, now);
  const res = await api.get('/api/traces', {
    service: args.service, status: args.status, minDurationMs: args.min_duration_ms, q: args.query,
    sort: args.sort === 'slowest' ? 'duration' : undefined, from: win.from ?? undefined, to: win.to ?? undefined, limit: args.limit ?? 10,
  });
  const list = res.traces ?? [];
  const total = res.total ?? list.length;
  if (!list.length) return { text: `No traces matched in ${win.label}. Try a longer time range or fewer filters.`, data: { total: 0, returned: 0, traces: [] } };
  const rows = list.map((t) => ({
    id: t.traceId,
    start: F.ago(t.startMs, now),
    dur: F.fmtMs(t.durationMs),
    root: `${t.rootService} ${t.rootName}`,
    status: t.httpStatus ?? '-',
    spans: t.spanCount,
    err: t.errorSpans,
    services: t.services.join(','),
  }));
  return {
    text: [
      `${list.length} of ${F.fmtNum(total)} matching traces in ${win.label}, ${args.sort === 'slowest' ? 'slowest first' : 'newest first'}:`,
      '',
      F.table(rows, [
        { key: 'id', label: 'TRACE ID' }, { key: 'start', label: 'STARTED' }, { key: 'dur', label: 'DURATION' }, { key: 'root', label: 'ROOT REQUEST' },
        { key: 'status', label: 'HTTP' }, { key: 'spans', label: 'SPANS' }, { key: 'err', label: 'ERR' }, { key: 'services', label: 'SERVICES' },
      ]),
      '',
      'Use get_trace with a TRACE ID to see the call tree.',
    ].join('\n'),
    data: {
      total,
      returned: list.length,
      traces: list.map((t) => ({
        traceId: t.traceId, startMs: t.startMs, durationMs: t.durationMs, rootService: t.rootService, rootName: t.rootName,
        httpStatus: t.httpStatus ?? null, spanCount: t.spanCount, errorSpans: t.errorSpans, services: t.services,
      })),
    },
  };
}

async function traceDetail(api, { traceId, includeLogs = true, maxSpans = 80, maxLogs = 30 } = {}) {
  const id = encodeURIComponent(traceId);
  const [trace, logs] = await Promise.all([
    api.get(`/api/traces/${id}`),
    includeLogs ? api.get('/api/logs', { traceId, order: 'asc', limit: 500 }) : Promise.resolve(null),
  ]);
  const info = F.analyzeTrace(trace);
  const spans = [...trace.spans].sort((a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId));
  const shown = spans.slice(0, maxSpans);
  const pickedLogs = logs ? F.pickLogs(logs.logs ?? [], maxLogs) : null;
  return {
    text: F.renderTrace(trace, logs, { maxSpans, maxLogs }),
    data: {
      traceId: trace.traceId,
      startMs: trace.startMs,
      durationMs: trace.durationMs,
      spanCount: trace.spanCount,
      errorSpans: trace.errorSpans,
      services: trace.services,
      logCount: trace.logCount,
      truncated: shown.length < spans.length,
      bottleneck: info.flagged.size && info.topGroup
        ? { service: info.topGroup.service, name: info.topGroup.name, spans: info.topGroup.spans.length, totalOwnMs: Math.round(info.topGroup.total * 10) / 10 }
        : null,
      spans: shown.map((s) => ({
        spanId: s.spanId,
        parentSpanId: s.parentSpanId ?? null,
        service: s.serviceName,
        name: s.name,
        kind: s.kind ?? null,
        startMs: s.startMs,
        offsetMs: s.offsetMs,
        durationMs: s.durationMs,
        ownMs: Math.round((info.self.get(s.spanId) ?? 0) * 10) / 10,
        httpStatus: s.httpStatus ?? null,
        statusCode: s.statusCode ?? null,
        error: F.isErrorSpan(s),
        attributes: s.attributes ?? {},
      })),
      logs: (pickedLogs ?? []).map(logData),
    },
  };
}

// ---------------------------------------------------------------------------------------------------- logs
function logData(l) {
  return {
    timeMs: l.time_ms, service: l.service_name, level: l.level, message: l.message,
    traceId: l.trace_id ?? null, spanId: l.span_id ?? null, attributes: l.attributes ?? {},
  };
}

async function logSearch(api, args = {}) {
  const now = Date.now();
  // A trace or span id already pins the logs down; do not hide them behind the default 15 minute window.
  const pinned = args.trace_id || args.span_id;
  const win = (pinned && args.from === undefined && args.to === undefined && args.minutes === undefined)
    ? { from: null, to: null, label: 'all stored time' }
    : windowOf(args, 15, now);
  const res = await api.get('/api/logs', {
    q: args.query, regex: args.regex ? 1 : undefined, service: args.service,
    level: args.level && args.level.length ? args.level.join(',') : undefined,
    traceId: args.trace_id, spanId: args.span_id,
    tags: args.tags && args.tags.length ? JSON.stringify(args.tags) : undefined,
    from: win.from ?? undefined, to: win.to ?? undefined, limit: args.limit ?? 50, order: args.order,
  });
  const logs = res.logs ?? [];
  const window = { fromMs: win.from, toMs: win.to };
  if (!logs.length) {
    return {
      text: `No logs matched in ${win.label}. Try a longer range or fewer filters${args.regex ? '' : ' (set regex=true for pattern matching)'}.`,
      data: { count: 0, hasMore: false, window, levels: {}, logs: [] },
    };
  }
  const levels = {};
  for (const l of logs) levels[l.level] = (levels[l.level] ?? 0) + 1;
  const mix = Object.entries(levels).map(([k, v]) => `${v} ${k}`).join(', ');
  return {
    text: [
      `${logs.length} log${logs.length === 1 ? '' : 's'} in ${win.label}${res.hasMore ? ' (more exist: narrow the filters or raise limit)' : ''} - ${mix}; ${args.order === 'asc' ? 'oldest' : 'newest'} first:`,
      '',
      ...logs.map((l) => F.logLine(l, { withTrace: true })),
    ].join('\n'),
    data: { count: logs.length, hasMore: !!res.hasMore, window, levels, logs: logs.map(logData) },
  };
}

// ---------------------------------------------------------------------------------------------------- topology
async function topologyReport(api, { minutes = 15 } = {}) {
  const now = Date.now();
  const topo = await api.get('/api/topology', { minutes });
  const nodes = [...(topo.nodes ?? [])].sort(byHealth);
  const edges = [...(topo.edges ?? [])];
  if (!nodes.length) return { text: `No services have reported traffic in the last ${minutes} minutes.`, data: { windowMinutes: minutes, nodes: [], edges: [], unhealthy: [] } };

  const out = [`Service topology, last ${minutes} minute${minutes === 1 ? '' : 's'}:`, '', 'Services:'];
  for (const n of nodes) {
    out.push(`- ${n.service} [${n.health.toUpperCase()}]${n.entry ? ' (entry point)' : ''}: ${F.fmtNum(n.requests)} requests (${n.rps.toFixed(1)}/s), errors ${F.fmtPct(n.errorRate)}, p50 ${F.fmtMs(n.p50Ms)}, p95 ${F.fmtMs(n.p95Ms)}, p99 ${F.fmtMs(n.p99Ms)}, last seen ${F.ago(n.lastSeenMs, now)}`);
  }
  out.push('', 'Calls (caller -> callee):');
  if (!edges.length) out.push('- none observed');
  const sortedEdges = [...edges].sort((a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || b.calls - a.calls);
  for (const e of sortedEdges) {
    out.push(`- ${e.source} -> ${e.target} [${String(e.health).toUpperCase()}]: ${F.fmtNum(e.calls)} calls (${e.rps.toFixed(1)}/s), errors ${F.fmtPct(e.errorRate)}, p95 ${F.fmtMs(e.p95Ms)}, p99 ${F.fmtMs(e.p99Ms)}`);
  }
  const sick = nodes.filter((n) => n.health === 'failing' || n.health === 'degraded');
  const callers = [...new Set(edges.filter((e) => sick.some((n) => n.service === e.target)).map((e) => e.source))];
  out.push('');
  if (sick.length) {
    out.push(`Unhealthy: ${sick.map((n) => `${n.service} (${n.health})`).join(', ')}.${callers.length ? ` Callers that may be affected: ${callers.join(', ')}.` : ''}`);
  } else out.push('All services look healthy.');
  out.push('Note: a call that never reaches its target produces no edge, because edges are built from spans on both sides.');

  const node = (n) => ({
    service: n.service, health: n.health, entry: !!n.entry, requests: n.requests, rps: n.rps, errors: n.errors, errorRate: n.errorRate,
    avgMs: n.avgMs ?? null, p50Ms: n.p50Ms ?? null, p95Ms: n.p95Ms ?? null, p99Ms: n.p99Ms ?? null, lastSeenMs: n.lastSeenMs ?? null,
  });
  const edge = (e) => ({
    source: e.source, target: e.target, health: e.health, calls: e.calls, rps: e.rps, errors: e.errors, errorRate: e.errorRate,
    avgMs: e.avgMs ?? null, p50Ms: e.p50Ms ?? null, p95Ms: e.p95Ms ?? null, p99Ms: e.p99Ms ?? null,
  });
  return {
    text: out.join('\n'),
    data: {
      windowMinutes: minutes,
      nodes: nodes.map(node),
      edges: sortedEdges.map(edge),
      unhealthy: sick.map((n) => ({ service: n.service, health: n.health, affectedCallers: [...new Set(edges.filter((e) => e.target === n.service).map((e) => e.source))] })),
    },
  };
}

module.exports = {
  MAX_MINUTES, ToolInputError, parseTime, windowOf,
  healthReport, anomalyList, anomalyExplain, traceSearch, traceDetail, logSearch, topologyReport,
};