// DuckDB storage (feature 7, owner: A).
//
// Usage:
//   const db = require('./db');
//   await db.init();                         // once, at server start (DB_PATH env, default data/observability.duckdb)
//   await db.insertSpans(rows);              // batcher -> bulk Appender
//   await db.insertLogs(rows);
//   await db.insertAnomalies(rows);
//   const rows = await db.query('SELECT ... WHERE service_name = ?', ['payment']);
//
// Rules baked in (from the plan's risk table):
//  * One process, one connection. DuckDB allows a single writer process; MCP must go through REST.
//  * query() never returns BigInt (res.json() would crash): BIGINT/HUGEINT -> Number, DECIMAL -> Number.
//  * All writes/reads are serialized through one queue (a DuckDB connection is not safe for overlapping calls).
const fs = require('node:fs');
const path = require('node:path');
const { DuckDBInstance, DuckDBDecimalValue } = require('@duckdb/node-api');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'observability.duckdb');
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Column order here MUST match schema.sql (Appender is positional).
const TABLES = {
  spans: [
    ['trace_id', 'str'], ['span_id', 'str'], ['parent_span_id', 'str'], ['service_name', 'str'],
    ['name', 'str'], ['kind', 'str'], ['start_time_ms', 'int'], ['duration_ms', 'num'],
    ['status_code', 'str'], ['http_status', 'int'], ['attributes', 'json'],
  ],
  logs: [
    ['time_ms', 'int'], ['service_name', 'str'], ['level', 'str'], ['message', 'str'],
    ['trace_id', 'str'], ['span_id', 'str'], ['attributes', 'json'],
  ],
  anomalies: [
    ['id', 'str'], ['detected_at_ms', 'int'], ['service_name', 'str'], ['metric', 'str'],
    ['baseline', 'num'], ['current', 'num'], ['ratio', 'num'], ['severity', 'str'],
    ['root_cause', 'str'], ['details', 'json'],
  ],
};

let instance = null;
let conn = null;
let queue = Promise.resolve();

// Run fn after every earlier call finished; a failure doesn't poison the queue.
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function requireConn() {
  if (!conn) throw new Error('db not initialised: call await db.init() first');
  return conn;
}

async function init(dbPath = process.env.DB_PATH || DEFAULT_PATH) {
  if (conn) return;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  instance = await DuckDBInstance.create(dbPath);
  conn = await instance.connect();
  await serial(async () => {
    for (const stmt of SCHEMA_SQL.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
      await conn.run(stmt);
    }
  });
}

// BigInt / Decimal -> Number (and recurse into lists/structs) so JSON.stringify never throws.
function toPlain(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof DuckDBDecimalValue) return Number(v.toDouble());
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === 'object') {
    if (typeof v.toDouble === 'function') return v.toDouble();
    if (v.items) return v.items.map(toPlain);                       // LIST
    if (v.entries) return Object.fromEntries(Object.entries(v.entries).map(([k, x]) => [k, toPlain(x)]));
    if (Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
    }
    return String(v);                                               // dates etc: string form
  }
  return v;
}

// SELECT helper. params are positional (?). Returns array of plain objects, JSON safe.
function query(sql, params = []) {
  return serial(async () => {
    const c = requireConn();
    const reader = await c.runAndReadAll(sql, params.length ? params : undefined);
    return reader.getRowObjects().map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toPlain(v)])));
  });
}

// Non-SELECT helper (DELETE, UPDATE, DDL).
function exec(sql, params = []) {
  return serial(async () => {
    await requireConn().run(sql, params.length ? params : undefined);
  });
}

const isNil = (v) => v === undefined || v === null;

function appendValue(appender, type, v) {
  if (isNil(v)) return appender.appendNull();
  switch (type) {
    case 'str': return appender.appendVarchar(String(v));
    case 'int': return appender.appendBigInt(BigInt(Math.round(Number(v))));
    case 'num': return appender.appendDouble(Number(v));
    case 'json': return appender.appendVarchar(typeof v === 'string' ? v : JSON.stringify(v));
    default: throw new Error(`unknown column type ${type}`);
  }
}

// Bulk insert via the Appender (much faster than INSERT per row). rows = array of objects keyed by column name.
// http_status is INTEGER in the table; DuckDB casts the appended BIGINT automatically.
function bulkInsert(table, rows, prepare) {
  if (!rows || rows.length === 0) return Promise.resolve(0);
  const cols = TABLES[table];
  return serial(async () => {
    if (prepare) {
      rows = await prepare(rows);
      if (rows.length === 0) return 0;
    }
    const appender = await requireConn().createAppender(table);
    try {
      for (const row of rows) {
        for (const [name, type] of cols) {
          if (type === 'str' && name === 'service_name' && isNil(row[name])) {
            throw new Error(`${table}.service_name is required`);
          }
          appendValue(appender, type, row[name]);
        }
        appender.endRow();
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
    return rows.length;
  });
}

// Idempotent span insert: a span is identified by (trace_id, span_id). Duplicates inside the batch and spans that are
// already stored are skipped, so an exporter retry (or the batcher retrying a write whose outcome is unknown) cannot
// create duplicate spans. First stored version wins. Set DEDUP_SPANS=0 to turn this off.
// Runs inside serial(), so it uses the connection directly (calling query() here would deadlock).
async function dropDuplicateSpans(rows) {
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const key = `${r.trace_id}/${r.span_id}`;
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }
  const traceIds = [...new Set(unique.map((r) => r.trace_id))];
  const stored = new Set();
  for (let i = 0; i < traceIds.length; i += 200) {
    const chunk = traceIds.slice(i, i + 200);
    const reader = await requireConn().runAndReadAll(
      `SELECT trace_id, span_id FROM spans WHERE trace_id IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const r of reader.getRowObjects()) stored.add(`${r.trace_id}/${r.span_id}`);
  }
  return unique.filter((r) => !stored.has(`${r.trace_id}/${r.span_id}`));
}

const insertSpans = (rows) => bulkInsert('spans', rows, process.env.DEDUP_SPANS === '0' ? undefined : dropDuplicateSpans);
const insertLogs = (rows) => bulkInsert('logs', rows);
const insertAnomalies = (rows) => bulkInsert('anomalies', rows);

async function close() {
  await queue;
  if (conn) { conn.closeSync(); conn = null; }
  if (instance) { instance.closeSync(); instance = null; }
}

module.exports = { init, query, exec, insertSpans, insertLogs, insertAnomalies, close };
