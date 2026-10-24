// Live Tail (feature 12 backend, owner: B). WebSocket at /ws/logs that streams new log rows as they are ingested.
//
//   const tail = attachLiveTail(httpServer, { batcher });   // once, after app.listen()
//   await tail.close();                                       // on shutdown
//
// Protocol (JSON text frames)
//   client -> server  { type: 'filter', service?, level?, q?, regex?, tags?, traceId?, spanId? }   sent right after connecting.
//                      level is one level or a comma list ("WARN,ERROR"); regex=true makes q a regular expression;
//                      tags is an array of { key, op: eq|ne|re|has, value }. Same meaning as GET /api/logs.
//   server -> client  { type: 'error', message }                           the filter was rejected (bad regex...); nothing is streamed
//                                                                           until a valid filter is sent
//   server -> client  { type: 'hello' }                                    connection accepted
//                      { type: 'logs', rows: [...], dropped: 0 }            new matching rows, oldest first; `dropped` counts rows
//                                                                           skipped because this client was too slow or too busy
//
// Why it will not hurt the server under load: rows are matched in memory straight from the batcher event (no DB read),
// buffered per client, and sent in one frame every flushMs; a client that cannot keep up loses the OLDEST pending rows
// (and is told how many), so memory stays bounded. Dead connections are found with ping/pong and closed.
const { WebSocketServer, WebSocket } = require('ws');
const { parseTags } = require('../api/logs');

// RE2 (linear time, same engine family as DuckDB) when the optional `re2` package is installed; otherwise the built-in
// RegExp, which can be slow on nasty patterns, so it is protected by a time budget (see attachLiveTail).
let RE2 = null;
try { RE2 = require('re2'); } catch { /* optional */ }
const MAX_REGEX_LEN = 500;
const MAX_TEXT = 4000; // only the first characters of a message / attribute value are matched against a regex

function compile(pattern) {
  if (pattern.length > MAX_REGEX_LEN) throw new Error(`regular expression is longer than ${MAX_REGEX_LEN} characters`);
  try { return RE2 ? new RE2(pattern, 'i') : new RegExp(pattern, 'i'); } catch (e) {
    throw new Error(`invalid regular expression: ${String(e.message).replace(/^Invalid regular expression:\s*/i, '')}`);
  }
}

const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);

function normalizeFilter(f = {}) {
  const levels = f.level
    ? String(f.level).toUpperCase().split(',').map((s) => s.trim()).filter((l) => LEVELS.has(l))
    : [];
  const regex = f.regex === true || f.regex === '1' || f.regex === 'true';
  const q = f.q ? String(f.q) : '';
  const tags = parseTags(f.tags).map((t) => ({ ...t, re: t.op === 're' ? compile(t.value) : null }));
  return {
    service: f.service ? String(f.service) : '',
    levels: levels.length ? new Set(levels) : null,
    q: regex ? '' : q.toLowerCase(),
    re: regex && q ? compile(q) : null,
    tags,
    traceId: f.traceId ? String(f.traceId) : '',
    spanId: f.spanId ? String(f.spanId) : '',
    slowRegex: Boolean(!RE2 && (regex && q || tags.some((t) => t.re))),
  };
}

const asText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

function matches(row, f) {
  if (f.service && row.service_name !== f.service) return false;
  if (f.levels && !f.levels.has(row.level)) return false;
  if (f.traceId && row.trace_id !== f.traceId) return false;
  if (f.spanId && row.span_id !== f.spanId) return false;
  let attrs = row.attributes;
  if (typeof attrs === 'string') { try { attrs = JSON.parse(attrs); } catch { attrs = {}; } }
  attrs = attrs ?? {};
  for (const t of f.tags) {
    const v = attrs[t.key];
    const has = v !== undefined && v !== null;
    if (t.op === 'has' && !has) return false;
    if (t.op === 'eq' && !(has && asText(v) === t.value)) return false;
    if (t.op === 'ne' && has && asText(v) === t.value) return false;
    if (t.op === 're' && !(has && t.re.test(asText(v).slice(0, MAX_TEXT)))) return false;
  }
  if (f.re) {
    if (!f.re.test(String(row.message).slice(0, MAX_TEXT)) && !f.re.test(JSON.stringify(attrs).slice(0, MAX_TEXT))) return false;
  } else if (f.q) {
    if (!String(row.message).toLowerCase().includes(f.q) && !JSON.stringify(attrs).toLowerCase().includes(f.q)) return false;
  }
  return true;
}

// Same shape as GET /api/logs rows.
function shape(r) {
  let attributes = r.attributes;
  if (typeof attributes === 'string') { try { attributes = JSON.parse(attributes); } catch { attributes = {}; } }
  return {
    time_ms: r.time_ms,
    service_name: r.service_name,
    level: r.level,
    message: r.message,
    trace_id: r.trace_id ?? null,
    span_id: r.span_id ?? null,
    attributes: attributes ?? {},
  };
}

function attachLiveTail(server, {
  batcher,
  path = '/ws/logs',
  flushMs = 200,
  maxPending = 2000,
  maxPerFrame = 500,
  maxBufferedBytes = 1024 * 1024,
  pingMs = 30_000,
  regexBudgetMs = 100,
} = {}) {
  const REGEX_BUDGET_MS = regexBudgetMs;
  const wss = new WebSocketServer({ server, path });
  const clients = new Map(); // ws -> { filter, pending: [], dropped: 0, alive: true }

  wss.on('connection', (ws) => {
    const state = { filter: normalizeFilter(), pending: [], dropped: 0, alive: true };
    clients.set(ws, state);
    ws.on('pong', () => { state.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && msg.type === 'filter') {
        state.pending = [];
        try { state.filter = normalizeFilter(msg); } catch (e) {
          state.filter = null; // stream nothing until the client sends a valid filter
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        }
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello' }));
  });

  const onLogs = (rows) => {
    if (clients.size === 0) return;
    for (const [ws, st] of clients) {
      if (!st.filter) continue;
      const t0 = st.filter.slowRegex ? performance.now() : 0;
      for (const r of rows) {
        if (!matches(r, st.filter)) continue;
        st.pending.push(shape(r));
      }
      if (st.filter.slowRegex && performance.now() - t0 > REGEX_BUDGET_MS) {
        // Built-in RegExp can backtrack badly. Stop this client's stream instead of stalling the whole server.
        st.filter = null; st.pending = [];
        ws.send(JSON.stringify({ type: 'error', message: 'regular expression is too slow to run on the live stream; simplify it or install the re2 package' }));
        continue;
      }
      if (st.pending.length > maxPending) {
        const over = st.pending.length - maxPending;
        st.pending.splice(0, over); // drop the oldest
        st.dropped += over;
      }
    }
  };
  batcher.on('logs', onLogs);

  const flushTimer = setInterval(() => {
    for (const [ws, st] of clients) {
      if (ws.readyState !== WebSocket.OPEN || st.pending.length === 0) continue;
      if (ws.bufferedAmount > maxBufferedBytes) continue; // slow client: keep buffering (bounded by maxPending)
      const rows = st.pending.splice(0, maxPerFrame);
      ws.send(JSON.stringify({ type: 'logs', rows, dropped: st.dropped }));
      st.dropped = 0;
    }
  }, flushMs);
  flushTimer.unref();

  const pingTimer = setInterval(() => {
    for (const [ws, st] of clients) {
      if (!st.alive) { ws.terminate(); clients.delete(ws); continue; }
      st.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, pingMs);
  pingTimer.unref();

  return {
    clients: () => clients.size,
    close: () => new Promise((resolve) => {
      clearInterval(flushTimer);
      clearInterval(pingTimer);
      batcher.off('logs', onLogs);
      for (const ws of clients.keys()) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}

module.exports = { attachLiveTail, matches, normalizeFilter, usingRe2: Boolean(RE2) };