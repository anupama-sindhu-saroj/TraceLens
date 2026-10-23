// OpenTelemetry bootstrap. Must be loaded first in every service file
// (via ./instrument/<service>) so the instrumentations patch http/express/fetch.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation, ExpressLayerType } = require('@opentelemetry/instrumentation-express');
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
const { OTLPTraceExporter: TraceHttpJson } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPTraceExporter: TraceHttpProto } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPTraceExporter: TraceGrpc } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPLogExporter: LogHttpJson } = require('@opentelemetry/exporter-logs-otlp-http');
const { OTLPLogExporter: LogHttpProto } = require('@opentelemetry/exporter-logs-otlp-proto');
const { OTLPLogExporter: LogGrpc } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { endpoints, protocolFor } = require('./config');

function initTelemetry(service) {
  const protocol = protocolFor(service);

  let traceExporter;
  let logExporter;
  if (protocol === 'grpc') {
    // gRPC exporters read the endpoint as a plain URL (no path)
    traceExporter = new TraceGrpc({ url: endpoints.grpc });
    logExporter = new LogGrpc({ url: endpoints.grpc });
  } else if (protocol === 'proto') {
    traceExporter = new TraceHttpProto({ url: `${endpoints.http}/v1/traces` });
    logExporter = new LogHttpProto({ url: `${endpoints.http}/v1/logs` });
  } else {
    traceExporter = new TraceHttpJson({ url: `${endpoints.http}/v1/traces` });
    logExporter = new LogHttpJson({ url: `${endpoints.http}/v1/logs` });
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': service,
      'service.version': '1.0.0',
      'deployment.environment': 'demo',
    }),
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, { scheduledDelayMillis: 1000, maxExportBatchSize: 256 }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: logExporter, scheduledDelayMillis: 1000, maxExportBatchSize: 256 }),
    ],
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }), // skip noisy per-middleware spans
      new UndiciInstrumentation(), // makes fetch() calls create client spans + propagate trace context
    ],
  });
  sdk.start();

  const shutdown = async () => {
    try {
      await sdk.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${service}] telemetry started (exporter: ${protocol})`);
  return sdk;
}

module.exports = { initTelemetry };
