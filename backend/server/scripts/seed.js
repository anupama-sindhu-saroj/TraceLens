#!/usr/bin/env node
// Seed script (owner: B). Fills DuckDB with fake spans, logs and a "payment slow" incident so the web pages
// can be built before real data flows (see scripts/seed-data.js for what the data looks like).
//
//   npm run seed -w backend/server -- --reset
//
// Options
//   --reset               delete ALL rows in spans/logs/anomalies first (required if the tables are not empty)
//   --append              add to existing rows instead
//   --minutes 60          length of the data window, ending now
//   --flows-per-min 20    user sessions per minute (~36 spans each). Use 60+ for a 100K+ span benchmark
//   --incident-minutes 6  payment slow incident at the end of the window
//   --no-incident         healthy data only (use it to check that detection raises NO anomaly)
//   --no-anomalies        do not write rows into the anomalies table (let A's detector produce them)
//   --seed 42             same seed = same data
//   --db <path>           database file (default: DB_PATH env or data/observability.duckdb)
//   --clear               delete ALL rows in spans/logs/anomalies and exit (server must be stopped)
//
// Two ways to get the data into the database:
//
//   --via direct (default)  write straight into DuckDB with db.insertSpans/insertLogs.
//                           DuckDB allows ONE process on the file, so STOP the server (npm run server) first.
//   --via http              send it as OTLP/HTTP JSON      -> server :4318 -> parser -> batcher -> DuckDB
//   --via http-proto        send it as OTLP/HTTP protobuf  -> same endpoint, protobuf decoding path
//   --via grpc              send it as OTLP/gRPC           -> server :4317 -> parser -> batcher -> DuckDB
//   --via mixed             rotate http -> http-proto -> grpc, so one run checks all three paths
//                           For these the server must be RUNNING (it owns the file). Extra options:
//     --http-endpoint <url>   default OTLP_HTTP_ENDPOINT or http://localhost:4318
//     --grpc-endpoint <addr>  default OTLP_GRPC_ENDPOINT or localhost:4317
//     --api <url>             server REST API, for pacing + the written/dropped check (default http://localhost:8080)
//     --batch-size 500        rows per request
//     --no-verify             do not call the REST API (no pacing, no check)
//     Not possible through ingestion: --reset (DB is locked by the server; use --clear first) and the seeded
//     anomaly rows (they are written by the detector from the ingested data, which is the point of the test).
const { parseArgs } = require('node:util');
const db = require('../src/db');
const { generate } = require('./seed-data');

const { values: opt } = parseArgs({
  options: {
    reset: { type: 'boolean', default: false },
    append: { type: 'boolean', default: false },
    minutes: { type: 'string', default: '60' },
    'flows-per-min': { type: 'string', default: '20' },
    'incident-minutes': { type: 'string', default: '6' },
    'no-incident': { type: 'boolean', default: false },
    'no-anomalies': { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
    db: { type: 'string' },
    clear: { type: 'boolean', default: false },
    via: { type: 'string', default: 'direct' },
    'http-endpoint': { type: 'string' },
    'grpc-endpoint': { type: 'string' },
    api: { type: 'string' },
    'batch-size': { type: 'string', default: '500' },
    'no-verify': { type: 'boolean', default: false },
  },
});

const num = (name, v, min) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) { console.error(`--${name} must be a number >= ${min}`); process.exit(1); }
  return n;
};

async function insertInChunks(insert, rows, size = 5000) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

async function openDb() {
  try {
    await db.init(opt.db || undefined);
  } catch (e) {
    if (/lock/i.test(String(e.message))) {
      console.error('Could not open the database: another process is using it.\nStop the server (npm run server) and run the seed again, DuckDB allows only one process on the file.\n(To seed while the server is running, use --via http | grpc | mixed.)');
    } else {
      console.error('Could not open the database:', e.message);
    }
    process.exit(1);
  }
}

async function clearTables() {
  await db.exec('DELETE FROM spans');
  await db.exec('DELETE FROM logs');
  await db.exec('DELETE FROM anomalies');
  console.log('[seed] cleared spans, logs, anomalies');
}

function generateData(viaIngest) {
  const t0 = Date.now();
  const data = generate({
    minutes: num('minutes', opt.minutes, 1),
    flowsPerMin: num('flows-per-min', opt['flows-per-min'], 0.1),
    incidentMinutes: num('incident-minutes', opt['incident-minutes'], 0),
    seed: num('seed', opt.seed, 0),
    incident: !opt['no-incident'],
    anomalies: !opt['no-anomalies'] && !viaIngest, // anomaly rows have no OTLP form: through ingestion the detector makes them
  });
  console.log(`[seed] generated ${data.summary.spans} spans in ${data.summary.traces} traces, ${data.summary.logs} logs (${Date.now() - t0} ms)`);
  return data;
}

function printIncident(summary, incidentMinutes) {
  if (summary.incidentStart === null) return;
  const p = summary.payment;
  console.log(`[seed] payment p99: ${Math.round(p.baselineP99)} ms -> ${Math.round(p.currentP99)} ms (${(p.currentP99 / p.baselineP99).toFixed(1)}x), ` +
    `error rate ${(p.baselineErrorRate * 100).toFixed(1)}% -> ${(p.currentErrorRate * 100).toFixed(1)}%`);
  console.log(`[seed] incident started ${incidentMinutes} min ago (${new Date(summary.incidentStart).toISOString()}); data is relative to NOW, re-seed before a demo.`);
}

// --via direct: the original behaviour, straight into DuckDB.
async function seedDirect() {
  await openDb();
  const [counts] = await db.query('SELECT (SELECT count(*) FROM spans) AS spans, (SELECT count(*) FROM logs) AS logs, (SELECT count(*) FROM anomalies) AS anomalies');
  const existing = counts.spans + counts.logs + counts.anomalies;
  if (existing > 0 && !opt.reset && !opt.append) {
    console.error(`The database already has ${counts.spans} spans, ${counts.logs} logs and ${counts.anomalies} anomalies.\nRun with --reset to wipe it first, or --append to add to it.`);
    await db.close();
    process.exit(1);
  }
  if (opt.reset) await clearTables();

  const { spans, logs, anomalies, summary } = generateData(false);
  const t1 = Date.now();
  await insertInChunks((r) => db.insertSpans(r), spans);
  await insertInChunks((r) => db.insertLogs(r), logs);
  if (anomalies.length) await db.insertAnomalies(anomalies);
  console.log(`[seed] written to DuckDB (${Date.now() - t1} ms)`);

  console.table(await db.query('SELECT service_name, count(*) AS spans FROM spans GROUP BY 1 ORDER BY 1'));
  printIncident(summary, num('incident-minutes', opt['incident-minutes'], 0));
  await db.close();
}

// --via http | http-proto | grpc | mixed: through the running server's ingestion endpoints.
async function seedViaIngestion(via) {
  if (opt.reset) {
    console.error('--reset cannot be used with --via ' + via + ': the running server holds the database lock.\nStop the server and run "npm run seed -w backend/server -- --clear", then start it again.');
    process.exit(1);
  }
  const { spans, logs, summary } = generateData(true);
  if (!opt['no-anomalies'] && summary.incidentStart !== null) {
    console.log('[seed] anomaly rows are not sent (no OTLP form); the detector should raise them from the ingested spans.');
  }
  const { sendThroughIngestion } = require('./seed-ingest');
  const t1 = Date.now();
  const report = await sendThroughIngestion({
    via, spans, logs,
    batchSize: Math.floor(num('batch-size', opt['batch-size'], 1)),
    api: opt['no-verify'] ? null : (opt.api || process.env.SEED_API || 'http://localhost:8080'),
    httpEndpoint: opt['http-endpoint'] || process.env.OTLP_HTTP_ENDPOINT || undefined,
    grpcEndpoint: opt['grpc-endpoint'] || process.env.OTLP_GRPC_ENDPOINT || undefined,
  });
  const secs = (Date.now() - t1) / 1000;
  console.log(`[seed] sent through ingestion in ${secs.toFixed(1)} s (${Math.round((spans.length + logs.length) / secs)} rows/s)`);
  console.table(Object.fromEntries(Object.entries(report.stats).map(([p, s]) => [p, { requests: s.requests, spans: s.spans, logs: s.logs, 'avg ms/request': s.requests ? Math.round(s.ms / s.requests) : 0 }])));

  if (report.verified) {
    const v = report.verified;
    console.table({
      spans: { sent: spans.length, written: v.spans.written, dropped: v.spans.dropped },
      logs: { sent: logs.length, written: v.logs.written, dropped: v.logs.dropped },
    });
    if (!report.ok) {
      console.error('[seed] MISMATCH: the server did not store everything we sent' + (v.drained ? '.' : ' (its queue had not drained after 30 s).') +
        ' If demo services or a load generator are also sending, their rows are counted too.');
      process.exitCode = 1;
    } else {
      console.log('[seed] OK: every row sent was written by the batcher, none dropped.');
    }
  }
  printIncident(summary, num('incident-minutes', opt['incident-minutes'], 0));
}

async function main() {
  const via = opt.via;
  if (!['direct', 'http', 'http-proto', 'grpc', 'mixed'].includes(via)) {
    console.error(`--via must be one of: direct, http, http-proto, grpc, mixed (got "${via}")`);
    process.exit(1);
  }
  // validate numbers before opening anything
  num('minutes', opt.minutes, 1); num('flows-per-min', opt['flows-per-min'], 0.1);
  num('incident-minutes', opt['incident-minutes'], 0); num('seed', opt.seed, 0); num('batch-size', opt['batch-size'], 1);
  if (opt.clear) {
    await openDb();
    await clearTables();
    await db.close();
    return;
  }
  if (via === 'direct') await seedDirect();
  else await seedViaIngestion(via);
}

main().catch(async (e) => {
  console.error('[seed] failed:', e);
  try { await db.close(); } catch { /* ignore */ }
  process.exit(1);
});