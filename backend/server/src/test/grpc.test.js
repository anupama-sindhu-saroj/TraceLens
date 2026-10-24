// gRPC ingestion tests (feature 5): npm run test:grpc -w backend/server
// Needs `npm install` first (@grpc/grpc-js, @grpc/proto-loader). No DuckDB needed: we listen on the batcher's events.
const test = require('node:test');
const assert = require('node:assert');
const grpc = require('@grpc/grpc-js');
const { startGrpcIngest, loadProto } = require('../src/ingest/grpc');
const { batcher } = require('../src/ingest/batcher');
const { parseTraces, parseLogs } = require('../src/ingest/otlp-parser');

const TID = 'a'.repeat(32), SID = 'b'.repeat(16), PID = 'c'.repeat(16);
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'payment' } }] };

// What an OTel gRPC exporter sends: ids as bytes, timestamps as fixed64.
const traceReq = {
  resourceSpans: [{ resource, scopeSpans: [{ spans: [{
    traceId: Buffer.from(TID, 'hex'), spanId: Buffer.from(SID, 'hex'), parentSpanId: Buffer.from(PID, 'hex'),
    name: 'POST /charge', kind: 2,
    startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000001800000000',
    attributes: [{ key: 'http.response.status_code', value: { intValue: '500' } }],
    status: { code: 2 },
  }] }] }],
};
const logsReq = {
  resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{
    timeUnixNano: '1700000000500000000', severityText: 'ERROR', body: { stringValue: 'payment gateway timeout' },
    traceId: Buffer.from(TID, 'hex'), spanId: Buffer.from(SID, 'hex'),
    attributes: [{ key: 'user.id', value: { stringValue: 'user-7' } }],
  }] }] }],
};

// Same request as plain JSON (what the HTTP endpoint would get): the parser must give identical rows.
const traceJson = JSON.parse(JSON.stringify(traceReq, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v)));
const logsJson = JSON.parse(JSON.stringify(logsReq, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v)));

const exportOnce = (client, req) => new Promise((resolve, reject) => client.Export(req, (err, res) => (err ? reject(err) : resolve(res))));
const next = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

test('gRPC: traces and logs reach the batcher and match the HTTP/JSON rows', async () => {
  const ingest = await startGrpcIngest({ port: 0, host: '127.0.0.1' });
  const { TraceService, LogsService } = loadProto();
  const addr = `127.0.0.1:${ingest.port}`;
  const traces = new TraceService(addr, grpc.credentials.createInsecure());
  const logs = new LogsService(addr, grpc.credentials.createInsecure());
  try {
    const gotSpans = next(batcher, 'spans');
    assert.deepStrictEqual(await exportOnce(traces, traceReq), {});
    const spans = await gotSpans;
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].service_name, 'payment');
    assert.strictEqual(spans[0].trace_id, TID);
    assert.strictEqual(spans[0].parent_span_id, PID);
    assert.strictEqual(spans[0].kind, 'SERVER');
    assert.strictEqual(spans[0].status_code, 'ERROR');
    assert.strictEqual(spans[0].http_status, 500);
    assert.strictEqual(spans[0].start_time_ms, 1700000000000);
    assert.strictEqual(spans[0].duration_ms, 1800);
    assert.deepStrictEqual(spans, parseTraces(traceJson));

    const gotLogs = next(batcher, 'logs');
    await exportOnce(logs, logsReq);
    const rows = await gotLogs;
    assert.strictEqual(rows[0].level, 'ERROR');
    assert.strictEqual(rows[0].trace_id, TID);
    assert.deepStrictEqual(rows[0].attributes, { 'user.id': 'user-7' });
    assert.deepStrictEqual(rows, parseLogs(logsJson));
  } finally {
    traces.close(); logs.close();
    await ingest.close();
  }
});

test('gRPC: a root span (no parent id) and an empty request are fine', async () => {
  const ingest = await startGrpcIngest({ port: 0, host: '127.0.0.1' });
  const { TraceService } = loadProto();
  const client = new TraceService(`127.0.0.1:${ingest.port}`, grpc.credentials.createInsecure());
  try {
    const gotSpans = next(batcher, 'spans');
    const root = JSON.parse(JSON.stringify(traceReq));
    root.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId = undefined;
    root.resourceSpans[0].scopeSpans[0].spans[0].traceId = Buffer.from(TID, 'hex');
    root.resourceSpans[0].scopeSpans[0].spans[0].spanId = Buffer.from(SID, 'hex');
    await exportOnce(client, root);
    assert.strictEqual((await gotSpans)[0].parent_span_id, null);
    assert.deepStrictEqual(await exportOnce(client, {}), {}); // empty export = success, nothing enqueued
  } finally {
    client.close();
    await ingest.close();
  }
});

test('gRPC: full queue answers UNAVAILABLE so the exporter retries', async () => {
  const ingest = await startGrpcIngest({ port: 0, host: '127.0.0.1' });
  const { TraceService } = loadProto();
  const client = new TraceService(`127.0.0.1:${ingest.port}`, grpc.credentials.createInsecure());
  const saved = batcher.maxQueue;
  batcher.maxQueue = 0;
  try {
    await assert.rejects(exportOnce(client, traceReq), (err) => err.code === grpc.status.UNAVAILABLE);
  } finally {
    batcher.maxQueue = saved;
    client.close();
    await ingest.close();
  }
});
