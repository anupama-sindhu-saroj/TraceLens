// Retention job: deletes logs and spans older than RETENTION_DAYS, optionally archiving them to Parquet first.
//
//   const { startRetention } = require('./retention/retention');
//   const retention = startRetention();            // reads env; returns null when retention is off
//   await retention.runOnce();                     // run now (tests, manual trigger)
//   retention.stats();  retention.stop();
//
// Env: RETENTION_DAYS (unset or 0 = off, nothing is ever deleted), RETENTION_INTERVAL_MIN (default 60),
//      RETENTION_ARCHIVE_DIR (set = export old rows to <dir>/<table>-<cutoff>.parquet before deleting).
// Safety: if the archive step fails for a table, that table is NOT deleted this round (the error is kept in stats()).
// Deleting is done in chunks so other queries are not blocked for long (every DB call shares one queue).
const fs = require('node:fs');
const path = require('node:path');
const realDb = require('../db');

const DAY_MS = 86_400_000;
const TABLES = [
  { name: 'logs', timeColumn: 'time_ms' },
  { name: 'spans', timeColumn: 'start_time_ms' },
];

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

function createRetention(o = {}) {
  const db = o.db ?? realDb;
  const retentionMs = o.retentionMs ?? Number(o.retentionDays) * DAY_MS;
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error('retention needs retentionDays or retentionMs > 0');
  const intervalMs = o.intervalMs ?? 60 * 60_000;
  const initialDelayMs = o.initialDelayMs ?? 10_000;
  const archiveDir = o.archiveDir || null;
  const chunk = o.chunk ?? 50_000;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m) => console.log(`[retention] ${m}`));

  const st = { runs: 0, lastRunAt: null, lastCutoffMs: null, deleted: { logs: 0, spans: 0 }, archived: { logs: 0, spans: 0 }, lastError: null, running: false };
  let timer = null;
  let first = null;

  async function oneTable({ name, timeColumn }, cutoff) {
    const [{ n }] = await db.query(`SELECT count(*) AS n FROM ${name} WHERE ${timeColumn} < ?`, [cutoff]);
    const total = Number(n);
    if (total === 0) return;

    if (archiveDir) {
      fs.mkdirSync(archiveDir, { recursive: true });
      const file = path.resolve(archiveDir, `${name}-${new Date(cutoff).toISOString().replace(/[:.]/g, '-')}.parquet`);
      await db.exec(`COPY (SELECT * FROM ${name} WHERE ${timeColumn} < ${Number(cutoff)} ORDER BY ${timeColumn}) TO ${sqlString(file)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
      // verify the file before anything is deleted
      const [{ n: inFile }] = await db.query(`SELECT count(*) AS n FROM read_parquet(${sqlString(file)})`);
      if (Number(inFile) < total) throw new Error(`archive of ${name} is incomplete (${inFile} of ${total} rows), not deleting`);
      st.archived[name] += Number(inFile);
    }

    for (let done = 0; done < total; done += chunk) {
      await db.exec(
        `DELETE FROM ${name} WHERE rowid IN (SELECT rowid FROM ${name} WHERE ${timeColumn} < ? LIMIT ${Number(chunk)})`, [cutoff]);
      await new Promise((r) => setImmediate(r)); // let queued API queries run between chunks
    }
    const [{ n: left }] = await db.query(`SELECT count(*) AS n FROM ${name} WHERE ${timeColumn} < ?`, [cutoff]);
    const removed = total - Number(left);
    st.deleted[name] += removed;
    log(`${name}: removed ${removed} rows older than ${new Date(cutoff).toISOString()}${archiveDir ? ' (archived first)' : ''}`);
  }

  async function runOnce() {
    if (st.running) return stats();
    st.running = true;
    const cutoff = Math.floor(now() - retentionMs);
    st.lastCutoffMs = cutoff;
    let failed = null;
    for (const t of TABLES) {
      try { await oneTable(t, cutoff); } catch (e) { failed = `${t.name}: ${e.message}`; log(`failed for ${failed}`); }
    }
    try { await db.exec('CHECKPOINT'); } catch { /* not fatal: space is reused anyway */ }
    st.lastError = failed;
    st.runs++;
    st.lastRunAt = now();
    st.running = false;
    return stats();
  }

  function stats() {
    return { enabled: true, retentionDays: retentionMs / DAY_MS, archiveDir, intervalMin: intervalMs / 60_000, ...st, deleted: { ...st.deleted }, archived: { ...st.archived } };
  }

  function start() {
    if (timer) return;
    first = setTimeout(() => runOnce().catch(() => {}), initialDelayMs);
    first.unref();
    timer = setInterval(() => runOnce().catch(() => {}), intervalMs);
    timer.unref();
  }

  function stop() { clearTimeout(first); clearInterval(timer); first = null; timer = null; }

  return { runOnce, start, stop, stats };
}

// Reads env. Returns null (and does nothing) when RETENTION_DAYS is not set.
function startRetention(overrides = {}) {
  const days = Number(overrides.retentionDays ?? process.env.RETENTION_DAYS ?? 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  const r = createRetention({
    retentionDays: days,
    intervalMs: (Number(process.env.RETENTION_INTERVAL_MIN) || 60) * 60_000,
    archiveDir: process.env.RETENTION_ARCHIVE_DIR,
    ...overrides,
  });
  r.start();
  console.log(`[retention] on: keep ${days} day(s)${r.stats().archiveDir ? `, archive to ${r.stats().archiveDir}` : ', no archive'}`);
  return r;
}

module.exports = { createRetention, startRetention };