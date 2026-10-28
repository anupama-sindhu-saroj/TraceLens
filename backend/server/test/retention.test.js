const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/db');
const { createRetention, startRetention } = require('../src/retention/retention');

const DAY = 86_400_000;
const quiet = () => {};

async function seed() {
  const t = Date.now();
  await db.init(':memory:');
  await db.insertLogs([
    { time_ms: t - 10 * DAY, service_name: 'a', level: 'INFO', message: 'old1' },
    { time_ms: t - 9 * DAY, service_name: 'a', level: 'INFO', message: 'old2' },
    { time_ms: t - 1 * DAY, service_name: 'a', level: 'INFO', message: 'recent' },
    { time_ms: t, service_name: 'a', level: 'INFO', message: 'now' },
  ]);
  await db.insertSpans([
    { trace_id: 'old', span_id: 's1', service_name: 'a', name: 'n', start_time_ms: t - 10 * DAY, duration_ms: 1 },
    { trace_id: 'new', span_id: 's2', service_name: 'a', name: 'n', start_time_ms: t - 1000, duration_ms: 1 },
  ]);
}
const messages = async () => (await db.query('SELECT message FROM logs ORDER BY time_ms')).map((r) => r.message);

test('deletes rows older than the retention period and keeps recent ones', async () => {
  await seed();
  const r = createRetention({ retentionDays: 7, log: quiet });
  const st = await r.runOnce();
  assert.deepStrictEqual(await messages(), ['recent', 'now']);
  assert.deepStrictEqual((await db.query('SELECT trace_id FROM spans')).map((x) => x.trace_id), ['new']);
  assert.deepStrictEqual(st.deleted, { logs: 2, spans: 1 });
  assert.strictEqual(st.lastError, null);
  await db.close();
});

test('a second run with nothing old deletes nothing', async () => {
  await seed();
  const r = createRetention({ retentionDays: 7, log: quiet });
  await r.runOnce();
  const st = await r.runOnce();
  assert.deepStrictEqual(st.deleted, { logs: 2, spans: 1 });
  assert.strictEqual(st.runs, 2);
  await db.close();
});

test('deletes in several chunks when there are more old rows than the chunk size', async () => {
  await seed();
  const t = Date.now();
  await db.insertLogs(Array.from({ length: 250 }, (_, i) => ({ time_ms: t - 20 * DAY + i, service_name: 'a', level: 'INFO', message: `bulk${i}` })));
  const r = createRetention({ retentionDays: 7, chunk: 100, log: quiet });
  const st = await r.runOnce();
  assert.strictEqual(st.deleted.logs, 252);
  assert.deepStrictEqual(await messages(), ['recent', 'now']);
  await db.close();
});

test('archive: old rows are written to Parquet BEFORE they are deleted', async () => {
  await seed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-archive-'));
  const r = createRetention({ retentionDays: 7, archiveDir: dir, log: quiet });
  const st = await r.runOnce();
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('logs-') && f.endsWith('.parquet')));
  assert.ok(files.some((f) => f.startsWith('spans-') && f.endsWith('.parquet')));
  assert.deepStrictEqual(st.archived, { logs: 2, spans: 1 });
  const file = path.join(dir, files.find((f) => f.startsWith('logs-')));
  const archived = await db.query(`SELECT message FROM read_parquet('${file}') ORDER BY message`);
  assert.deepStrictEqual(archived.map((x) => x.message), ['old1', 'old2']);
  assert.deepStrictEqual(await messages(), ['recent', 'now']);
  fs.rmSync(dir, { recursive: true, force: true });
  await db.close();
});

test('archive failure: nothing is deleted and the error is reported', async () => {
  await seed();
  const blocker = path.join(os.tmpdir(), `tl-not-a-dir-${Date.now()}`);
  fs.writeFileSync(blocker, 'x'); // a FILE where the archive directory should be -> the export cannot work
  const r = createRetention({ retentionDays: 7, archiveDir: path.join(blocker, 'sub'), log: quiet });
  const st = await r.runOnce();
  assert.deepStrictEqual(await messages(), ['old1', 'old2', 'recent', 'now']);
  assert.ok(st.lastError);
  assert.deepStrictEqual(st.deleted, { logs: 0, spans: 0 });
  fs.rmSync(blocker, { force: true });
  await db.close();
});

test('off by default: startRetention does nothing without RETENTION_DAYS; invalid config is rejected', () => {
  const saved = process.env.RETENTION_DAYS;
  delete process.env.RETENTION_DAYS;
  assert.strictEqual(startRetention(), null);
  assert.throws(() => createRetention({ retentionDays: 0 }));
  if (saved !== undefined) process.env.RETENTION_DAYS = saved;
});
