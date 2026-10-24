// Tests for seeding through the ingestion endpoints: npm run test:seed-ingest -w backend/server
//  1. converter round trip (rows -> OTLP -> parser -> same rows), JSON and protobuf encodings
//  2. real HTTP + gRPC servers on random ports, in-memory DuckDB: every path stores the same data as a direct insert
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { batcher } = require('../src/ingest/batcher');
const { parseTraces, parseLogs, decodeTraces, decodeLogs, root } = require('../src/ingest/otlp-parser');
const { createIngestApp } = require('../src/ingest/http');
const { startGrpcIngest } = require('../src/ingest/grpc');
const { generate } = require('../scripts/seed-data');
const { toTraceRequest, toLogRequest } = require('../scripts/seed-otlp');
const { sendThroughIngestion } = require('../scripts/seed-ingest');

const data = generate({ now: 1_800_000_000_000, minutes: 5, flowsPerMin: 8, incidentMinutes: 2, seed: 11, anomalies: false });

// parser output order differs from seed order (grouped by service), so compare as sorted sets with sorted keys
const canon = (row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));
const asSet = (rows) => rows.map(canon).sort();

test('JSON: parseTraces/parseLogs give back exactly the seed rows', () => {
  assert.deepStrictEqual(asSet(parseTraces(toTraceRequest(data.spans))), asSet(data.spans));
  assert.deepStrictEqual(asSet(parseLogs(toLogRequest(data.logs))), asSet(data.logs));
});

test('protobuf: encode -> decode -> parse gives back exactly the seed rows', () => {
  const T = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
  const L = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');
  const spans = parseTraces(decodeTraces(T.encode(T.fromObject(toTraceRequest(data.spans, { binaryIds: true }))).finish()));
  const logs = parseLogs(decodeLogs(L.encode(L.fromObject(toLogRequest(data.logs, { binaryIds: true }))).finish()));
  assert.deepStrictEqual(asSet(spans), asSet(data.spans));
  assert.deepStrictEqual(asSet(logs), asSet(data.logs));
});

test('every path (http, http-proto, grpc, mixed) stores the same data as a direct insert', async () => {
  await db.init(':memory:');
  const http = createIngestApp().listen(0);
  const grpcIngest = await startGrpcIngest({ port: 0, host: '127.0.0.1' });
  const httpEndpoint = `http://127.0.0.1:${http.address().port}`;
  const grpcEndpoint = `127.0.0.1:${grpcIngest.port}`;
  const perService = async (table) => Object.fromEntries((await db.query(`SELECT service_name, count(*) AS n FROM ${table} GROUP BY 1`)).map((r) => [r.service_name, r.n]));
  const expect = (rows) => rows.reduce((m, r) => ({ ...m, [r.service_name]: (m[r.service_name] ?? 0) + 1 }), {});

  try {
    // reference: what a direct seed produces
    await db.insertSpans(data.spans); await db.insertLogs(data.logs);
    const refSpans = await perService('spans'), refLogs = await perService('logs');
    const [ref] = await db.query('SELECT sum(duration_ms) AS d, sum(http_status) AS h, count(DISTINCT trace_id) AS t FROM spans');
    assert.deepStrictEqual(refSpans, expect(data.spans));

    for (const via of ['http', 'http-proto', 'grpc', 'mixed']) {
      await db.exec('DELETE FROM spans'); await db.exec('DELETE FROM logs');
      // no REST API in this test (api: null): flush ourselves, then look at the tables
      await sendThroughIngestion({ via, spans: data.spans, logs: data.logs, batchSize: 100, api: null, httpEndpoint, grpcEndpoint, log: () => {} });
      await batcher.flush();
      assert.deepStrictEqual(await perService('spans'), refSpans, `${via}: spans per service`);
      assert.deepStrictEqual(await perService('logs'), refLogs, `${via}: logs per service`);
      const [got] = await db.query('SELECT sum(duration_ms) AS d, sum(http_status) AS h, count(DISTINCT trace_id) AS t FROM spans');
      assert.ok(Math.abs(got.d - ref.d) < 0.01, `${via}: total duration ${got.d} vs ${ref.d}`);
      assert.strictEqual(got.h, ref.h, `${via}: http statuses`);
      assert.strictEqual(got.t, ref.t, `${via}: traces`);
    }
  } finally {
    http.close(); await grpcIngest.close(); await batcher.stop(); await db.close();
  }
});
