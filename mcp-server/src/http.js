'use strict';
// MCP over Streamable HTTP: the same tools as the stdio server, reachable at  POST http://host:port/mcp
// so one running server can serve a whole team (or a Docker container) instead of every laptop starting its own copy.
//
// Stateless: every request gets its own short-lived MCP server, which suits read-only tools and means any number of
// clients can connect without sessions. Responses are plain JSON (no SSE stream), which also makes curl testing easy.
//
// Safety (this is a network service in front of your operational data):
//   * binds to 127.0.0.1 by default, and refuses to listen on any other address without a token
//   * Authorization: Bearer <token> is required whenever a token is configured (constant-time comparison)
//   * browser requests must come from an allowed Origin, and on a loopback bind the Host header must be loopback too
//     (stops a malicious web page from reaching a local server through DNS rebinding)
//   * request bodies are capped, and every tool is read-only
const http = require('node:http');
const crypto = require('node:crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createServer, NAME, VERSION } = require('./server');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const isLoopback = (host) => LOOPBACK_HOSTS.has(String(host)) || /^127\./.test(String(host));

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  const wanted = Buffer.from(token);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '');
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:8081
  return h.split(':')[0];
}

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const rpcError = (res, status, code, message, headers) => send(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the HTTP server.
 * @param {object} o
 * @param {string} [o.host='127.0.0.1']   address to bind
 * @param {number} [o.port=8081]          0 = pick a free port
 * @param {string} [o.token]              bearer token (required when host is not loopback)
 * @param {string} [o.apiUrl]             base URL of the REST API
 * @param {number} [o.timeoutMs]          REST request timeout
 * @param {string[]} [o.allowedOrigins]   extra Origins allowed besides localhost
 * @param {string[]} [o.allowedHosts]     Host header names allowed on a loopback bind besides localhost
 * @param {number} [o.maxBodyBytes=1048576]
 * @returns {Promise<{ server: http.Server, url: string, port: number, close: () => Promise<void> }>}
 */
async function startHttp(o = {}) {
  const host = o.host ?? '127.0.0.1';
  const token = o.token || '';
  const maxBody = o.maxBodyBytes ?? 1_048_576;
  const extraOrigins = new Set((o.allowedOrigins ?? []).map((s) => s.trim()).filter(Boolean));
  const extraHosts = new Set((o.allowedHosts ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const loopback = isLoopback(host);

  if (!loopback && !token) {
    throw new Error(`Refusing to listen on ${host} without a token. Set OBS_MCP_TOKEN (for example: openssl rand -hex 24), or bind to 127.0.0.1.`);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/health' && req.method === 'GET') {
      return send(res, 200, { status: 'ok', name: NAME, version: VERSION, transport: 'streamable-http', auth: token ? 'bearer' : 'none' });
    }
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found. The MCP endpoint is POST /mcp' });

    // 1. DNS-rebinding protection
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin) && !extraOrigins.has(origin)) {
      return rpcError(res, 403, -32000, `Origin not allowed: ${origin}`);
    }
    if (loopback) {
      const name = hostnameOf(req.headers.host).toLowerCase();
      if (!isLoopback(name) && !extraHosts.has(name)) return rpcError(res, 403, -32000, `Host not allowed: ${name}`);
    }

    // 2. authentication
    if (token && !tokenMatches(req.headers.authorization, token)) {
      return rpcError(res, 401, -32001, 'Unauthorized: send  Authorization: Bearer <token>', { 'www-authenticate': 'Bearer' });
    }

    // 3. stateless server: POST only
    if (req.method !== 'POST') {
      return rpcError(res, 405, -32000, 'Method not allowed: this server is stateless, use POST /mcp', { allow: 'POST' });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch (e) {
      if (e.status === 413) return rpcError(res, 413, -32600, 'Request body too large');
      return rpcError(res, 400, -32700, 'Parse error: body must be JSON');
    }

    const { server } = createServer({ baseUrl: o.apiUrl, timeoutMs: o.timeoutMs });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) rpcError(res, 500, -32603, `Internal error: ${e.message}`);
      else res.end();
    }
  };

  const srv = http.createServer((req, res) => {
    handler(req, res).catch((e) => { if (!res.headersSent) rpcError(res, 500, -32603, `Internal error: ${e.message}`); else res.end(); });
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(o.port ?? 8081, host, resolve); });
  const port = srv.address().port;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    server: srv,
    port,
    url: `http://${shownHost}:${port}/mcp`,
    close: () => new Promise((resolve) => { srv.close(() => resolve()); srv.closeAllConnections?.(); }),
  };
}

module.exports = { startHttp, isLoopback };
