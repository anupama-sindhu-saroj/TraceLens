#!/usr/bin/env node
'use strict';
// Entry point: MCP over stdio (what Claude Desktop, Claude Code, Cursor and similar clients launch).
// stdout carries the protocol, so every message for humans goes to stderr.
//
//   OBS_API_URL      base URL of the observability REST API   (default http://localhost:8080)
//   OBS_TIMEOUT_MS   per-request timeout                       (default 10000)
//   node src/index.js --check   ask the API if it is up, print the answer, exit
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createServer } = require('./server');

const baseUrl = process.env.OBS_API_URL || 'http://localhost:8080';
const timeoutMs = Number(process.env.OBS_TIMEOUT_MS) || 10_000;
const log = (...a) => console.error('[mcp]', ...a);

async function main() {
  const { server, api } = createServer({ baseUrl, timeoutMs });

  if (process.argv.includes('--check')) {
    try {
      const h = await api.get('/api/health');
      log(`API ok at ${api.baseUrl}: ${h.spans} spans stored`);
      process.exit(0);
    } catch (e) {
      log(`API check failed: ${e.message}`);
      process.exit(1);
    }
  }

  await server.connect(new StdioServerTransport());
  log(`ready, using API ${api.baseUrl}`);
  // A missing backend is not fatal: each tool call explains it. Just say so once, early.
  api.get('/api/health').catch((e) => log(`warning: ${e.message}`));

  const stop = async () => { try { await server.close(); } finally { process.exit(0); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { log('fatal:', e); process.exit(1); });
