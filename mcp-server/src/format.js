'use strict';
// Plain-text rendering helpers. An agent reads these results, so they are compact, aligned and carry the ids
// (trace ids, anomaly ids) that the next tool call needs.

const iso = (ms) => new Date(ms).toISOString();

function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return 'n/a';
  const n = Number(ms);
  if (n >= 10_000) return `${(n / 1000).toFixed(0)} s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} s`;
  if (n >= 10) return `${Math.round(n)} ms`;
  return `${Math.round(n * 10) / 10} ms`;
}

function fmtPct(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return 'n/a';
  const p = Number(rate) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

const fmtNum = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-US'));
const fmtRatio = (r) => (r === null || r === undefined ? 'n/a' : `${Number(r).toFixed(1)}x`);

function ago(ms, now = Date.now()) {
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(0, max - 3))}...` : s;
}

// {a:1,b:"x"} -> a=1 b=x   (kept short; long values are clipped)
function attrsInline(obj, max = 220) {
  if (!obj || typeof obj !== 'object') return '';
  const parts = Object.entries(obj).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return clip(parts.join(' '), max);
}

// Attributes of the spans that matter (failed or the slowest): the ones that EXPLAIN a problem come first, routine
// transport details are dropped, and the clip happens last, so e.g. fault.injected / exception.* are never cut off.
const KEY_FIRST = /^(fault\.|exception\.|error|db\.|user\.id$|order\.id$|payment\.id$|sku$)/;
const NOISE = new Set(['http.request.method', 'url.scheme', 'server.port', 'server.address', 'network.protocol.version', 'user_agent.original', 'url.path']);

function spanAttrs(obj, max = 400) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj).filter((k) => !NOISE.has(k));
  keys.sort((a, b) => (KEY_FIRST.test(a) ? 0 : 1) - (KEY_FIRST.test(b) ? 0 : 1));
  return attrsInline(Object.fromEntries(keys.map((k) => [k, obj[k]])), max);
}

// Left-aligned text table. columns: [{ key, label }]
function table(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => String(r[c.key] ?? '')));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((r) => r[i].length)));
  const line = (arr) => arr.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map((c) => c.label)), ...cells.map(line)].join('\n');
}

// ---- traces -----------------------------------------------------------------------------------------------------

const isErrorSpan = (s) => s.httpStatus >= 500 || ((s.httpStatus === null || s.httpStatus === undefined) && s.statusCode === 'ERROR');

// Self time = the span's duration minus the time covered by its children (children are merged first, so parallel calls
// are not counted twice). This is where a span did its OWN work instead of waiting for someone else.
function selfTimes(spans) {
  const kids = new Map();
  for (const s of spans) {
    if (!s.parentSpanId) continue;
    if (!kids.has(s.parentSpanId)) kids.set(s.parentSpanId, []);
    kids.get(s.parentSpanId).push(s);
  }
  const out = new Map();
  for (const s of spans) {
    const lo = s.startMs;
    const hi = s.startMs + s.durationMs;
    const iv = (kids.get(s.spanId) ?? [])
      .map((c) => [Math.max(lo, c.startMs), Math.min(hi, c.startMs + c.durationMs)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curA = null;
    let curB = null;
    for (const [a, b] of iv) {
      if (curA === null) { curA = a; curB = b; } else if (a <= curB) { curB = Math.max(curB, b); } else { covered += curB - curA; curA = a; curB = b; }
    }
    if (curA !== null) covered += curB - curA;
    out.set(s.spanId, Math.max(0, s.durationMs - covered));
  }
  return out;
}

const KEEP_LOG_PRIORITY = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

// Choose up to `max` logs, errors and warnings first, then show them in time order.
function pickLogs(logs, max) {
  if (logs.length <= max) return logs;
  const ranked = [...logs].sort((a, b) => (KEEP_LOG_PRIORITY[a.level] ?? 4) - (KEEP_LOG_PRIORITY[b.level] ?? 4) || a.time_ms - b.time_ms);
  return ranked.slice(0, max).sort((a, b) => a.time_ms - b.time_ms);
}

function logLine(l, { withTrace = false } = {}) {
  const attrs = attrsInline(l.attributes, 160);
  return `${iso(l.time_ms)} ${String(l.level).padEnd(5)} ${l.service_name}  ${clip(l.message, 300)}${attrs ? `  {${attrs}}` : ''}${withTrace && l.trace_id ? `  trace=${l.trace_id}` : ''}`;
}

// Which spans are the bottleneck of a trace. Spans doing the same thing (for example five sequential POST /reserve calls)
// are judged together: a slow call that repeats is the bottleneck even when each single call is a small share of the trace.
// Returns { self (spanId -> own ms), hotGroups (most own time first), topGroup, flagged (span ids), firstFlaggedId }.
function analyzeTrace(trace) {
  const spans = trace.spans ?? [];
  const self = selfTimes(spans);
  const order = (x, y) => x.startMs - y.startMs || x.spanId.localeCompare(y.spanId);
  const groups = new Map();
  for (const sp of spans) {
    const key = `${sp.serviceName} ${sp.name}`;
    const g = groups.get(key) ?? { key, service: sp.serviceName, name: sp.name, spans: [], total: 0 };
    g.spans.push(sp);
    g.total += self.get(sp.spanId) ?? 0;
    groups.set(key, g);
  }
  const hotGroups = [...groups.values()].filter((g) => g.total > 0).sort((x, y) => y.total - x.total);
  const topGroup = hotGroups[0] ?? null;
  const flagged = new Set();
  let firstFlaggedId = null;
  if (spans.length > 1 && topGroup && topGroup.total >= 0.3 * trace.durationMs) {
    for (const sp of topGroup.spans) flagged.add(sp.spanId);
    firstFlaggedId = [...topGroup.spans].sort(order)[0].spanId;
  }
  return { self, hotGroups, topGroup, flagged, firstFlaggedId };
}

function renderTrace(trace, logsResult, { maxSpans = 80, maxLogs = 30, now = Date.now() } = {}) {
  const spans = trace.spans ?? [];
  const byParent = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parentSpanId) {
      if (!byParent.has(s.parentSpanId)) byParent.set(s.parentSpanId, []);
      byParent.get(s.parentSpanId).push(s);
    } else roots.push(s);
  }
  const order = (a, b) => a.startMs - b.startMs || a.spanId.localeCompare(b.spanId);
  roots.sort(order);
  for (const list of byParent.values()) list.sort(order);

  const { self, hotGroups, topGroup, flagged, firstFlaggedId } = analyzeTrace(trace);
  const withAttrs = new Set(firstFlaggedId ? [firstFlaggedId] : []); // flagged spans get an attributes line once per group

  const lines = [];
  lines.push(`Trace ${trace.traceId}`);
  lines.push(`${fmtMs(trace.durationMs)} total, ${trace.spanCount} spans, services: ${trace.services.join(', ')}, ${trace.errorSpans} error span${trace.errorSpans === 1 ? '' : 's'}, ${trace.logCount} log${trace.logCount === 1 ? '' : 's'}`);
  lines.push(`Started ${iso(trace.startMs)} (${ago(trace.startMs, now)})`);
  lines.push('');
  lines.push('Span tree (service name [kind] +start offset, duration, own time = duration minus time spent waiting on child spans):');

  let shown = 0;
  const walk = (s, depth) => {
    if (shown >= maxSpans) return;
    shown += 1;
    const err = isErrorSpan(s);
    const status = s.httpStatus ? `HTTP ${s.httpStatus}` : (s.statusCode && !['UNSET', 'OK'].includes(s.statusCode) ? s.statusCode : '');
    const bits = [
      `${'  '.repeat(depth)}${s.serviceName} ${s.name} [${s.kind}]`,
      `+${fmtMs(s.offsetMs)}`,
      fmtMs(s.durationMs),
      `own ${fmtMs(self.get(s.spanId))}`,
    ];
    if (status) bits.push(status);
    if (err) bits.push('ERROR');
    if (s.missingParent) bits.push('(parent span missing)');
    if (flagged.has(s.spanId)) bits.push(`<-- most own time${topGroup.spans.length > 1 ? ` (x${topGroup.spans.length} in this trace)` : ''}`);
    lines.push(bits.join('  '));
    if (err || withAttrs.has(s.spanId)) {
      const a = spanAttrs(s.attributes);
      const rep = !err && topGroup.spans.length > 1 ? ` (first of ${topGroup.spans.length})` : '';
      if (a) lines.push(`${'  '.repeat(depth)}    attributes${rep}: ${a}`);
    }
    for (const c of byParent.get(s.spanId) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (shown < spans.length) lines.push(`... ${spans.length - shown} more span${spans.length - shown === 1 ? '' : 's'} not shown (raise max_spans).`);

  if (spans.length > 1 && hotGroups.length) {
    const part = (g) => `${g.key} ${fmtMs(g.total)}${g.spans.length > 1 ? ` (${g.spans.length} spans, ${fmtMs(g.total / g.spans.length)} each)` : ''}`;
    lines.push('');
    lines.push(`Most own time: ${hotGroups.slice(0, 3).map(part).join('; ')}`);
  }

  if (logsResult) {
    const all = logsResult.logs ?? [];
    lines.push('');
    if (!all.length) {
      lines.push('Logs for this trace: none stored.');
    } else {
      const picked = pickLogs(all, maxLogs);
      const more = trace.logCount > picked.length ? ` (showing ${picked.length} of ${trace.logCount}; errors and warnings first)` : '';
      lines.push(`Logs for this trace${more}:`);
      for (const l of picked) lines.push(logLine(l));
    }
  }
  return lines.join('\n');
}

module.exports = { iso, fmtMs, fmtPct, fmtNum, fmtRatio, ago, clip, attrsInline, spanAttrs, table, selfTimes, analyzeTrace, isErrorSpan, pickLogs, logLine, renderTrace };
