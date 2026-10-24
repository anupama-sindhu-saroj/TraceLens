// Shared contract between A and B (tell the other person before changing). Plain JS, so types are JSDoc.
// Row shapes MATCH db/schema.sql column names exactly: parser output -> batcher -> db.insertX() with no mapping.

/**
 * @typedef {Object} SpanRow
 * @property {string} trace_id         32 hex chars
 * @property {string} span_id          16 hex chars
 * @property {string|null} [parent_span_id]  null for root
 * @property {string} service_name
 * @property {string} name
 * @property {'SERVER'|'CLIENT'|'INTERNAL'|'PRODUCER'|'CONSUMER'|null} [kind]
 * @property {number} start_time_ms    epoch ms
 * @property {number} duration_ms
 * @property {'OK'|'ERROR'|'UNSET'|null} [status_code]
 * @property {number|null} [http_status]
 * @property {Object|string|null} [attributes]   object (stringified on insert)
 *
 * @typedef {Object} LogRow
 * @property {number} time_ms
 * @property {string} service_name
 * @property {'DEBUG'|'INFO'|'WARN'|'ERROR'} level
 * @property {string} message
 * @property {string|null} [trace_id]
 * @property {string|null} [span_id]
 * @property {Object|string|null} [attributes]   dynamic tags: user.id, order.id, payment.id, sku
 *
 * @typedef {Object} AnomalyRow
 * @property {string} id
 * @property {number} detected_at_ms
 * @property {string} service_name
 * @property {'p99_latency'|'error_rate'} metric
 * @property {number} baseline
 * @property {number} current
 * @property {number|null} [ratio]
 * @property {'WARNING'|'CRITICAL'} severity
 * @property {string|null} [root_cause]
 * @property {Object|string|null} [details]
 */

const SERVICES = ['gateway', 'cart', 'inventory', 'payment'];
const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const SPAN_KINDS = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']; // index = OTLP enum
const STATUS_CODES = ['UNSET', 'OK', 'ERROR'];                                              // index = OTLP enum

module.exports = { SERVICES, LEVELS, SPAN_KINDS, STATUS_CODES };
