'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { createClient } = require('./client');
const { registerTools, registerPrompts } = require('./tools');

const VERSION = require('../package.json').version;

function createServer({ client, baseUrl, timeoutMs } = {}) {
  const api = client ?? createClient({ baseUrl, timeoutMs });
  const server = new McpServer(
    { name: 'observability-engine', version: VERSION },
    {
      instructions:
        'Read-only access to a self-hosted observability platform (traces, logs, service health, anomalies, topology) for a small shop with the services gateway, cart, inventory and payment. '
        + 'Typical flow: get_service_health -> list_anomalies -> explain_anomaly -> get_trace -> search_logs. '
        + 'Times are ISO 8601 in UTC; most tools take "minutes" to look back from now.',
    },
  );
  registerTools(server, api);
  registerPrompts(server);
  return { server, api };
}

module.exports = { createServer };
