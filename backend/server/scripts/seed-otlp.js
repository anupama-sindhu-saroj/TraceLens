// Seed rows -> OTLP requests (owner: B). Pure JS, no dependencies, so it can be unit tested without a server.
//
//   const { toTraceRequest, toLogRequest } = require('./seed-otlp');
//   toTraceRequest(spanRows)                      // ExportTraceServiceRequest, ids as hex strings (OTLP/JSON)
//   toTraceRequest(spanRows, { binaryIds: true }) // ids as Buffers (protobuf + gRPC)
//
// This is the reverse of src/ingest/otlp-parser.js: parseTraces(toTraceRequest(rows)) gives the rows back,
// so data seeded through HTTP/gRPC ends up identical to data seeded directly.

const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 }; // OTLP enum values
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };
const SEVERITY = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };               // OTLP severityNumber (first of each range)

// same resource attributes the demo services send (demo-services/src/telemetry.js)
const resourceFor = (service) => ({
  attributes: [
    { key: 'service.name', value: { stringValue: service } },
    { key: 'service.version', value: { stringValue: '1.0.0' } },
    { key: 'deployment.environment', value: { stringValue: 'demo' } },
  ],
});
const SCOPE = { name: 'seed-script' };

// JS value -> OTLP AnyValue. int64 goes out as a string, like real OTLP/JSON exporters do.
function anyValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => anyValue(x) ?? {}) } };
  if (v && typeof v === 'object') return { kvlistValue: { values: toKeyValues(v) } };
  return null; // null / undefined: leave the attribute out
}

function toKeyValues(obj) {
  const out = [];
  for (const [key, val] of Object.entries(obj ?? {})) {
    const value = anyValue(val);
    if (value) out.push({ key, value });
  }
  return out;
}

const msToNs = (ms) => BigInt(Math.round(ms * 1000)) * 1000n;     // ms (can be fractional) -> ns, exact to 1 microsecond
const id = (hex, binary) => (binary ? Buffer.from(hex, 'hex') : hex);

function groupByService(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.service_name)) groups.set(r.service_name, []);
    groups.get(r.service_name).push(r);
  }
  return groups;
}

function toSpan(s, binary) {
  const start = msToNs(s.start_time_ms);
  const span = {
    traceId: id(s.trace_id, binary),
    spanId: id(s.span_id, binary),
    name: s.name,
    kind: KIND[s.kind] ?? 0,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + msToNs(s.duration_ms)),
    attributes: toKeyValues(s.attributes),
    status: { code: STATUS[s.status_code] ?? 0 },
  };
  if (s.parent_span_id) span.parentSpanId = id(s.parent_span_id, binary); // root span = no parent
  return span;
}

function toLogRecord(l, binary) {
  const t = String(msToNs(l.time_ms));
  const rec = {
    timeUnixNano: t,
    observedTimeUnixNano: t,
    severityNumber: SEVERITY[l.level] ?? 9,
    severityText: l.level,
    body: { stringValue: l.message },
    attributes: toKeyValues(l.attributes),
  };
  if (l.trace_id) rec.traceId = id(l.trace_id, binary);
  if (l.span_id) rec.spanId = id(l.span_id, binary);
  return rec;
}

/** @param {import('../src/shared/types').SpanRow[]} spans */
function toTraceRequest(spans, { binaryIds = false } = {}) {
  return {
    resourceSpans: [...groupByService(spans)].map(([service, rows]) => ({
      resource: resourceFor(service),
      scopeSpans: [{ scope: SCOPE, spans: rows.map((s) => toSpan(s, binaryIds)) }],
    })),
  };
}

/** @param {import('../src/shared/types').LogRow[]} logs */
function toLogRequest(logs, { binaryIds = false } = {}) {
  return {
    resourceLogs: [...groupByService(logs)].map(([service, rows]) => ({
      resource: resourceFor(service),
      scopeLogs: [{ scope: SCOPE, logRecords: rows.map((l) => toLogRecord(l, binaryIds)) }],
    })),
  };
}

module.exports = { toTraceRequest, toLogRequest };
