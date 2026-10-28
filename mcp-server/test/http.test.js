'use strict';
// The Streamable HTTP transport: the same tools over POST /mcp, with the safety rules (token, origin, host, body size).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startHttp } = require('../src/http');

let fakeApi; let apiUrl; let secured; let open; let tiny;
const TOKEN = 'correct-horse-battery-staple';
const ACCEPT = 'application/json, text/event-stream';

test.before(async () => {
  fakeApi = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/api/stats/services')) {
      return res.end(JSON.stringify({ services: [{ service: 'cart', requests: 10, errors: 0, errorRate: 0, avgLatencyMs: 20, p99LatencyMs: 40, lastSeenMs: Date.now(), health: 'healthy' }] }));
    }
    if (req.url.startsWith('/api/anomalies')) return res.end(JSON.stringify({ anomalies: [], count: 0 }));
    return res.end('{}');
  }).listen(0);
  apiUrl = `http://localhost:${fakeApi.address().port}`;
  secured = await startHttp({ port: 0, token: TOKEN, apiUrl });
  open = await startHttp({ port: 0, apiUrl }); // loopback, no token
  tiny = await startHttp({ port: 0, apiUrl, maxBodyBytes: 200 });
});
test.after(async () => { await Promise.all([secured.close(), open.close(), tiny.close()]); fakeApi.close(); });

const rpc = (method, params = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const post = (srv, body, headers = {}) => fetch(srv.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers }, body });
const auth = { authorization: `Bearer ${TOKEN}` };

test('an MCP client can connect with the token, list the tools and call one', async () => {
  const client = new Client({ name: 'http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(secured.url), { requestInit: { headers: auth } }));
  try {
    assert.equal(client.getServerVersion().name, 'tracelens');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const r = await client.callTool({ name: 'get_service_health', arguments: {} });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.services[0].service, 'cart');
    assert.match(r.content[0].text, /cart {2,}HEALTHY/);
    const res = await client.readResource({ uri: 'tracelens://health' });
    assert.match(res.contents[0].text, /cart/);
  } finally { await client.close(); }
});

test('a token is required, and a wrong one is refused', async () => {
  const none = await post(secured, rpc('tools/list'));
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer');
  assert.match((await none.json()).error.message, /Bearer/);

  const wrong = await post(secured, rpc('tools/list'), { authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
  const longer = await post(secured, rpc('tools/list'), { authorization: `Bearer ${TOKEN}x` });
  assert.equal(longer.status, 401);
  const basic = await post(secured, rpc('tools/list'), { authorization: `Basic ${TOKEN}` });
  assert.equal(basic.status, 401);

  const ok = await post(secured, rpc('tools/list'), auth);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.tools.length, 7);
});

test('plain curl-style JSON-RPC works without a session', async () => {
  const init = await post(secured, rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'curl', version: '0' } }), auth);
  assert.equal(init.status, 200);
  const body = await init.json();
  assert.equal(body.result.serverInfo.name, 'tracelens');
  assert.ok(body.result.capabilities.tools);
  assert.ok(body.result.capabilities.resources);
  assert.ok(body.result.capabilities.prompts);
  assert.equal(init.headers.get('mcp-session-id'), null, 'stateless: no session id');
});

test('a loopback server without a token still works for local use', async () => {
  const r = await post(open, rpc('tools/list'));
  assert.equal(r.status, 200);
});

test('only POST /mcp is served; /health is open and tells nothing sensitive', async () => {
  const get = await fetch(secured.url, { headers: auth });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const base = secured.url.replace(/\/mcp$/, '');
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', name: 'tracelens', version: '0.1.0', transport: 'streamable-http', auth: 'bearer' });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('bad bodies: invalid JSON is 400, an oversized body is 413', async () => {
  const bad = await post(open, '{not json');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const big = await post(tiny, rpc('tools/list', { padding: 'x'.repeat(1000) })).catch((e) => ({ status: 413, failed: e }));
  assert.equal(big.status, 413);
});

test('DNS-rebinding protection: foreign Origin and foreign Host are refused', async () => {
  const evil = await post(open, rpc('tools/list'), { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.match((await evil.json()).error.message, /Origin not allowed/);

  const local = await post(open, rpc('tools/list'), { origin: 'http://localhost:5173' });
  assert.equal(local.status, 200, 'a local web page (the dev UI) is allowed');

  // fetch cannot set Host, so use a raw request
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: open.port, path: '/mcp', method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json', accept: ACCEPT } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(rpc('tools/list'));
  });
  assert.equal(status, 403);
});

test('extra origins and hosts can be allowed explicitly', async () => {
  const s = await startHttp({ port: 0, apiUrl, allowedOrigins: ['https://ui.example.com'], allowedHosts: ['mcp.internal'] });
  try {
    assert.equal((await post(s, rpc('tools/list'), { origin: 'https://ui.example.com' })).status, 200);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/mcp', method: 'POST', headers: { host: 'mcp.internal:8081', 'content-type': 'application/json', accept: ACCEPT } },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(rpc('tools/list'));
    });
    assert.equal(status, 200);
  } finally { await s.close(); }
});

test('refuses to listen on a non-loopback address without a token', async () => {
  await assert.rejects(startHttp({ host: '0.0.0.0', port: 0, apiUrl }), /Refusing to listen on 0\.0\.0\.0 without a token/);
  const s = await startHttp({ host: '0.0.0.0', port: 0, token: TOKEN, apiUrl });
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, ...auth }, body: rpc('tools/list') });
    assert.equal(r.status, 200, 'host checks apply to loopback binds only; the token protects an open bind');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT }, body: rpc('tools/list') })).status, 401);
  } finally { await s.close(); }
});

test('concurrent clients do not interfere (stateless)', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(secured, rpc('tools/call', { name: 'get_service_health', arguments: {} }, i + 1), auth).then((r) => r.json())));
  for (const r of results) assert.match(r.result.content[0].text, /cart {2,}HEALTHY/);
  assert.deepEqual(results.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8]);
});
