-- DuckDB schema (feature 7, owner: A). Shared contract with B: tell the other person before changing.
-- Times are epoch MILLISECONDS (BIGINT) so they are JSON friendly and easy to bucket:
--   (start_time_ms // 5000) * 5000  => 5 second bucket.
-- attributes columns hold a JSON object as text; read with json_extract_string(attributes, '$.user.id')
-- or use the key as written: json_extract_string(attributes, '$."user.id"').

CREATE TABLE IF NOT EXISTS spans (
  trace_id        VARCHAR NOT NULL,
  span_id         VARCHAR NOT NULL,
  parent_span_id  VARCHAR,            -- NULL for root span
  service_name    VARCHAR NOT NULL,
  name            VARCHAR NOT NULL,   -- e.g. "POST /api/checkout"
  kind            VARCHAR,            -- SERVER | CLIENT | INTERNAL | PRODUCER | CONSUMER
  start_time_ms   BIGINT  NOT NULL,
  duration_ms     DOUBLE  NOT NULL,
  status_code     VARCHAR,            -- OK | ERROR | UNSET
  http_status     INTEGER,            -- http.response.status_code, if present
  attributes      VARCHAR             -- JSON text
);

CREATE TABLE IF NOT EXISTS logs (
  time_ms         BIGINT  NOT NULL,
  service_name    VARCHAR NOT NULL,
  level           VARCHAR NOT NULL,   -- DEBUG | INFO | WARN | ERROR
  message         VARCHAR NOT NULL,
  trace_id        VARCHAR,
  span_id         VARCHAR,
  attributes      VARCHAR             -- JSON text (user.id, order.id, ...)
);

CREATE TABLE IF NOT EXISTS anomalies (
  id               VARCHAR PRIMARY KEY,
  detected_at_ms   BIGINT  NOT NULL,
  service_name     VARCHAR NOT NULL,
  metric           VARCHAR NOT NULL,  -- p99_latency | error_rate
  baseline         DOUBLE  NOT NULL,
  current          DOUBLE  NOT NULL,
  ratio            DOUBLE,            -- current / baseline
  severity         VARCHAR NOT NULL,  -- WARNING | CRITICAL
  root_cause       VARCHAR,           -- filled by B's findRootCause()
  details          VARCHAR            -- JSON text
);

CREATE INDEX IF NOT EXISTS idx_spans_trace   ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_start   ON spans(start_time_ms);
CREATE INDEX IF NOT EXISTS idx_logs_time     ON logs(time_ms);
CREATE INDEX IF NOT EXISTS idx_logs_trace    ON logs(trace_id);
