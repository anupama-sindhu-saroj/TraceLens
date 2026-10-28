'use strict';
// The tools an AI agent can call. Every tool is read-only and answers with plain text that names the ids needed
// for the next call (trace ids, anomaly ids), so an agent can walk: health -> anomaly -> explanation -> trace -> logs.
const { z } = require('zod');
const { ApiError } = require('./client');
const F = require('./format');

const MAX_MINUTES = 7 * 24 * 60;

class ToolInputError extends Error {}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

// Wraps a handler so an unreachable API or a bad argument becomes a readable tool error, never a crashed server.
const safe = (fn) => async (args, extra) => {
  try {
    return await fn(args ?? {}, extra);
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status === 404 ? `Not found: ${e.message}` : e.message);
    if (e instanceof ToolInputError) return fail(e.message);
    return fail(`Unexpected error: ${e && e.message ? e.message : e}`);
  }
};

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

const minutesArg = (def) => z.number().int().min(1).max(MAX_MINUTES).default(def)
  .describe(`Look back this many minutes from now (default ${def}).`);
const fromArg = z.string().optional().describe('Start of an explicit time range, ISO 8601 (e.g. 2026-10-23T11:55:00Z). Overrides minutes.');
const toArg = z.string().optional().describe('End of an explicit time range, ISO 8601. Leave out for "now".');

const HEALTH_ORDER = { failing: 0, degraded: 1, healthy: 2, unknown: 3 };
const byHealth = (a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || String(a.service).localeCompare(String(b.service));

const unit = (metric, v) => (metric === 'error_rate' ? F.fmtPct(v) : F.fmtMs(v));

function anomalyLine(a, now) {
  const where = `${a.service_name} ${a.metric}`;
  const d = a.details ?? {};
  const lines = [
    `${a.id}  [${a.severity}]  ${where}: ${unit(a.metric, a.baseline)} -> ${unit(a.metric, a.current)} (${F.fmtRatio(a.ratio)} the baseline)  detected ${F.iso(a.detected_at_ms)} (${F.ago(a.detected_at_ms, now)})`,
    `    root cause: ${a.root_cause ?? 'unknown'}${d.bad_spans !== undefined ? `  |  ${d.bad_spans} bad of ${d.spans_in_window} requests in the window` : ''}`,
  ];
  const ids = d.related_trace_ids ?? [];
  if (ids.length) lines.push(`    sample traces: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` (+${ids.length - 3} more)` : ''}`);
  return lines.join('\n');
}

function registerTools(server, api) {
  // ------------------------------------------------------------------------------------------------ service health
  server.registerTool('get_service_health', {
    title: 'Service health',
    description:
      'Current health of every service (or one service): request count, error rate, average and p99 latency, and a health verdict '
      + '(healthy / degraded / failing / unknown), plus any anomalies raised for the unhealthy ones recently. '
      + 'Start here when asked "is everything OK?" or "what is wrong?".',
    inputSchema: {
      service: z.string().optional().describe('Only this service (gateway, cart, inventory, payment). Omit for all services.'),
      minutes: minutesArg(15),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ service, minutes = 15 }) => {
    const now = Date.now();
    const stats = await api.get('/api/stats/services', { minutes });
    let list = [...(stats.services ?? [])].sort(byHealth);
    if (service) {
      const known = list.map((s) => s.service);
      list = list.filter((s) => s.service === service);
      if (!list.length) {
        return text(`No traffic for "${service}" in the last ${minutes} minutes. Services with traffic: ${known.join(', ') || 'none'}.`);
      }
    }
    if (!list.length) return text(`No service reported any requests in the last ${minutes} minutes. Is traffic flowing (npm run loadgen)?`);

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
    try {
      const recent = await api.get('/api/anomalies', { from: now - 30 * 60_000, limit: 20, service });
      const names = new Set(list.map((s) => s.service));
      const rel = (recent.anomalies ?? []).filter((a) => names.has(a.service_name));
      if (rel.length) {
        out.push('', 'Anomalies in the last 30 minutes (use explain_anomaly with an id):');
        for (const a of rel.slice(0, 5)) out.push(anomalyLine(a, now));
      }
    } catch { /* ignore */ }
    return text(out.join('\n'));
  }));

  // ------------------------------------------------------------------------------------------------ anomalies
  server.registerTool('list_anomalies', {
    title: 'List anomalies',
    description:
      'Anomalies raised by the automatic detector (p99 latency spikes and error-rate spikes versus the service\'s own baseline), newest first. '
      + 'Each has a severity, how far it is from normal, the service that is the ROOT CAUSE (which can differ from the service that raised the alarm) '
      + 'and sample trace ids. Use explain_anomaly for the reasoning.',
    inputSchema: {
      service: z.string().optional().describe('Only alarms raised for this service.'),
      severity: z.enum(['WARNING', 'CRITICAL']).optional(),
      metric: z.enum(['p99_latency', 'error_rate']).optional(),
      minutes: minutesArg(60),
      from: fromArg,
      to: toArg,
      limit: z.number().int().min(1).max(100).default(20).describe('Maximum anomalies to return (default 20).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async (args) => {
    const now = Date.now();
    const win = windowOf(args, 60, now);
    const res = await api.get('/api/anomalies', {
      service: args.service, severity: args.severity, metric: args.metric, from: win.from ?? undefined, to: win.to ?? undefined, limit: args.limit ?? 20,
    });
    const list = res.anomalies ?? [];
    if (!list.length) {
      return text(`No anomalies in ${win.label}${args.service ? ` for ${args.service}` : ''}. `
        + 'The detector compares the last 2 minutes with the previous 30 and stays quiet when traffic is low, so a fresh fault can take 1 to 2 minutes to show up.');
    }
    const critical = list.filter((a) => a.severity === 'CRITICAL').length;
    const causes = [...new Set(list.map((a) => a.root_cause).filter(Boolean))];
    return text([
      `${list.length} anomal${list.length === 1 ? 'y' : 'ies'} in ${win.label} (${critical} critical)${causes.length ? `; root cause: ${causes.join(', ')}` : ''}:`,
      '',
      ...list.map((a) => anomalyLine(a, now)),
    ].join('\n'));
  }));

  server.registerTool('explain_anomaly', {
    title: 'Explain an anomaly',
    description:
      'Explains WHY an anomaly has the root cause it has: which sample traces were examined, where in each trace the problem started '
      + '(for latency, the span that spent the most time on its own work; for errors, the deepest failing span) and how many traces voted for each service. '
      + 'Pass an id from list_anomalies.',
    inputSchema: { anomaly_id: z.string().min(1).describe('Anomaly id, e.g. det-payment-p99_latency-1761220500000.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ anomaly_id }) => {
    const now = Date.now();
    const id = encodeURIComponent(anomaly_id);
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
    out.push('', 'Next: get_trace with one of the trace ids above to see the full call tree, or search_logs'
      + ` with service="${ex.rootCause ?? a.service_name}" level=["ERROR","WARN"]${w ? ` from="${F.iso(w.from_ms)}"` : ''} to read what that service logged.`);
    return text(out.join('\n'));
  }));

  // ------------------------------------------------------------------------------------------------ traces
  server.registerTool('search_traces', {
    title: 'Search traces',
    description:
      'Find traces (one trace = one request through all services). Filter by service, errors only, minimum duration or free text. '
      + 'Returns trace ids to pass to get_trace. Use sort="slowest" to find the slowest requests, status="error" for failed ones.',
    inputSchema: {
      service: z.string().optional().describe('Only traces that touch this service.'),
      status: z.enum(['error', '2xx', '3xx', '4xx', '5xx']).optional().describe('"error" = any 5xx or failed span; 2xx..5xx = HTTP status class of the root request.'),
      min_duration_ms: z.number().min(0).optional().describe('Only traces at least this slow.'),
      query: z.string().optional().describe('Free text matched against span names and trace-id prefix, e.g. "POST /api/checkout".'),
      sort: z.enum(['recent', 'slowest']).default('recent'),
      minutes: minutesArg(15),
      from: fromArg,
      to: toArg,
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async (args) => {
    const now = Date.now();
    const win = windowOf(args, 15, now);
    const res = await api.get('/api/traces', {
      service: args.service, status: args.status, minDurationMs: args.min_duration_ms, q: args.query,
      sort: args.sort === 'slowest' ? 'duration' : undefined, from: win.from ?? undefined, to: win.to ?? undefined, limit: args.limit ?? 10,
    });
    const list = res.traces ?? [];
    if (!list.length) return text(`No traces matched in ${win.label}. Try a longer time range or fewer filters.`);
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
    return text([
      `${list.length} of ${F.fmtNum(res.total)} matching traces in ${win.label}, ${args.sort === 'slowest' ? 'slowest first' : 'newest first'}:`,
      '',
      F.table(rows, [
        { key: 'id', label: 'TRACE ID' }, { key: 'start', label: 'STARTED' }, { key: 'dur', label: 'DURATION' }, { key: 'root', label: 'ROOT REQUEST' },
        { key: 'status', label: 'HTTP' }, { key: 'spans', label: 'SPANS' }, { key: 'err', label: 'ERR' }, { key: 'services', label: 'SERVICES' },
      ]),
      '',
      'Use get_trace with a TRACE ID to see the call tree.',
    ].join('\n'));
  }));

  server.registerTool('get_trace', {
    title: 'Get a trace',
    description:
      'One request through the system as an indented call tree: every span with its service, start offset, duration, own time (time not spent waiting on child calls), '
      + 'HTTP status and errors, with the span that spent the most time on its own work flagged. Also returns the logs written during that request. '
      + 'Use it to see where a slow or failed request spent its time.',
    inputSchema: {
      trace_id: z.string().min(8).describe('Trace id (from search_traces, list_anomalies or a log line).'),
      include_logs: z.boolean().default(true).describe('Also fetch the logs of this trace (default true).'),
      max_spans: z.number().int().min(1).max(300).default(80),
      max_logs: z.number().int().min(1).max(200).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ trace_id, include_logs = true, max_spans = 80, max_logs = 30 }) => {
    const id = encodeURIComponent(trace_id);
    const [trace, logs] = await Promise.all([
      api.get(`/api/traces/${id}`),
      include_logs ? api.get('/api/logs', { traceId: trace_id, order: 'asc', limit: 500 }) : Promise.resolve(null),
    ]);
    return text(F.renderTrace(trace, logs, { maxSpans: max_spans, maxLogs: max_logs }));
  }));

  // ------------------------------------------------------------------------------------------------ logs
  server.registerTool('search_logs', {
    title: 'Search logs',
    description:
      'Search stored logs. Free text (case-insensitive substring) or a regular expression (RE2 syntax, no look-around) over the message and the attributes; '
      + 'filter by service, level, trace id and dynamic tags such as user.id, order.id, payment.id, sku (eq, ne, re = value matches a regex, has = key exists). '
      + 'Newest first by default. Example: errors from payment for one user: service="payment", level=["ERROR"], tags=[{"key":"user.id","op":"eq","value":"user-38"}].',
    inputSchema: {
      query: z.string().optional().describe('Text to find in message or attributes. With regex=true it is a regular expression.'),
      regex: z.boolean().default(false).describe('Treat query as a regular expression (RE2).'),
      service: z.string().optional(),
      level: z.array(z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR'])).optional().describe('Only these levels, e.g. ["WARN","ERROR"].'),
      trace_id: z.string().optional().describe('Only logs written during this trace.'),
      span_id: z.string().optional(),
      tags: z.array(z.object({
        key: z.string().describe('Attribute name, e.g. user.id'),
        op: z.enum(['eq', 'ne', 're', 'has']).default('eq'),
        value: z.string().optional().describe('Value to compare (not needed for "has").'),
      })).max(10).optional().describe('Dynamic tag filters on the log attributes; all must match.'),
      // No zod default here: "not given" must stay distinguishable, because a trace_id or span_id search covers all stored time.
      minutes: z.number().int().min(1).max(MAX_MINUTES).optional()
        .describe('Look back this many minutes from now (default 15; with trace_id or span_id the default is all stored time).'),
      from: fromArg,
      to: toArg,
      limit: z.number().int().min(1).max(200).default(50),
      order: z.enum(['desc', 'asc']).default('desc').describe('desc = newest first (default), asc = oldest first.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async (args) => {
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
    if (!logs.length) {
      return text(`No logs matched in ${win.label}. Try a longer range or fewer filters${args.regex ? '' : ' (set regex=true for pattern matching)'}.`);
    }
    const levels = {};
    for (const l of logs) levels[l.level] = (levels[l.level] ?? 0) + 1;
    const mix = Object.entries(levels).map(([k, v]) => `${v} ${k}`).join(', ');
    return text([
      `${logs.length} log${logs.length === 1 ? '' : 's'} in ${win.label}${res.hasMore ? ' (more exist: narrow the filters or raise limit)' : ''} - ${mix}; ${args.order === 'asc' ? 'oldest' : 'newest'} first:`,
      '',
      ...logs.map((l) => F.logLine(l, { withTrace: true })),
    ].join('\n'));
  }));

  // ------------------------------------------------------------------------------------------------ topology
  server.registerTool('get_topology', {
    title: 'Service topology',
    description:
      'The service dependency graph built from real traffic: which service calls which, with call counts, error rates and latency on every connection, '
      + 'and a health verdict per service. Use it to see what depends on what and where a problem can spread.',
    inputSchema: { minutes: minutesArg(15) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ minutes = 15 }) => {
    const now = Date.now();
    const topo = await api.get('/api/topology', { minutes });
    const nodes = [...(topo.nodes ?? [])].sort(byHealth);
    const edges = [...(topo.edges ?? [])];
    if (!nodes.length) return text(`No services have reported traffic in the last ${minutes} minutes.`);

    const out = [`Service topology, last ${minutes} minute${minutes === 1 ? '' : 's'}:`, '', 'Services:'];
    for (const n of nodes) {
      out.push(`- ${n.service} [${n.health.toUpperCase()}]${n.entry ? ' (entry point)' : ''}: ${F.fmtNum(n.requests)} requests (${n.rps.toFixed(1)}/s), errors ${F.fmtPct(n.errorRate)}, p50 ${F.fmtMs(n.p50Ms)}, p95 ${F.fmtMs(n.p95Ms)}, p99 ${F.fmtMs(n.p99Ms)}, last seen ${F.ago(n.lastSeenMs, now)}`);
    }
    out.push('', 'Calls (caller -> callee):');
    if (!edges.length) out.push('- none observed');
    for (const e of [...edges].sort((a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || b.calls - a.calls)) {
      out.push(`- ${e.source} -> ${e.target} [${String(e.health).toUpperCase()}]: ${F.fmtNum(e.calls)} calls (${e.rps.toFixed(1)}/s), errors ${F.fmtPct(e.errorRate)}, p95 ${F.fmtMs(e.p95Ms)}, p99 ${F.fmtMs(e.p99Ms)}`);
    }
    const sick = nodes.filter((n) => n.health === 'failing' || n.health === 'degraded');
    out.push('');
    if (sick.length) {
      const callers = [...new Set(edges.filter((e) => sick.some((n) => n.service === e.target)).map((e) => e.source))];
      out.push(`Unhealthy: ${sick.map((n) => `${n.service} (${n.health})`).join(', ')}.${callers.length ? ` Callers that may be affected: ${callers.join(', ')}.` : ''}`);
    } else out.push('All services look healthy.');
    out.push('Note: a call that never reaches its target produces no edge, because edges are built from spans on both sides.');
    return text(out.join('\n'));
  }));
}

function registerPrompts(server) {
  server.registerPrompt('investigate_incident', {
    title: 'Investigate an incident',
    description: 'Step-by-step investigation: health -> anomalies -> root cause -> trace -> logs, ending with a short report.',
    argsSchema: { service: z.string().optional().describe('Start with this service (optional).') },
  }, ({ service }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Investigate what is wrong in the system${service ? `, starting with the ${service} service` : ''}. Work like an on-call engineer:`,
          '1. get_service_health to see which services are unhealthy.',
          '2. list_anomalies for the last hour, then explain_anomaly for the newest critical one.',
          '3. get_trace on one of the sample trace ids to see where the time or the failure is.',
          '4. search_logs for the root-cause service (levels WARN and ERROR, around the anomaly time) to find the underlying error.',
          '5. get_topology to say which other services are affected.',
          'Finish with a short report: what is broken, the root cause service, the evidence (numbers and trace ids) and what to check next. Say plainly if everything looks healthy.',
        ].join('\n'),
      },
    }],
  }));
}

module.exports = { registerTools, registerPrompts, parseTime, windowOf, ToolInputError };
