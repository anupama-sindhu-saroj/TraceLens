'use strict';
// The tools an AI agent can call. Every tool is read-only. Each returns plain text (for the model, with the ids needed for the
// next call) AND the same facts as structured JSON (structuredContent, described by an outputSchema) for scripts and other agents.
// A typical walk: get_service_health -> list_anomalies -> explain_anomaly -> get_trace -> search_logs.
const { z } = require('zod');
const { ApiError } = require('./client');
const D = require('./data');

const { MAX_MINUTES, ToolInputError, parseTime, windowOf } = D;

const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

// Wraps a tool body so an unreachable API or a bad argument becomes a readable tool error, never a crashed server.
// The body returns { text, data }.
const tool = (body) => async (args) => {
  try {
    const { text, data } = await body(args ?? {});
    return { content: [{ type: 'text', text }], structuredContent: data };
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status === 404 ? `Not found: ${e.message}` : e.message);
    if (e instanceof ToolInputError) return fail(e.message);
    return fail(`Unexpected error: ${e && e.message ? e.message : e}`);
  }
};

const minutesArg = (def) => z.number().int().min(1).max(MAX_MINUTES).default(def)
  .describe(`Look back this many minutes from now (default ${def}).`);
const fromArg = z.string().optional().describe('Start of an explicit time range, ISO 8601 (e.g. 2026-10-23T11:55:00Z). Overrides minutes.');
const toArg = z.string().optional().describe('End of an explicit time range, ISO 8601. Leave out for "now".');

// ---- output shapes (what structuredContent looks like) -------------------------------------------------------------------
const num = z.number();
const optNum = z.number().nullable();
const optStr = z.string().nullable();
const attrs = z.record(z.string(), z.unknown());

const anomalyOut = z.object({
  id: z.string(), severity: z.string(), service: z.string(), metric: z.string(),
  baseline: num, current: num, ratio: optNum, rootCause: optStr, detectedAtMs: num,
  badSpans: optNum, spansInWindow: optNum, sampleTraceIds: z.array(z.string()),
});

const healthOut = {
  windowMinutes: num,
  services: z.array(z.object({
    service: z.string(), health: z.string(), requests: num, errors: num, errorRate: num,
    avgLatencyMs: optNum, p99LatencyMs: optNum, lastSeenMs: optNum,
  })),
  needsAttention: z.array(z.object({ service: z.string(), health: z.string() })),
  anomalies: z.array(anomalyOut),
};

const listAnomaliesOut = {
  window: z.object({ fromMs: optNum, toMs: optNum }),
  count: num,
  anomalies: z.array(anomalyOut),
};

const explainOut = {
  ...anomalyOut.shape,
  method: z.string(), tracesAnalyzed: num, votes: z.record(z.string(), num), summary: z.string(),
  samples: z.array(z.object({
    traceId: z.string(), service: z.string(), spanId: z.string(), spanName: z.string(),
    spanDurationMs: num, selfMs: optNum, traceDurationMs: num,
  })),
};

const searchTracesOut = {
  total: num, returned: num,
  traces: z.array(z.object({
    traceId: z.string(), startMs: num, durationMs: num, rootService: optStr, rootName: optStr,
    httpStatus: optNum, spanCount: num, errorSpans: num, services: z.array(z.string()),
  })),
};

const logOut = z.object({
  timeMs: num, service: z.string(), level: z.string(), message: z.string(), traceId: optStr, spanId: optStr, attributes: attrs,
});

const getTraceOut = {
  traceId: z.string(), startMs: num, durationMs: num, spanCount: num, errorSpans: num, services: z.array(z.string()),
  logCount: num, truncated: z.boolean(),
  bottleneck: z.object({ service: z.string(), name: z.string(), spans: num, totalOwnMs: num }).nullable(),
  spans: z.array(z.object({
    spanId: z.string(), parentSpanId: optStr, service: z.string(), name: z.string(), kind: optStr,
    startMs: num, offsetMs: num, durationMs: num, ownMs: num, httpStatus: optNum, statusCode: optStr, error: z.boolean(), attributes: attrs,
  })),
  logs: z.array(logOut),
};

const searchLogsOut = {
  count: num, hasMore: z.boolean(),
  window: z.object({ fromMs: optNum, toMs: optNum }),
  levels: z.record(z.string(), num),
  logs: z.array(logOut),
};

const topologyOut = {
  windowMinutes: num,
  nodes: z.array(z.object({
    service: z.string(), health: z.string(), entry: z.boolean(), requests: num, rps: num, errors: num, errorRate: num,
    avgMs: optNum, p50Ms: optNum, p95Ms: optNum, p99Ms: optNum, lastSeenMs: optNum,
  })),
  edges: z.array(z.object({
    source: z.string(), target: z.string(), health: z.string(), calls: num, rps: num, errors: num, errorRate: num,
    avgMs: optNum, p50Ms: optNum, p95Ms: optNum, p99Ms: optNum,
  })),
  unhealthy: z.array(z.object({ service: z.string(), health: z.string(), affectedCallers: z.array(z.string()) })),
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

function registerTools(server, api) {
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
    outputSchema: healthOut,
    annotations: READ_ONLY,
  }, tool((a) => D.healthReport(api, { service: a.service, minutes: a.minutes })));

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
    outputSchema: listAnomaliesOut,
    annotations: READ_ONLY,
  }, tool((a) => D.anomalyList(api, a)));

  server.registerTool('explain_anomaly', {
    title: 'Explain an anomaly',
    description:
      'Explains WHY an anomaly has the root cause it has: which sample traces were examined, where in each trace the problem started '
      + '(for latency, the span that spent the most time on its own work; for errors, the deepest failing span) and how many traces voted for each service. '
      + 'Pass an id from list_anomalies.',
    inputSchema: { anomaly_id: z.string().min(1).describe('Anomaly id, e.g. det-payment-p99_latency-1761220500000.') },
    outputSchema: explainOut,
    annotations: READ_ONLY,
  }, tool((a) => D.anomalyExplain(api, a.anomaly_id)));

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
    outputSchema: searchTracesOut,
    annotations: READ_ONLY,
  }, tool((a) => D.traceSearch(api, a)));

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
    outputSchema: getTraceOut,
    annotations: READ_ONLY,
  }, tool((a) => D.traceDetail(api, { traceId: a.trace_id, includeLogs: a.include_logs, maxSpans: a.max_spans, maxLogs: a.max_logs })));

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
    outputSchema: searchLogsOut,
    annotations: READ_ONLY,
  }, tool((a) => D.logSearch(api, a)));

  server.registerTool('get_topology', {
    title: 'Service topology',
    description:
      'The service dependency graph built from real traffic: which service calls which, with call counts, error rates and latency on every connection, '
      + 'and a health verdict per service. Use it to see what depends on what and where a problem can spread.',
    inputSchema: { minutes: minutesArg(15) },
    outputSchema: topologyOut,
    annotations: READ_ONLY,
  }, tool((a) => D.topologyReport(api, { minutes: a.minutes })));
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
