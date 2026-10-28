// Root-cause correlation (feature 17, owner: B).
// findRootCause(anomaly) -> service name (string) or null. Same signature the detector already calls.
//
// Idea: the service that RAISED the alarm is often only a victim (gateway is slow because payment is slow).
// For each sample trace in anomaly.details.related_trace_ids we find the span where the problem ORIGINATES,
// then let the traces vote:
//   p99_latency : the span with the largest SELF time (its duration minus the time covered by its children).
//                 A parent that is only waiting for a slow child has almost no self time, the slow child does.
//   error_rate  : an errored span with NO errored descendant (the deepest error). If several, the earliest one.
// The service with the most votes wins; ties go to the service with more total evidence, then to the alarm's own service.
const db = require('../db');

const MAX_TRACES = 30;

const isError = (s) => (s.http_status != null ? s.http_status >= 500 : s.status_code === 'ERROR');

// Time covered by children (union of their intervals, clipped to the parent), so parallel children are not counted twice.
function coveredMs(parent, children) {
  const lo = parent.start_time_ms;
  const hi = parent.start_time_ms + parent.duration_ms;
  const iv = children
    .map((c) => [Math.max(lo, c.start_time_ms), Math.min(hi, c.start_time_ms + c.duration_ms)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = null;
  let curB = null;
  for (const [a, b] of iv) {
    if (curB === null || a > curB) { if (curB !== null) total += curB - curA; curA = a; curB = b; }
    else curB = Math.max(curB, b);
  }
  if (curB !== null) total += curB - curA;
  return total;
}

function childrenIndex(spans) {
  const by = new Map();
  for (const s of spans) {
    if (!s.parent_span_id) continue;
    if (!by.has(s.parent_span_id)) by.set(s.parent_span_id, []);
    by.get(s.parent_span_id).push(s);
  }
  return by;
}

/** The span where a latency problem originates in one trace: largest self time. */
function latencyOrigin(spans) {
  const kids = childrenIndex(spans);
  let best = null;
  for (const s of spans) {
    const self = s.duration_ms - coveredMs(s, kids.get(s.span_id) ?? []);
    if (!best || self > best.score) best = { service: s.service_name, span: s, score: self };
  }
  return best;
}

/**
 * The span where an error originates in one trace: errored, and NOTHING below it errored (any depth).
 * Looking at direct children is not enough: real traces have non-failing INTERNAL handler spans between a failing caller
 * and the failing callee (gateway SERVER 502 -> handler -> CLIENT 500 -> payment SERVER 500), and a direct-children rule
 * would blame the entry service every time.
 */
function errorOrigin(spans) {
  const kids = childrenIndex(spans);
  const memo = new Map();
  const failsBelow = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false); // guards against a cycle in broken data
    const r = (kids.get(id) ?? []).some((c) => isError(c) || failsBelow(c.span_id));
    memo.set(id, r);
    return r;
  };
  const roots = spans.filter((s) => isError(s) && !failsBelow(s.span_id));
  if (!roots.length) return null;
  roots.sort((a, b) => a.start_time_ms - b.start_time_ms);
  return { service: roots[0].service_name, span: roots[0], score: 1 };
}

/**
 * Pure part (no database): spansByTrace = Map(traceId -> spans[]). Returns { service, votes, evidence } or null.
 */
function analyzeTraces(spansByTrace, metric, alarmService) {
  const votes = new Map();
  const evidence = new Map();
  for (const spans of spansByTrace.values()) {
    if (!spans.length) continue;
    const origin = metric === 'error_rate' ? errorOrigin(spans) : latencyOrigin(spans);
    if (!origin) continue;
    votes.set(origin.service, (votes.get(origin.service) ?? 0) + 1);
    evidence.set(origin.service, (evidence.get(origin.service) ?? 0) + origin.score);
  }
  if (!votes.size) return null;
  const ranked = [...votes.keys()].sort((a, b) =>
    votes.get(b) - votes.get(a)
    || evidence.get(b) - evidence.get(a)
    || (b === alarmService) - (a === alarmService));
  return {
    service: ranked[0],
    votes: Object.fromEntries(votes),
    evidence: Object.fromEntries([...evidence].map(([k, v]) => [k, Math.round(v * 10) / 10])),
  };
}

async function loadTraces(ids) {
  const byTrace = new Map();
  if (!ids.length) return byTrace;
  const rows = await db.query(
    `SELECT * FROM spans WHERE trace_id IN (${ids.map(() => '?').join(',')})`, ids);
  for (const r of rows) {
    if (!byTrace.has(r.trace_id)) byTrace.set(r.trace_id, []);
    byTrace.get(r.trace_id).push(r);
  }
  return byTrace;
}

async function findRootCause(anomaly) {
  const ids = (anomaly?.details?.related_trace_ids ?? []).slice(0, MAX_TRACES);
  if (!ids.length) return anomaly?.service_name ?? null; // nothing to correlate: blame the service that raised it
  const result = analyzeTraces(await loadTraces(ids), anomaly.metric, anomaly.service_name);
  return result ? result.service : (anomaly.service_name ?? null);
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

/**
 * The "why" behind a root cause, for the Anomalies page: which traces were looked at, where the problem started in each,
 * and the vote. Pure over `spansByTrace` (Map traceId -> spans[]) so it can be tested without a database.
 * Returns { rootCause, method, tracesAnalyzed, votes, evidence, samples, summary }.
 */
function explainTraces(spansByTrace, metric, alarmService) {
  const method = metric === 'error_rate' ? 'deepest-error' : 'self-time';
  const samples = [];
  for (const [traceId, spans] of spansByTrace) {
    if (!spans.length) continue;
    const origin = method === 'deepest-error' ? errorOrigin(spans) : latencyOrigin(spans);
    if (!origin) continue;
    const start = Math.min(...spans.map((s) => s.start_time_ms));
    const end = Math.max(...spans.map((s) => s.start_time_ms + s.duration_ms));
    samples.push({
      traceId,
      service: origin.service,
      spanId: origin.span.span_id,
      spanName: origin.span.name,
      spanDurationMs: Math.round(origin.span.duration_ms * 10) / 10,
      selfMs: method === 'self-time' ? Math.round(origin.score * 10) / 10 : null,
      traceDurationMs: Math.round((end - start) * 10) / 10,
    });
  }
  const result = analyzeTraces(spansByTrace, metric, alarmService);
  const total = spansByTrace.size;
  if (!result) {
    return {
      rootCause: alarmService ?? null, method, tracesAnalyzed: 0, votes: {}, evidence: {}, samples: [],
      summary: total === 0
        ? 'No sample traces were stored for this alarm, so the service that raised it is reported as the root cause.'
        : 'The sample traces did not show where the problem starts, so the service that raised the alarm is reported.',
    };
  }
  const win = result.votes[result.service];
  const mine = samples.filter((x) => x.service === result.service);
  let summary;
  if (method === 'self-time') {
    const avg = mine.reduce((a, x) => a + (x.selfMs ?? 0), 0) / Math.max(1, mine.length);
    summary = `In ${win} of ${samples.length} sample slow traces, ${result.service} spent the most time on its own work (about ${fmtMs(avg)} per request). Services that only waited for it are not blamed.`;
  } else {
    summary = `In ${win} of ${samples.length} sample failing traces, the first error came from ${result.service}. Callers that merely passed its error along are not blamed.`;
  }
  return { rootCause: result.service, method, tracesAnalyzed: samples.length, votes: result.votes, evidence: result.evidence, samples, summary };
}

async function explainRootCause(anomaly) {
  const ids = (anomaly?.details?.related_trace_ids ?? []).slice(0, MAX_TRACES);
  return explainTraces(await loadTraces(ids), anomaly.metric, anomaly.service_name);
}

module.exports = { findRootCause, analyzeTraces, latencyOrigin, errorOrigin, explainTraces, explainRootCause, loadTraces };