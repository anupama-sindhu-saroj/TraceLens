#!/usr/bin/env node
'use strict';
// Smoke test for a RUNNING backend: starts the MCP server as a child process over stdio (exactly how Claude Desktop does it),
// calls every tool once and prints what an AI agent would see. Exit code 1 if any tool fails.
//   npm run smoke -w mcp-server                    (OBS_API_URL=http://localhost:8080 by default)
//   npm run smoke -w mcp-server -- --full          untruncated output
//   npm run smoke -w mcp-server -- --trace <id>    show that trace
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const apiUrl = process.env.OBS_API_URL || 'http://localhost:8080';
const full = process.argv.includes('--full');

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'index.js')],
    env: { ...process.env, OBS_API_URL: apiUrl },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  let failed = 0;

  const { tools } = await client.listTools();
  console.log(`Connected over stdio. Tools: ${tools.map((t) => t.name).join(', ')}\n`);

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const out = r.content.map((c) => c.text).join('\n');
    if (r.isError) failed += 1;
    const lines = out.split('\n');
    const shown = full || lines.length <= 14 ? out : `${lines.slice(0, 14).join('\n')}\n   ... (${lines.length - 14} more lines)`;
    console.log(`--- ${r.isError ? 'FAIL' : 'ok  '} ${name} ${JSON.stringify(args)}\n${shown}\n`);
    return { out, isError: !!r.isError };
  };

  await call('get_service_health', { minutes: 15 });
  const an = await call('list_anomalies', { minutes: 240 });
  const id = (an.out.match(/^(\S+)\s+\[(?:WARNING|CRITICAL)\]/m) || [])[1];
  if (id) await call('explain_anomaly', { anomaly_id: id });
  else console.log('(no anomalies yet: skipping explain_anomaly)\n');
  const slow = await call('search_traces', { sort: 'slowest', minutes: 60, limit: 3 });
  // --trace <id> picks the trace; otherwise an anomaly's sample trace; otherwise the slowest trace of the last hour.
  const flag = process.argv.indexOf('--trace');
  const tid = (flag > 0 && process.argv[flag + 1])
    || (an.out.match(/sample traces: ([0-9a-f]{16,})/) || [])[1]
    || (slow.out.match(/^([0-9a-f]{32})\s/m) || [])[1];
  if (tid) await call('get_trace', { trace_id: tid });
  else console.log('(no traces yet: skipping get_trace)\n');
  await call('search_logs', { level: ['ERROR', 'WARN'], minutes: 60, limit: 5 });
  await call('get_topology', { minutes: 15 });

  await client.close();
  console.log(failed ? `${failed} tool call(s) failed.` : 'All tool calls succeeded.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });