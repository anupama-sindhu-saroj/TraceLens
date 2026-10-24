// Logs API (features 11 and 12 backend, owner: B).
//
//   GET /api/logs?traceId=&spanId=&service=&level=&q=&regex=&tags=&from=&to=&order=&limit=&before=&skip=
//     level   one level or a comma list: ERROR  or  WARN,ERROR
//     q       free text, searched (case-insensitive) in the message AND in the attributes JSON.
//             With regex=1 it is a regular expression instead (RE2 syntax: no look-around or back-references;
//             add (?-i) at the start to make it case-sensitive).
//     tags    dynamic tag filters on the log attributes (user.id, order.id, sku, ...), a JSON array:
//               [{"key":"user.id","op":"eq","value":"user-38"}]
//             op: eq (equals) | ne (not equals / missing) | re (value matches regex) | has (key exists)
//     from/to epoch ms, inclusive/exclusive         order desc (default) | asc         limit default 200, max 1000
//     before, skip  cursor for the next page ("Load older"); the answer says hasMore
//   -> { logs: [{ time_ms, service_name, level, message, trace_id, span_id, attributes }], count, hasMore }
//   A bad regular expression or tags value answers 400 { error }.
//
//   GET /api/logs/histogram?(same filters)&from=&to=&buckets=60
//   -> { from, to, bucketMs, total, buckets: [{ t, DEBUG, INFO, WARN, ERROR }] }   (the timeline above the table)
//   GET /api/logs/facets?(same filters)
//   -> { service: [{ value, count }], level: [{ value, count }] }   (the Fields panel; each list ignores its own filter)
//   GET /api/logs/fields?(same filters)
//   -> { keys: [{ key, count }], sampled }          the tag names that exist in the matching logs, most common first
//   GET /api/logs/field-values?key=user.id&(same filters)
//   -> { key, values: [{ value, count }] }          the most common values of one tag (for the Fields panel and autocomplete)
//   (fields / field-values look at the newest 20,000 matching logs, so they stay fast on a big table)
const { Router } = require('express');
const db = require('../db');
const { num, parseJson } = require('./util');

const router = Router();
const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const MAX_REGEX_LEN = 500;
const MAX_TAGS = 10;
const SAMPLE_ROWS = 20_000;
const TAG_OPS = new Set(['eq', 'ne', 're', 'has']);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const truthy = (v) => v === true || v === '1' || v === 'true';

// tags may come as a JSON string (query string) or already as an array (WebSocket). Throws 400 on nonsense.
function parseTags(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { throw bad('tags must be a JSON array'); } }
  if (!Array.isArray(list)) throw bad('tags must be a JSON array');
  if (list.length > MAX_TAGS) throw bad(`at most ${MAX_TAGS} tag filters`);
  return list.map((t) => {
    const key = t && typeof t.key === 'string' ? t.key : '';
    const op = t && TAG_OPS.has(t.op) ? t.op : 'eq';
    if (!key || key.length > 100 || /["\\\u0000-\u001f]/.test(key)) throw bad(`bad tag key "${String(key).slice(0, 40)}"`);
    const value = t.value === undefined || t.value === null ? '' : String(t.value);
    if (op !== 'has' && value.length > MAX_REGEX_LEN) throw bad('tag value too long');
    return { key, op, value };
  });
}

const attrPath = (key) => `$."${key}"`;

// Shared with the live-tail WebSocket so both filter the same way. Returns { where, params }.
// Throws a 400 error for tags that cannot be parsed. (Regex syntax is checked by checkRegex, which needs the database.)
function buildLogFilter(q = {}, { skip = [] } = {}) {
  const where = [];
  const params = [];
  if (q.traceId) { where.push('trace_id = ?'); params.push(String(q.traceId)); }
  if (q.spanId) { where.push('span_id = ?'); params.push(String(q.spanId)); }
  if (q.service && !skip.includes('service')) { where.push('service_name = ?'); params.push(String(q.service)); }
  if (q.level && !skip.includes('level')) {
    const levels = String(q.level).toUpperCase().split(',').map((s) => s.trim()).filter((l) => LEVELS.has(l));
    if (levels.length) { where.push(`level IN (${levels.map(() => '?').join(',')})`); params.push(...levels); }
  }
  const from = num(q.from, null);
  const to = num(q.to, null);
  if (from !== null) { where.push('time_ms >= ?'); params.push(from); }
  if (to !== null) { where.push('time_ms < ?'); params.push(to); }
  if (q.q) {
    if (truthy(q.regex)) {
      where.push("(regexp_matches(message, ?, 'i') OR regexp_matches(attributes, ?, 'i'))");
      params.push(String(q.q), String(q.q));
    } else {
      where.push('(message ILIKE ? OR attributes ILIKE ?)');
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
  }
  for (const t of parseTags(q.tags)) {
    const val = 'json_extract_string(attributes, ?)';
    const path = attrPath(t.key);
    if (t.op === 'eq') { where.push(`${val} = ?`); params.push(path, t.value); }
    else if (t.op === 'ne') { where.push(`(${val} IS NULL OR ${val} <> ?)`); params.push(path, path, t.value); }
    else if (t.op === 're') { where.push(`regexp_matches(${val}, ?, 'i')`); params.push(path, t.value); }
    else { where.push('json_extract(attributes, ?) IS NOT NULL'); params.push(path); }
  }
  return { where, params };
}

// Ask DuckDB (RE2) whether the patterns compile, so the user gets a clear 400 instead of a failed query.
async function checkRegex(q = {}) {
  const patterns = [];
  if (q.q && truthy(q.regex)) patterns.push(String(q.q));
  for (const t of parseTags(q.tags)) if (t.op === 're') patterns.push(t.value);
  for (const p of patterns) {
    if (p.length > MAX_REGEX_LEN) throw bad(`regular expression is longer than ${MAX_REGEX_LEN} characters`);
    try { await db.query("SELECT regexp_matches('', ?)", [p]); } catch (e) {
      throw bad(`invalid regular expression: ${String(e.message).replace(/^Invalid Input Error:\s*/i, '').split('\n')[0]}`);
    }
  }
}

const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    return next(e);
  }
};

router.get('/', handle(async (req, res) => {
  const limit = num(req.query.limit, 200, { min: 1, max: 1000 });
  const dir = req.query.order === 'asc' ? 'ASC' : 'DESC';
  await checkRegex(req.query);
  const { where, params } = buildLogFilter(req.query);
  // Cursor paging ("Load older"): `before` = time_ms of the last row you already have (inclusive, so rows that share
  // that millisecond are not lost) and `skip` = how many of the rows you already have carry exactly that time_ms.
  // For order=asc the same pair means "after".
  const cursor = num(req.query.before, null);
  const skip = num(req.query.skip, 0, { min: 0, max: 100_000 });
  if (cursor !== null) { where.push(dir === 'DESC' ? 'time_ms <= ?' : 'time_ms >= ?'); params.push(cursor); }
  const rows = await db.query(
    `SELECT time_ms, service_name, level, message, trace_id, span_id, attributes
     FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY time_ms ${dir}, rowid ${dir} LIMIT ${limit + 1} OFFSET ${cursor !== null ? skip : 0}`, params);
  const hasMore = rows.length > limit;
  const logs = rows.slice(0, limit).map((r) => ({ ...r, attributes: parseJson(r.attributes) }));
  res.json({ logs, count: logs.length, hasMore });
}));

const LEVEL_KEYS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

router.get('/histogram', handle(async (req, res) => {
  const now = Date.now();
  const to = num(req.query.to, now);
  const from = num(req.query.from, to - 60 * 60_000);
  if (to <= from) return res.status(400).json({ error: 'to must be after from' });
  const wanted = num(req.query.buckets, 60, { min: 1, max: 200 });
  // whole seconds, so the bucket size can be written straight into the SQL as an integer literal
  const bucketMs = Math.max(1000, Math.ceil((to - from) / wanted / 1000) * 1000);

  await checkRegex(req.query);
  const { where, params } = buildLogFilter({ ...req.query, from, to });
  const rows = await db.query(
    `SELECT CAST(floor(time_ms / ${bucketMs}) AS BIGINT) * ${bucketMs} AS t, level, count(*) AS n
     FROM logs WHERE ${where.join(' AND ')} GROUP BY 1, 2`, params);

  const first = Math.floor(from / bucketMs) * bucketMs;
  const buckets = [];
  const at = new Map();
  for (let t = first; t < to; t += bucketMs) {
    const b = { t, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    buckets.push(b);
    at.set(t, b);
  }
  let total = 0;
  for (const r of rows) {
    const b = at.get(Number(r.t));
    if (b && LEVEL_KEYS.includes(r.level)) { b[r.level] += Number(r.n); total += Number(r.n); }
  }
  res.json({ from, to, bucketMs, total, buckets });
}));

router.get('/facets', handle(async (req, res) => {
  await checkRegex(req.query);
  const facet = async (column, key) => {
    const { where, params } = buildLogFilter(req.query, { skip: [key] });
    const rows = await db.query(
      `SELECT ${column} AS value, count(*) AS count FROM logs
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30`, params);
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  };
  const [service, level] = await Promise.all([facet('service_name', 'service'), facet('level', 'level')]);
  res.json({ service, level });
}));

// The newest SAMPLE_ROWS logs that match the filters (attributes only), used by the two tag endpoints.
function sample(req) {
  const { where, params } = buildLogFilter(req.query);
  where.push("attributes IS NOT NULL AND attributes <> '{}'");
  return { sql: `(SELECT attributes FROM logs WHERE ${where.join(' AND ')} ORDER BY time_ms DESC LIMIT ${SAMPLE_ROWS})`, params };
}

router.get('/fields', handle(async (req, res) => {
  await checkRegex(req.query);
  const { sql, params } = sample(req);
  const rows = await db.query(
    `SELECT k AS key, count(*) AS count FROM (SELECT unnest(json_keys(attributes)) AS k FROM ${sql}) GROUP BY k ORDER BY 2 DESC, 1 LIMIT 60`, params);
  res.json({ keys: rows.map((r) => ({ key: r.key, count: Number(r.count) })), sampled: SAMPLE_ROWS });
}));

router.get('/field-values', handle(async (req, res) => {
  const key = String(req.query.key ?? '');
  if (!key || key.length > 100 || /["\\\u0000-\u001f]/.test(key)) throw bad('key is required');
  await checkRegex(req.query);
  const { sql, params } = sample(req);
  const rows = await db.query(
    `SELECT v AS value, count(*) AS count FROM (SELECT json_extract_string(attributes, ?) AS v FROM ${sql})
     WHERE v IS NOT NULL GROUP BY v ORDER BY 2 DESC, 1 LIMIT 25`, [attrPath(key), ...params]);
  res.json({ key, values: rows.map((r) => ({ value: r.value, count: Number(r.count) })) });
}));

module.exports = { logsRouter: router, buildLogFilter, parseTags, checkRegex };