// Structured logger: writes to console AND emits an OTel log record.
// Log records automatically carry trace_id/span_id if called inside an active span.
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const SEVERITY = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

function createLogger(service) {
  const otel = logs.getLogger(service);
  const emit = (level, message, attrs = {}) => {
    otel.emit({
      severityNumber: SEVERITY[level],
      severityText: level,
      body: message,
      attributes: attrs,
    });
    console.log(`[${service}] ${level} ${message}${Object.keys(attrs).length ? ' ' + JSON.stringify(attrs) : ''}`);
  };
  return {
    debug: (m, a) => emit('DEBUG', m, a),
    info: (m, a) => emit('INFO', m, a),
    warn: (m, a) => emit('WARN', m, a),
    error: (m, a) => emit('ERROR', m, a),
  };
}

module.exports = { createLogger };
