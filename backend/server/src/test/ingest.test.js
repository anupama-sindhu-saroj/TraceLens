const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { Batcher } = require('../src/ingest/batcher');
const { parseTraces, parseLogs, decodeTraces, decodeLogs, root } = require('../src/ingest/otlp-parser');
const { createIngestApp } = require('../src/ingest/http');

const TID = 'a'.repeat(32), SID = 'b'.repeat(16), PID = 'c'.repeat(16);
const traceJson = {
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payment' } }] },
    scopeSpans: [{ spans: [{
      traceId: TID, spanId: SID, parentSpanId: PID, name: 'POST /charge', kind: 2,
      startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001800000000',
      attributes: [{ key: 'http.response.status_code', value: { intValue: '500' } }],
      status: { code: 2 },
    }] }],
  }],
};
const logJson = {
  resourceLogs: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payment' } }] },
    scopeLogs: [{ logRecords: [{
      timeUnixNano: '1700000000500000000', severityText: 'ERROR', body: { stringValue: 'timeout' },
      traceId: TID, spanId: SID, attributes: [{ key: 'user.id', value: { stringValue: 'u1' } }],
    }] }],
  }],
};

test('parseTraces (JSON)', () => {
  const [s] = parseTraces(traceJson);
  assert.deepStrictEqual(
    { ...s, attributes: undefined },
    { trace_id: TID, span_id: SID, parent_span_id: PID, service_name: 'payment', name: 'POST /charge', kind: 'SERVER',
      start_time_ms: 1700000000000, duration_ms: 1800, status_code: 'ERROR', http_status: 500, attributes: undefined });
});

test('protobuf round trip gives the same rows as JSON', () => {
  const T = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
  const sp = traceJson.resourceSpans[0].scopeSpans[0].spans[0];
  const msg = T.fromObject({ resourceSpans: [{ resource: traceJson.resourceSpans[0].resource, scopeSpans: [{ spans: [{
    ...sp, traceId: Buffer.from(TID, 'hex'), spanId: Buffer.from(SID, 'hex'), parentSpanId: Buffer.from(PID, 'hex') }] }] }] });
  assert.deepStrictEqual(parseTraces(decodeTraces(T.encode(msg).finish())), parseTraces(traceJson));
  const L = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');
  const lr = logJson.resourceLogs[0].scopeLogs[0].logRecords[0];
  const lmsg = L.fromObject({ resourceLogs: [{ resource: logJson.resourceLogs[0].resource, scopeLogs: [{ logRecords: [{
    ...lr, traceId: Buffer.from(TID, 'hex'), spanId: Buffer.from(SID, 'hex') }] }] }] });
  assert.deepStrictEqual(parseLogs(decodeLogs(L.encode(lmsg).finish())), parseLogs(logJson));
});

test('parseLogs', () => {
  const [l] = parseLogs(logJson);
  assert.strictEqual(l.level, 'ERROR');
  assert.strictEqual(l.message, 'timeout');
  assert.strictEqual(l.trace_id, TID);
  assert.deepStrictEqual(l.attributes, { 'user.id': 'u1' });
});

test('invalid spans are skipped, empty payload is fine', () => {
  assert.deepStrictEqual(parseTraces({}), []);
  assert.strictEqual(parseTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'x' }] }] }] }).length, 0);
});

test('batcher writes to DB and emits logs event; HTTP endpoint end to end', async () => {
  await db.init(':memory:');
  const b = new Batcher({ maxBatch: 1000, flushIntervalMs: 50 });
  const seen = [];
  b.on('logs', (rows) => seen.push(...rows));
  b.start();
  b.enqueue('spans', parseTraces(traceJson));
  b.enqueue('logs', parseLogs(logJson));
  assert.strictEqual(seen.length, 1);
  await b.stop();
  assert.deepStrictEqual(b.stats().spans, { written: 1, dropped: 0 });
  const [{ n }] = await db.query('SELECT count(*) n FROM logs');
  assert.strictEqual(n, 1);

  // HTTP: JSON accepted, garbage protobuf rejected with 400
  const { batcher } = require('../src/ingest/batcher');
  const server = createIngestApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(traceJson) });
    assert.strictEqual(ok.status, 200);
    const bad = await fetch(`${base}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: Buffer.from([255, 255, 255]) });
    assert.strictEqual(bad.status, 400);
    await batcher.flush();
    const [{ m }] = await db.query("SELECT count(*) m FROM spans WHERE trace_id = ?", [TID]);
    assert.ok(m >= 1);
  } finally { server.close(); await db.close(); }
});
