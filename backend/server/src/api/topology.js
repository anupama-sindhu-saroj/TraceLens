// Service topology API (feature 14 backend, owner: B).
//   GET /api/topology?minutes=15
//   -> { windowMinutes, from, to,
//        nodes: [{ service, requests, rps, errors, errorRate, avgMs, p50Ms, p95Ms, p99Ms, lastSeenMs, health, entry, entryRequests }],
//        edges: [{ source, target, calls, rps, errors, errorRate, avgMs, p50Ms, p95Ms, p99Ms, health }] }
//
// Nodes: one per service that served requests in the window. Numbers come from that service's own SERVER spans.
//        `entry` = outside clients call it directly (SERVER spans with no parent) and no other service calls it, e.g. the gateway.
// Edges: "source called target". Found by joining a span with its child span when they belong to different services
//        (the CLIENT span in the caller and the SERVER span it caused in the callee). Latency / errors are those of the
//        callee's SERVER span, the same view the callee's own metrics have. Health uses shared/health.js, so a node or an
//        edge has the same colour as on the Dashboard.
// Limit: a call that never reached the callee (service down, connection refused) creates no callee span, so it is not
//        an edge; the caller's own error rate shows it instead.
const { Router } = require('express');
const db = require('../db');
const { classifyHealth } = require('../shared/health');
const { num, ERROR_SQL } = require('./util');

const router = Router();
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const ERR_C = "(c.http_status >= 500 OR (c.http_status IS NULL AND c.status_code = 'ERROR'))";

async function buildTopology(minutes) {
  const to = Date.now();
  const from = to - minutes * 60_000;
  const seconds = minutes * 60;

  const [nodeRows, edgeRows] = await Promise.all([
    db.query(
      `SELECT service_name,
              count(*) AS requests,
              count(*) FILTER (WHERE ${ERROR_SQL}) AS errors,
              count(*) FILTER (WHERE parent_span_id IS NULL) AS entry_requests,
              avg(duration_ms) AS avg_ms,
              quantile_cont(duration_ms, 0.5) AS p50_ms,
              quantile_cont(duration_ms, 0.95) AS p95_ms,
              quantile_cont(duration_ms, 0.99) AS p99_ms,
              max(start_time_ms) AS last_seen_ms
       FROM spans WHERE kind = 'SERVER' AND start_time_ms >= ? AND start_time_ms <= ?
       GROUP BY service_name ORDER BY service_name`, [from, to]),
    db.query(
      `SELECT p.service_name AS source, c.service_name AS target,
              count(*) AS calls,
              count(*) FILTER (WHERE ${ERR_C}) AS errors,
              avg(c.duration_ms) AS avg_ms,
              quantile_cont(c.duration_ms, 0.5) AS p50_ms,
              quantile_cont(c.duration_ms, 0.95) AS p95_ms,
              quantile_cont(c.duration_ms, 0.99) AS p99_ms
       FROM spans c JOIN spans p ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id
       WHERE c.kind = 'SERVER' AND p.service_name <> c.service_name AND c.start_time_ms >= ? AND c.start_time_ms <= ?
       GROUP BY 1, 2 ORDER BY 1, 2`, [from, to]),
  ]);

  const nodes = nodeRows.map((r) => {
    const requests = Number(r.requests);
    const errorRate = requests ? Number(r.errors) / requests : 0;
    const p99Ms = r2(r.p99_ms);
    return {
      service: r.service_name,
      requests,
      rps: r2(requests / seconds),
      errors: Number(r.errors),
      errorRate,
      avgMs: r2(r.avg_ms), p50Ms: r2(r.p50_ms), p95Ms: r2(r.p95_ms), p99Ms,
      lastSeenMs: Number(r.last_seen_ms),
      health: classifyHealth({ requests, errorRate, p99Ms }),
      entry: false, // set below, once the edges are known
      entryRequests: Number(r.entry_requests),
    };
  });

  const known = new Set(nodes.map((n) => n.service));
  const edges = edgeRows
    .filter((r) => known.has(r.source) && known.has(r.target))
    .map((r) => {
      const calls = Number(r.calls);
      const errorRate = calls ? Number(r.errors) / calls : 0;
      const p99Ms = r2(r.p99_ms);
      return {
        source: r.source, target: r.target, calls,
        rps: r2(calls / seconds),
        errors: Number(r.errors), errorRate,
        avgMs: r2(r.avg_ms), p50Ms: r2(r.p50_ms), p95Ms: r2(r.p95_ms), p99Ms,
        health: classifyHealth({ requests: calls, errorRate, p99Ms }),
      };
    });

  // An entry point is a service that outside clients call directly: it serves requests with no parent AND nobody
  // else in the system calls it (a service that is called by others is not "the front door", even if it also gets direct hits).
  const called = new Set(edges.map((e) => e.target));
  for (const n of nodes) n.entry = n.entryRequests > 0 && !called.has(n.service);

  return { windowMinutes: minutes, from, to, nodes, edges };
}

router.get('/', async (req, res) => {
  const minutes = num(req.query.minutes, 15, { min: 1, max: 24 * 60 });
  res.json(await buildTopology(minutes));
});

module.exports = { topologyRouter: router, buildTopology };
