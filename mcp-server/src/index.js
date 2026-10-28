#!/usr/bin/env node
'use strict';
// Entry point. Two ways to run the same tools:
//   stdio (default)   a desktop AI client (Claude Desktop, Claude Code, Cursor) starts this program and talks through stdin/stdout.
//   --http            a long-running web service at POST http://host:port/mcp that many clients can share (Docker, a team server).
// In stdio mode stdout carries the protocol, so every message for humans goes to stderr.
//
//   OBS_API_URL            base URL of the TraceLens REST API              (default http://localhost:8080)
//   OBS_TIMEOUT_MS         per-request timeout                              (default 10000)
//   OBS_MCP_TRANSPORT      stdio | http                                     (default stdio; --http is the same as http)
//   OBS_MCP_HOST / PORT    HTTP bind address and port                       (default 127.0.0.1 and 8081; --host, --port)
//   OBS_MCP_TOKEN          bearer token for HTTP (required unless bound to 127.0.0.1)
//   OBS_MCP_ALLOWED_ORIGINS  comma list of extra browser Origins allowed for HTTP
//   OBS_MCP_ALLOWED_HOSTS    comma list of extra Host names allowed on a loopback bind (reverse proxy)
//   node src/index.js --check   ask the API if it is up, print the answer, exit
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('./server');
const { startHttp } = require('./http');

const baseUrl = process.env.OBS_API_URL || 'http://localhost:8080';
const timeoutMs = Number(process.env.OBS_TIMEOUT_MS) || 10_000;
const log = (...a) => console.error('[mcp]', ...a);

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

async function main() {
  const { server, api } = createServer({ baseUrl, timeoutMs });

  if (argv.includes('--check')) {
    try {
      const h = await api.get('/api/health');
      log(`API ok at ${api.baseUrl}: ${h.spans} spans stored`);
      process.exit(0);
    } catch (e) {
      log(`API check failed: ${e.message}`);
      process.exit(1);
    }
  }

  const useHttp = argv.includes('--http') || process.env.OBS_MCP_TRANSPORT === 'http';
  if (useHttp) {
    const token = process.env.OBS_MCP_TOKEN || '';
    const http = await startHttp({
      host: flag('--host') || process.env.OBS_MCP_HOST || '127.0.0.1',
      port: Number(flag('--port') || process.env.OBS_MCP_PORT || 8081),
      token,
      apiUrl: baseUrl,
      timeoutMs,
      allowedOrigins: list(process.env.OBS_MCP_ALLOWED_ORIGINS),
      allowedHosts: list(process.env.OBS_MCP_ALLOWED_HOSTS),
    });
    log(`HTTP ready at ${http.url}  (auth: ${token ? 'bearer token' : 'none, loopback only'}), using API ${api.baseUrl}`);
    api.get('/api/health').catch((e) => log(`warning: ${e.message}`));
    const stop = async () => { await http.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  await server.connect(new StdioServerTransport());
  log(`ready (stdio), using API ${api.baseUrl}`);
  // A missing backend is not fatal: each tool call explains it. Just say so once, early.
  api.get('/api/health').catch((e) => log(`warning: ${e.message}`));

  const stop = async () => { try { await server.close(); } finally { process.exit(0); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { log('fatal:', e.message); process.exit(1); });
