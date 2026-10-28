// Anomalies API (features 16 to 18 backend, owner: B).
//   GET /api/anomalies?service=&severity=&metric=&from=&to=&limit=   newest first
//   GET /api/anomalies/:id
//   GET /api/anomalies/:id/explain   why this root cause: { rootCause, method, tracesAnalyzed, votes, evidence, samples[], summary,
//                                      correlation: { slowOperations[], relatedAnomalies[], latencyWithErrors, summary } }
// -> { anomalies: [{ id, detected_at_ms, service_name, metric, baseline, current, ratio, severity, root_cause, details }] }
// `details` is parsed JSON (window, baseline_window, spans_in_window, bad_spans, related_trace_ids).
const { Router } = require('express');
const db = require('../db');
const { num, parseJson } = require('./util');
const { explainRootCause } = require('../anomaly/rootcause');
const { correlateAnomaly } = require('../anomaly/correlate');

const router = Router();
const shape = (r) => ({ ...r, details: parseJson(r.details) });

router.get('/', async (req, res) => {
  const q = req.query;
  const limit = num(q.limit, 50, { min: 1, max: 500 });
  const where = [];
  const params = [];
  if (q.service) { where.push('service_name = ?'); params.push(String(q.service)); }
  if (q.severity) { where.push('severity = ?'); params.push(String(q.severity).toUpperCase()); }
  if (q.metric) { where.push('metric = ?'); params.push(String(q.metric)); }
  const from = num(q.from, null);
  const to = num(q.to, null);
  if (from !== null) { where.push('detected_at_ms >= ?'); params.push(from); }
  if (to !== null) { where.push('detected_at_ms < ?'); params.push(to); }
  const rows = await db.query(
    `SELECT * FROM anomalies ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY detected_at_ms DESC LIMIT ${limit}`, params);
  res.json({ anomalies: rows.map(shape), count: rows.length });
});

router.get('/:id', async (req, res) => {
  const rows = await db.query('SELECT * FROM anomalies WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'anomaly not found' });
  res.json(shape(rows[0]));
});

router.get('/:id/explain', async (req, res) => {
  const rows = await db.query('SELECT * FROM anomalies WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'anomaly not found' });
  const anomaly = shape(rows[0]);
  const [why, correlation] = await Promise.all([explainRootCause(anomaly), correlateAnomaly(anomaly)]);
  res.json({ id: anomaly.id, service: anomaly.service_name, metric: anomaly.metric, storedRootCause: anomaly.root_cause, ...why, correlation });
});

module.exports = { anomaliesRouter: router };