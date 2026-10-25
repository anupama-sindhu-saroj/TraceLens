// Dashboard stats API (feature 15 backend, owner: A). B's MCP get_service_health calls /api/stats/services.
//   GET /api/stats/overview?minutes=15
//   GET /api/stats/timeseries?minutes=15&bucketSec=15&service=
//   GET /api/stats/services?minutes=15
// "Request" = an entry request: a SERVER span with no parent (the gateway). Per-service numbers use that
// service's own SERVER spans. Error = HTTP 5xx (or status ERROR when no http status). 4xx are NOT errors.
const { Router } = require('express');
const db = require('../db');
const { classifyHealth } = require('../shared/health');
const { num, ERROR_SQL } = require('./util');

const router = Router();
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

function windowOf(req) {
  const minutes = num(req.query.minutes, 15, { min: 1, max: 24 * 60 });
  const to = Date.now();
  return { minutes, from: to - minutes * 60_000, to };
}

router.get('/overview', async (req, res) => {
  const { minutes, from, to } = windowOf(req);
  const [row] = await db.query(
    `SELECT count(*) AS requests,
            count(*) FILTER (WHERE ${ERROR_SQL}) AS errors,
            avg(duration_ms) AS avg_ms,
            quantile_cont(duration_ms, 0.99) AS p99_ms
     FROM spans
     WHERE kind = 'SERVER' AND parent_span_id IS NULL AND start_time_ms >= ? AND start_time_ms <= ?`, [from, to]);
  const [{ n: active }] = await db.query(
    'SELECT count(DISTINCT service_name) AS n FROM spans WHERE start_time_ms >= ?', [to - ACTIVE_WINDOW_MS]);
  const requests = row.requests;
  res.json({
    windowMinutes: minutes,
    from, to,
    totalRequests: requests,
    errorRate: requests ? row.errors / requests : 0,
    avgLatencyMs: requests ? r2(row.avg_ms) : 0,
    p99LatencyMs: requests ? r2(row.p99_ms) : 0,
    activeServices: active,
  });
});

router.get('/timeseries', async (req, res) => {
  const { minutes, from, to } = windowOf(req);
  const bucketSec = num(req.query.bucketSec, Math.max(5, Math.round((minutes * 60) / 60)), { min: 1, max: 3600 });
  const bucketMs = Math.round(bucketSec * 1000);
  const params = [bucketMs, bucketMs, from, to];
  let where = "kind = 'SERVER' AND start_time_ms >= ? AND start_time_ms <= ?";
  if (req.query.service) {
    where = `service_name = ? AND ${where}`;
    params.splice(2, 0, String(req.query.service));
  } else {
    where += ' AND parent_span_id IS NULL';
  }
  const rows = await db.query(
    `SELECT (start_time_ms // ?) * ? AS t,
            count(*) AS requests,
            count(*) FILTER (WHERE ${ERROR_SQL}) AS errors,
            avg(duration_ms) AS avg_ms,
            quantile_cont(duration_ms, 0.99) AS p99_ms
     FROM spans WHERE ${where} GROUP BY 1 ORDER BY 1`, params);

  // Fill empty buckets so charts show a flat zero instead of a stretched line.
  const byT = new Map(rows.map((r) => [r.t, r]));
  const points = [];
  for (let t = Math.floor(from / bucketMs) * bucketMs; t <= to; t += bucketMs) {
    const r = byT.get(t);
    points.push(r
      ? { t, requests: r.requests, errors: r.errors, errorRate: r.requests ? r.errors / r.requests : 0, avgMs: r2(r.avg_ms), p99Ms: r2(r.p99_ms) }
      : { t, requests: 0, errors: 0, errorRate: 0, avgMs: null, p99Ms: null });
  }
  res.json({ windowMinutes: minutes, bucketSec, from, to, points });
});

router.get('/services', async (req, res) => {
  const { minutes, from, to } = windowOf(req);
  const rows = await db.query(
    `SELECT service_name,
            count(*) AS requests,
            count(*) FILTER (WHERE ${ERROR_SQL}) AS errors,
            avg(duration_ms) AS avg_ms,
            quantile_cont(duration_ms, 0.99) AS p99_ms,
            max(start_time_ms) AS last_seen_ms
     FROM spans WHERE kind = 'SERVER' AND start_time_ms >= ? AND start_time_ms <= ?
     GROUP BY service_name ORDER BY service_name`, [from, to]);
  res.json({
    windowMinutes: minutes, from, to,
    services: rows.map((r) => {
      const errorRate = r.requests ? r.errors / r.requests : 0;
      const p99Ms = r2(r.p99_ms);
      return {
        service: r.service_name,
        requests: r.requests,
        errors: r.errors,
        errorRate,
        avgLatencyMs: r2(r.avg_ms),
        p99LatencyMs: p99Ms,
        lastSeenMs: r.last_seen_ms,
        health: classifyHealth({ requests: r.requests, errorRate, p99Ms }),
      };
    }),
  });
});

module.exports = { statsRouter: router };
