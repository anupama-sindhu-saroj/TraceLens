// Correlation around one anomaly (feature 17, owner: B). Answers the question the problem statement asks:
// "which spans had their p99 latency spike during the error cluster?"
//
//   const c = await correlateAnomaly(anomaly);
//   c = { slowOperations[], relatedAnomalies[], latencyWithErrors, summary }
//
// 1. slowOperations: for every operation (service + span name + kind) compare its p99 in the anomaly's window with the same
//    operation's p99 in the baseline window. Operations whose p99 rose a lot are listed, with how many of their spans FAILED
//    in the same window, so "slow AND failing at the same time" is visible per span, not only per service.
// 2. relatedAnomalies: other alarms raised within LINK_MS of this one, tagged with how they relate
//    (same root cause / the service is on the call path of the sample traces / only close in time).
// 3. latencyWithErrors: a latency alarm and an error alarm that belong together (same cause or same call path).
// Everything below `correlateAnomaly` is pure so it can be unit tested without a database.
const db = require('../db');
const { ERROR_SQL, parseJson } = require('../api/util');
const { loadTraces } = require('./rootcause');

const LINK_MS = 5 * 60_000;
const OPTS = {
  minCurSpans: 5,       // an operation needs this many spans in the anomaly window ...
  minBaseSpans: 10,     // ... and this many in the baseline, or its p99 is just noise
  minP99Ms: 50,         // a p99 below this is never "slow"
  minRatio: 2,          // p99 at least doubled
  minDeltaMs: 50,       // and grew by at least this much
  maxOperations: 8,
  maxRelated: 10,
};

const round1 = (n) => Math.round(n * 10) / 10;
const RELATION_RANK = { 'same-cause': 0, 'call-path': 1, concurrent: 2 };
const METRIC_WORD = { p99_latency: 'latency', error_rate: 'error rate' };

/** Pure. curRows/baseRows: [{service_name, name, kind, n, p99, errors}]. Returns the operations whose p99 spiked, worst first. */
function rankOperations(curRows, baseRows, rootCause, o = OPTS) {
  const key = (r) => `${r.service_name}\u0000${r.name}\u0000${r.kind ?? ''}`;
  const base = new Map(baseRows.map((r) => [key(r), r]));
  const out = [];
  for (const cur of curRows) {
    const b = base.get(key(cur));
    if (!b || cur.n < o.minCurSpans || b.n < o.minBaseSpans) continue;
    if (cur.p99 < o.minP99Ms || !(b.p99 > 0)) continue;
    const ratio = cur.p99 / b.p99;
    const delta = cur.p99 - b.p99;
    if (ratio < o.minRatio || delta < o.minDeltaMs) continue;
    out.push({
      service: cur.service_name,
      operation: cur.name,
      kind: cur.kind ?? null,
      baselineP99Ms: round1(b.p99),
      currentP99Ms: round1(cur.p99),
      ratio: round1(ratio),
      spans: Number(cur.n),
      errors: Number(cur.errors ?? 0),
      errorRate: cur.n ? Math.round((Number(cur.errors ?? 0) / Number(cur.n)) * 1000) / 1000 : 0,
      inRootCause: rootCause ? cur.service_name === rootCause : false,
    });
  }
  // the root-cause service first (that is where the story starts), then by how much the p99 grew
  out.sort((a, b) => (b.inRootCause - a.inRootCause) || (b.ratio - a.ratio) || (b.currentP99Ms - a.currentP99Ms));
  return out.slice(0, o.maxOperations);
}

/**
 * Pure. others: anomaly rows (details already parsed). callPath: Set of services seen in this anomaly's sample traces.
 * Returns the alarms that happened close in time, each tagged with how it relates to `anomaly`.
 */
function linkAnomalies(anomaly, others, callPath = new Set(), o = OPTS) {
  const out = [];
  for (const x of others) {
    if (x.id === anomaly.id || Math.abs(x.detected_at_ms - anomaly.detected_at_ms) > LINK_MS) continue;
    let relation = 'concurrent';
    if ((x.root_cause && anomaly.root_cause && x.root_cause === anomaly.root_cause)
      || (x.service_name === anomaly.root_cause) || (x.root_cause === anomaly.service_name)) relation = 'same-cause';
    else if (callPath.has(x.service_name)) relation = 'call-path';
    out.push({
      id: x.id,
      service: x.service_name,
      metric: x.metric,
      severity: x.severity,
      ratio: x.ratio ?? null,
      rootCause: x.root_cause ?? null,
      detectedAtMs: x.detected_at_ms,
      offsetSec: Math.round((x.detected_at_ms - anomaly.detected_at_ms) / 1000),
      relation,
    });
  }
  out.sort((a, b) => RELATION_RANK[a.relation] - RELATION_RANK[b.relation] || Math.abs(a.offsetSec) - Math.abs(b.offsetSec));
  return out.slice(0, o.maxRelated);
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const fmtOffset = (s) => (Math.abs(s) < 5 ? 'at the same time' : `${Math.abs(s) >= 90 ? `${Math.round(Math.abs(s) / 60)} min` : `${Math.abs(s)} s`} ${s < 0 ? 'earlier' : 'later'}`);

/** Pure. One readable paragraph for the Anomalies page, the MCP tool and the demo. */
function summarize(anomaly, slowOperations, related, latencyWithErrors) {
  const parts = [];
  const rel = related.filter((r) => r.relation !== 'concurrent');
  if (latencyWithErrors) {
    const other = rel.find((r) => r.metric !== anomaly.metric);
    parts.push(`The latency spike and an error cluster belong together: ${other.service} ${METRIC_WORD[other.metric]} alarm (${other.severity}${other.ratio ? `, ${round1(other.ratio)}x` : ''}) fired ${fmtOffset(other.offsetSec)}.`);
  } else if (rel.length) {
    parts.push(`${rel.length} other alarm${rel.length === 1 ? '' : 's'} point${rel.length === 1 ? 's' : ''} at the same incident: ${rel.slice(0, 3).map((r) => `${r.service} ${METRIC_WORD[r.metric]}`).join(', ')}.`);
  }
  if (slowOperations.length) {
    const top = slowOperations[0];
    const failing = slowOperations.filter((s) => s.errors > 0 && s.errorRate >= 0.05); // >= 5% of its spans failed
    parts.push(`${slowOperations.length} operation${slowOperations.length === 1 ? '' : 's'} got much slower; the worst is ${top.service} ${top.operation} (p99 ${fmtMs(top.baselineP99Ms)} -> ${fmtMs(top.currentP99Ms)}, ${top.ratio}x)${failing.length ? `, and ${failing.length} of them also had failures in the same window` : ''}.`);
  } else {
    parts.push('No single operation shows a p99 spike big enough to name (too few spans, or the slowdown is spread evenly).');
  }
  if (!rel.length && related.length) parts.push(`${related.length} unrelated alarm${related.length === 1 ? '' : 's'} fired around the same time.`);
  return parts.join(' ');
}

/** Pure glue: everything `correlateAnomaly` returns, from already loaded data. */
function buildCorrelation(anomaly, curRows, baseRows, others, callPath) {
  const slowOperations = rankOperations(curRows, baseRows, anomaly.root_cause);
  const relatedAnomalies = linkAnomalies(anomaly, others, callPath);
  const latencyWithErrors = relatedAnomalies.some((r) => r.relation !== 'concurrent' && r.metric !== anomaly.metric);
  return { slowOperations, relatedAnomalies, latencyWithErrors, summary: summarize(anomaly, slowOperations, relatedAnomalies, latencyWithErrors) };
}

async function operationStats(from, to) {
  return db.query(
    `SELECT service_name, name, kind, count(*) AS n, quantile_cont(duration_ms, 0.99) AS p99,
            count(*) FILTER (WHERE ${ERROR_SQL}) AS errors
     FROM spans WHERE start_time_ms >= ? AND start_time_ms < ? GROUP BY service_name, name, kind`, [from, to]);
}

async function correlateAnomaly(anomaly) {
  const w = anomaly?.details?.window;
  const bw = anomaly?.details?.baseline_window;
  const empty = { slowOperations: [], relatedAnomalies: [], latencyWithErrors: false, summary: 'No time window was stored for this alarm, so nothing could be correlated.' };
  if (!w || !bw) return empty;
  const [curRows, baseRows, otherRows, traces] = await Promise.all([
    operationStats(w.from_ms, w.to_ms + 1),
    operationStats(bw.from_ms, bw.to_ms),
    db.query('SELECT * FROM anomalies WHERE detected_at_ms >= ? AND detected_at_ms <= ? AND id <> ?',
      [anomaly.detected_at_ms - LINK_MS, anomaly.detected_at_ms + LINK_MS, anomaly.id]),
    loadTraces((anomaly.details.related_trace_ids ?? []).slice(0, 30)),
  ]);
  const callPath = new Set();
  for (const spans of traces.values()) for (const s of spans) callPath.add(s.service_name);
  const others = otherRows.map((r) => ({ ...r, details: typeof r.details === 'string' ? parseJson(r.details) : (r.details ?? {}) }));
  return buildCorrelation(anomaly, curRows, baseRows, others, callPath);
}

module.exports = { correlateAnomaly, rankOperations, linkAnomalies, summarize, buildCorrelation, LINK_MS };
