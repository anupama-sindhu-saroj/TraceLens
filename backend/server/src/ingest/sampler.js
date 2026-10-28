// Tail-based sampler: decides per TRACE whether its spans and logs are stored.
//
//   const s = createSampler({ sampleRate: 0.1, slowMs: 1000, waitMs: 5000, onRelease: (table, rows) => ... });
//   const keepNow = s.process('spans', rows);   // rows to store right now (array, maybe empty)
//   s.sweep();                                   // decide traces that went quiet (the batcher calls this on a timer)
//   s.stop();                                    // decide everything still waiting
//   s.stats()
//
// Rules
//   keep 100%  a trace with an error span (status ERROR or http >= 500), a span slower than slowMs, or an ERROR log
//   sample     every other trace is kept with probability sampleRate (decided from a hash of the trace id, so the same
//              trace always gets the same answer, even on a restart or when late spans arrive)
//   logs with no trace id: WARN and ERROR are kept, DEBUG and INFO are sampled at sampleRate
//   a trace's logs always follow the trace's decision, so you never keep spans and lose their logs
//
// Until a trace is "interesting" its rows wait in memory (at most waitMs after its last row, and at most maxTraces
// traces at once; past that the oldest are decided early), then they are released through onRelease(table, rows).
// sampleRate >= 1 turns the sampler off completely (rows pass straight through, nothing is buffered).
const crypto = require('node:crypto');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// 0..1, stable for a given trace id
function unitHash(id) {
  const h = crypto.createHash('md5').update(String(id)).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

function createSampler(opts = {}) {
  const sampleRate = Math.min(1, Math.max(0, num(opts.sampleRate ?? process.env.SAMPLE_RATE, 1)));
  const slowMs = num(opts.slowMs ?? process.env.SLOW_MS, 1000);
  const waitMs = num(opts.waitMs ?? process.env.SAMPLE_WAIT_MS, 5000);
  const maxTraces = num(opts.maxTraces, 50_000);
  const decisionTtlMs = num(opts.decisionTtlMs, 10 * 60_000);
  const maxDecisions = num(opts.maxDecisions, 200_000);
  const onRelease = opts.onRelease ?? (() => {});
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const enabled = sampleRate < 1;

  const pending = new Map();   // trace_id -> { spans: [], logs: [], last }
  const decided = new Map();   // trace_id -> { keep, at }
  const counters = {
    spansKept: 0, spansDropped: 0, logsKept: 0, logsDropped: 0,
    tracesKeptInteresting: 0, tracesKeptSampled: 0, tracesDropped: 0,
  };

  const isBadSpan = (s) => s.status_code === 'ERROR' || Number(s.http_status) >= 500 || Number(s.duration_ms) > slowMs;
  const isBadLog = (l) => l.level === 'ERROR';
  const keepRows = (table, rows) => { counters[table === 'spans' ? 'spansKept' : 'logsKept'] += rows.length; };
  const dropRows = (table, rows) => { counters[table === 'spans' ? 'spansDropped' : 'logsDropped'] += rows.length; };

  function remember(traceId, keep) {
    decided.set(traceId, { keep, at: now() });
    if (decided.size > maxDecisions) {
      const drop = decided.size - maxDecisions;
      let i = 0;
      for (const k of decided.keys()) { if (i++ >= drop) break; decided.delete(k); }
    }
  }

  // Close a trace: keep (interesting = it had an error or was slow) or let the hash decide.
  function settle(traceId, interesting) {
    const p = pending.get(traceId);
    pending.delete(traceId);
    const keep = interesting || unitHash(traceId) < sampleRate;
    remember(traceId, keep);
    if (interesting) counters.tracesKeptInteresting++;
    else if (keep) counters.tracesKeptSampled++;
    else counters.tracesDropped++;
    if (!p) return;
    for (const table of ['spans', 'logs']) {
      const rows = p[table];
      if (rows.length === 0) continue;
      if (keep) { keepRows(table, rows); onRelease(table, rows); } else dropRows(table, rows);
    }
  }

  function handle(table, rows) {
    if (!enabled || !rows || rows.length === 0) return rows;
    const out = [];
    const t = now();
    const bad = table === 'spans' ? isBadSpan : isBadLog;
    const nowInteresting = new Set();
    for (const row of rows) {
      const id = row.trace_id;
      if (!id) {
        // not part of a trace (logs only)
        const keep = row.level === 'WARN' || row.level === 'ERROR' || random() < sampleRate;
        if (keep) { counters.logsKept++; out.push(row); } else counters.logsDropped++;
        continue;
      }
      const d = decided.get(id);
      if (d) {
        if (d.keep) { keepRows(table, [row]); out.push(row); } else dropRows(table, [row]);
        continue;
      }
      let p = pending.get(id);
      if (!p) { p = { spans: [], logs: [], last: t, interesting: false }; pending.set(id, p); }
      p[table].push(row);
      p.last = t;
      if (bad(row)) { p.interesting = true; nowInteresting.add(id); }
    }
    // A trace that just became interesting is decided now and released together with what it was holding.
    // (Rows held for a trace leave through onRelease; `out` only carries rows that pass straight through.)
    for (const id of nowInteresting) if (pending.has(id)) settle(id, true);
    // Memory bound: too many traces waiting -> decide the oldest ones early.
    if (pending.size > maxTraces) {
      const extra = pending.size - maxTraces;
      let i = 0;
      for (const [id, p] of [...pending]) { if (i++ >= extra) break; settle(id, p.interesting); }
    }
    return out;
  }

  function sweep() {
    if (!enabled) return;
    const t = now();
    for (const [id, p] of [...pending]) if (t - p.last >= waitMs) settle(id, p.interesting);
    for (const [id, d] of decided) if (t - d.at > decisionTtlMs) decided.delete(id);
  }

  function stop() { for (const [id, p] of [...pending]) settle(id, p.interesting); }

  return {
    enabled, sampleRate, slowMs, waitMs,
    process: handle, sweep, stop,
    stats: () => ({ enabled, sampleRate, slowMs, waitingTraces: pending.size, ...counters }),
  };
}

module.exports = { createSampler, unitHash };
