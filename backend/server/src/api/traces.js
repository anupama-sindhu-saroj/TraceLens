// Trace list + trace detail API (features 8 and 9 backend, owner: A).
//   GET /api/traces?service=&status=&minDurationMs=&maxDurationMs=&from=&to=&q=&sort=&limit=&offset=
//   GET /api/traces/:traceId
const { Router } = require('express');
const db = require('../db');
const { num, parseJson } = require('./util');

const router = Router();

// Root span wins (parent IS NULL); otherwise the earliest span. Encoded as one sortable number for arg_min.
const ROOT_RANK = '((CASE WHEN parent_span_id IS NULL THEN 0 ELSE 1 END) * 10000000000000 + start_time_ms)';

const STATUS_CLASSES = { '2xx': [200, 299], '3xx': [300, 399], '4xx': [400, 499], '5xx': [500, 599] };

router.get('/', async (req, res) => {
  const q = req.query;
  const limit = num(q.limit, 50, { min: 1, max: 200 });
  const offset = num(q.offset, 0, { min: 0 });
  const from = num(q.from, null);
  const to = num(q.to, null);
  const minDur = num(q.minDurationMs, null, { min: 0 });
  const maxDur = num(q.maxDurationMs, null, { min: 0 });
  const orderBy = q.sort === 'duration' ? 'duration_ms DESC' : 'start_ms DESC';

  const having = [];
  const params = [];
  if (from !== null) { having.push('min(start_time_ms) >= ?'); params.push(from); }
  if (to !== null) { having.push('min(start_time_ms) <= ?'); params.push(to); }
  if (q.service) { having.push('bool_or(service_name = ?)'); params.push(String(q.service)); }
  if (q.q) { having.push('bool_or(name ILIKE ? OR trace_id ILIKE ?)'); params.push(`%${q.q}%`, `${q.q}%`); }
  if (q.status === 'error') {
    having.push("bool_or(http_status >= 500 OR (http_status IS NULL AND status_code = 'ERROR'))");
  }

  const outer = [];
  const outerParams = [];
  if (STATUS_CLASSES[q.status]) {
    outer.push('http_status BETWEEN ? AND ?');
    outerParams.push(...STATUS_CLASSES[q.status]);
  }
  if (minDur !== null) { outer.push('duration_ms >= ?'); outerParams.push(minDur); }
  if (maxDur !== null) { outer.push('duration_ms <= ?'); outerParams.push(maxDur); }

  const sql = `
    WITH t AS (
      SELECT trace_id,
             min(start_time_ms) AS start_ms,
             max(start_time_ms + duration_ms) AS end_ms,
             count(*) AS span_count,
             string_agg(DISTINCT service_name, ',') AS services,
             arg_min(name, ${ROOT_RANK}) AS root_name,
             arg_min(service_name, ${ROOT_RANK}) AS root_service,
             arg_min(duration_ms, ${ROOT_RANK}) AS root_duration_ms,
             arg_min(http_status, ${ROOT_RANK}) AS http_status,
             count(*) FILTER (WHERE http_status >= 500 OR (http_status IS NULL AND status_code = 'ERROR')) AS error_spans
      FROM spans
      GROUP BY trace_id
      ${having.length ? 'HAVING ' + having.join(' AND ') : ''}
    ), s AS (
      SELECT *, greatest(root_duration_ms, end_ms - start_ms) AS duration_ms FROM t
    )
    SELECT *, count(*) OVER () AS total FROM s
    ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}`;

  const rows = await db.query(sql, [...params, ...outerParams]);
  // count(*) OVER () was computed before LIMIT, so it is the full match count.
  const total = rows.length ? rows[0].total : 0;
  res.json({
    total,
    limit,
    offset,
    traces: rows.map(({ total: _t, root_duration_ms: _r, end_ms: _e, services, ...r }) => ({
      traceId: r.trace_id,
      startMs: r.start_ms,
      durationMs: r.duration_ms,
      rootName: r.root_name,
      rootService: r.root_service,
      httpStatus: r.http_status,
      spanCount: r.span_count,
      errorSpans: r.error_spans,
      hasError: r.error_spans > 0,
      services: services ? services.split(',') : [],
    })),
  });
});

router.get('/:traceId', async (req, res) => {
  const rows = await db.query(
    'SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms, span_id', [req.params.traceId]);
  if (rows.length === 0) return res.status(404).json({ error: 'trace not found' });

  const startMs = Math.min(...rows.map((s) => s.start_time_ms));
  const endMs = Math.max(...rows.map((s) => s.start_time_ms + s.duration_ms));
  const ids = new Set(rows.map((s) => s.span_id));
  const [{ n: logCount }] = await db.query('SELECT count(*) AS n FROM logs WHERE trace_id = ?', [req.params.traceId]);

  res.json({
    traceId: req.params.traceId,
    startMs,
    durationMs: endMs - startMs,
    spanCount: rows.length,
    errorSpans: rows.filter((s) => s.http_status >= 500 || (s.http_status == null && s.status_code === 'ERROR')).length,
    services: [...new Set(rows.map((s) => s.service_name))],
    logCount,
    spans: rows.map((s) => ({
      spanId: s.span_id,
      // A parent that is not in this trace (dropped span) is treated as a root by the UI.
      parentSpanId: s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null,
      missingParent: !!s.parent_span_id && !ids.has(s.parent_span_id),
      serviceName: s.service_name,
      name: s.name,
      kind: s.kind,
      startMs: s.start_time_ms,
      offsetMs: s.start_time_ms - startMs,
      durationMs: s.duration_ms,
      statusCode: s.status_code,
      httpStatus: s.http_status,
      attributes: parseJson(s.attributes),
    })),
  });
});

module.exports = { tracesRouter: router };
