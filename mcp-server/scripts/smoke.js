#!/usr/bin/env node
'use strict';
// Smoke test for a RUNNING backend. It connects the way a real client does, calls every tool once, reads the resources and
// prints what an AI would see. Exit code 1 if anything fails (a tool error, or a tool answer without structured JSON).
//
//   npm run smoke -w mcp-server                                      stdio: starts the MCP server as a child process
//   npm run smoke -w mcp-server -- --url http://127.0.0.1:8081/mcp   HTTP: talks to a running  npm run mcp:http  server
//        (set OBS_MCP_TOKEN=... when that server uses a token)
//   --full             untruncated output
//   --trace <id>       show that trace instead of an automatic pick
//   OBS_API_URL        REST API for the child process in stdio mode (default http://localhost:8080)
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const full = argv.includes('--full');
const url = flag('--url');
const apiUrl = process.env.OBS_API_URL || 'http://localhost:8080';

async function main() {
  const token = process.env.OBS_MCP_TOKEN;
  const transport = url
    ? new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } })
    : new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'src', 'index.js')],
      env: { ...process.env, OBS_API_URL: apiUrl },
      stderr: 'inherit',
    });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  let failed = 0;

  const { tools } = await client.listTools();
  const v = client.getServerVersion();
  console.log(`Connected over ${url ? `HTTP (${url})` : 'stdio'} to "${v.name}" ${v.version}. Tools: ${tools.map((t) => t.name).join(', ')}\n`);

  const show = (label, out) => {
    const lines = out.split('\n');
    return full || lines.length <= 14 ? out : `${lines.slice(0, 14).join('\n')}\n   ... (${lines.length - 14} more lines)`;
  };

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const out = r.content.map((c) => c.text).join('\n');
    let bad = !!r.isError;
    let note = '';
    if (!r.isError && !r.structuredContent) { bad = true; note = '  (no structured JSON in the answer!)'; }
    if (bad) failed += 1;
    console.log(`--- ${bad ? 'FAIL' : 'ok  '} ${name} ${JSON.stringify(args)}${note}\n${show(name, out)}\n`);
    return { out, isError: bad, data: r.structuredContent };
  };

  await call('get_service_health', { minutes: 15 });
  const an = await call('list_anomalies', { minutes: 240 });
  const id = (an.out.match(/^(\S+)\s+\[(?:WARNING|CRITICAL)\]/m) || [])[1];
  if (id) await call('explain_anomaly', { anomaly_id: id });
  else console.log('(no anomalies yet: skipping explain_anomaly)\n');
  const slow = await call('search_traces', { sort: 'slowest', minutes: 60, limit: 3 });
  // --trace <id> picks the trace; otherwise an anomaly's sample trace; otherwise the slowest trace of the last hour.
  const tid = flag('--trace')
    || (an.out.match(/sample traces: ([0-9a-f]{16,})/) || [])[1]
    || (slow.out.match(/^([0-9a-f]{32})\s/m) || [])[1];
  if (tid) await call('get_trace', { trace_id: tid });
  else console.log('(no traces yet: skipping get_trace)\n');
  await call('search_logs', { level: ['ERROR', 'WARN'], minutes: 60, limit: 5 });
  await call('get_topology', { minutes: 15 });

  // resources
  try {
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    console.log(`--- ok   resources: ${resources.map((r) => r.uri).join(', ')}; templates: ${resourceTemplates.map((t) => t.uriTemplate).join(', ')}`);
    const r = await client.readResource({ uri: 'tracelens://health' });
    console.log(`${show('resource', r.contents[0].text)}\n`);
  } catch (e) {
    failed += 1;
    console.log(`--- FAIL resources: ${e.message}\n`);
  }

  await client.close();
  console.log(failed ? `${failed} check(s) failed.` : 'All checks succeeded.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });
