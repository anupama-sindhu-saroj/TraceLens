// OTLP -> DB rows (feature 4, owner: A). Shared with B's gRPC server.
//
//   parseTraces(req) / parseLogs(req)   req = ExportTraceServiceRequest / ExportLogsServiceRequest
//                                       as a plain object (OTLP/JSON body, OR protobuf decoded via decodeTraces/decodeLogs
//                                       OR the object grpc-js hands you after proto-loader decoding).
//   decodeTraces(buf) / decodeLogs(buf) protobuf bytes -> req object (for application/x-protobuf over HTTP)
//
// Returns arrays of SpanRow / LogRow (see shared/types.js) ready for batcher.enqueue().
const path = require('node:path');
const protobuf = require('protobufjs');
const { SPAN_KINDS, STATUS_CODES } = require('../shared/types');

const PROTO_DIR = path.join(__dirname, '..', '..', 'proto');
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(PROTO_DIR, target));
root.loadSync([
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
  'opentelemetry/proto/collector/logs/v1/logs_service.proto',
].map((f) => path.join(PROTO_DIR, f)));
const TraceReq = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest');
const LogsReq = root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest');

const TO_OBJECT = { longs: String, enums: Number, defaults: false, arrays: true };

function decodeTraces(buf) { return TraceReq.toObject(TraceReq.decode(buf), TO_OBJECT); }
function decodeLogs(buf) { return LogsReq.toObject(LogsReq.decode(buf), TO_OBJECT); }

// ---- helpers ---------------------------------------------------------------

// ids: JSON gives hex strings; protobuf / grpc give bytes. Always return lowercase hex (or null if empty/all-zero).
function idHex(v) {
  if (v === undefined || v === null) return null;
  const hex = typeof v === 'string' ? v : Buffer.from(v).toString('hex');
  return hex && /[^0]/.test(hex) ? hex.toLowerCase() : null;
}

// nanosecond timestamps arrive as string | number | Long-like {low,high,unsigned}
function nanos(v) {
  if (v === undefined || v === null || v === '') return 0n;
  if (typeof v === 'object' && 'low' in v) return (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
  try { return BigInt(v); } catch { return 0n; }
}
// Strict OTLP id check: trace id = 32 hex chars, span id = 16 hex chars (idHex already lowercases / nulls all-zero).
const isHexId = (id, len) => typeof id === 'string' && id.length === len && /^[0-9a-f]+$/.test(id);

const nsToMs = (ns) => Number(ns / 1000n) / 1000; // keeps sub-ms precision

function anyValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return Buffer.from(v.bytesValue, typeof v.bytesValue === 'string' ? 'base64' : undefined).toString('hex');
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values);
  return null;
}

function attrsToObject(list) {
  const out = {};
  for (const kv of list ?? []) if (kv?.key) out[kv.key] = anyValue(kv.value);
  return out;
}

const serviceOf = (resource) => String(attrsToObject(resource?.attributes)['service.name'] ?? 'unknown');

function normLevel(text, num) {
  const t = String(text ?? '').toUpperCase();
  if (t === 'WARNING') return 'WARN';
  if (t === 'FATAL' || t === 'CRITICAL') return 'ERROR';
  if (t === 'TRACE') return 'DEBUG';
  if (['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(t)) return t;
  const n = Number(num ?? 0);
  if (n >= 17) return 'ERROR';
  if (n >= 13) return 'WARN';
  if (n >= 9) return 'INFO';
  if (n >= 1) return 'DEBUG';
  return 'INFO';
}

// OTLP/JSON may send enums as numbers or as names ("SPAN_KIND_SERVER", "STATUS_CODE_ERROR")
function enumName(v, names, prefix) {
  if (typeof v === 'string') {
    const s = v.replace(prefix, '');
    return names.includes(s) ? s : null;
  }
  return names[Number(v ?? 0)] ?? null;
}

// ---- parsers ---------------------------------------------------------------

// Returns { rows, rejected }: spans with a missing / malformed trace id, span id or parent id are counted in `rejected`
// (so the receiver can report OTLP partial_success) instead of vanishing silently.
function parseTracesDetailed(req) {
  const rows = [];
  let rejected = 0;
  for (const rs of req?.resourceSpans ?? []) {
    const service = serviceOf(rs.resource);
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        const traceId = idHex(sp.traceId);
        const spanId = idHex(sp.spanId);
        const parentId = idHex(sp.parentSpanId);
        if (!isHexId(traceId, 32) || !isHexId(spanId, 16) || (parentId !== null && !isHexId(parentId, 16))) {
          rejected++;
          continue;
        }
        const start = nanos(sp.startTimeUnixNano);
        const end = nanos(sp.endTimeUnixNano);
        const attrs = attrsToObject(sp.attributes);
        const http = attrs['http.response.status_code'] ?? attrs['http.status_code'];
        const kind = enumName(sp.kind, SPAN_KINDS, 'SPAN_KIND_');
        rows.push({
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentId,
          service_name: service,
          name: sp.name || '(unnamed)',
          kind: kind === 'UNSPECIFIED' ? null : kind,
          start_time_ms: Math.floor(nsToMs(start)),
          duration_ms: end > start ? nsToMs(end - start) : 0,
          status_code: enumName(sp.status?.code, STATUS_CODES, 'STATUS_CODE_') ?? 'UNSET',
          http_status: http !== undefined && http !== null && Number.isFinite(Number(http)) ? Number(http) : null,
          attributes: attrs,
        });
      }
    }
  }
  return { rows, rejected };
}

const parseTraces = (req) => parseTracesDetailed(req).rows;

// Protobuf bytes for an ExportTraceServiceResponse that reports rejected spans (OTLP partial_success).
const TraceRes = root.lookupType('opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse');
function encodeTraceResponse(rejected, errorMessage) {
  return Buffer.from(TraceRes.encode(TraceRes.create({ partialSuccess: { rejectedSpans: rejected, errorMessage } })).finish());
}

function parseLogs(req) {
  const rows = [];
  for (const rl of req?.resourceLogs ?? []) {
    const service = serviceOf(rl.resource);
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const t = nanos(lr.timeUnixNano) || nanos(lr.observedTimeUnixNano);
        const body = anyValue(lr.body);
        rows.push({
          time_ms: t ? Math.floor(nsToMs(t)) : Date.now(),
          service_name: service,
          level: normLevel(lr.severityText, lr.severityNumber),
          message: typeof body === 'string' ? body : JSON.stringify(body),
          trace_id: idHex(lr.traceId),
          span_id: idHex(lr.spanId),
          attributes: attrsToObject(lr.attributes),
        });
      }
    }
  }
  return rows;
}

module.exports = { parseTraces, parseTracesDetailed, encodeTraceResponse, parseLogs, decodeTraces, decodeLogs, root };
