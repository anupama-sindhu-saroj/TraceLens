'use strict';
// MCP resources: read-only documents a client can attach to a conversation without the model calling a tool first.
//   tracelens://health            service health, last 15 minutes
//   tracelens://anomalies         anomalies of the last hour
//   tracelens://topology          dependency graph, last 15 minutes
//   tracelens://trace/{traceId}   one trace as a call tree with its logs
const { ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const D = require('./data');

function registerResources(server, api) {
  const text = (uri, body) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: body }] });

  server.registerResource('service-health', 'tracelens://health', {
    title: 'Service health (last 15 minutes)',
    description: 'Requests, error rate, latency and a health verdict for every service, plus recent anomalies.',
    mimeType: 'text/plain',
  }, async (uri) => text(uri, (await D.healthReport(api, { minutes: 15 })).text));

  server.registerResource('recent-anomalies', 'tracelens://anomalies', {
    title: 'Anomalies (last hour)',
    description: 'Detector alarms of the last hour with severity, root-cause service and sample trace ids.',
    mimeType: 'text/plain',
  }, async (uri) => text(uri, (await D.anomalyList(api, { minutes: 60, limit: 20 })).text));

  server.registerResource('topology', 'tracelens://topology', {
    title: 'Service topology (last 15 minutes)',
    description: 'Which service calls which, with call counts, error rates and latency per connection.',
    mimeType: 'text/plain',
  }, async (uri) => text(uri, (await D.topologyReport(api, { minutes: 15 })).text));

  server.registerResource('trace', new ResourceTemplate('tracelens://trace/{traceId}', { list: undefined }), {
    title: 'A trace',
    description: 'One request through all services as a call tree with its logs. Replace {traceId} with a trace id.',
    mimeType: 'text/plain',
  }, async (uri, variables) => text(uri, (await D.traceDetail(api, { traceId: String(variables.traceId) })).text));
}

module.exports = { registerResources };
