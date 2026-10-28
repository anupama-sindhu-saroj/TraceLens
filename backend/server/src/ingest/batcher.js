// Batching engine (feature 6, owner: A). Single choke point between ingestion (HTTP + B's gRPC) and DuckDB.
//
//   const { batcher } = require('./ingest/batcher');
//   batcher.start();                                // once, after db.init()
//   batcher.enqueue('spans', rows);                 // or enqueue('logs', rows)
//   batcher.on('logs', (rows) => ...);              // fires immediately on enqueue -> B's Live Tail (WebSocket)
//   batcher.on('spans', (rows) => ...);
//   batcher.on('flush', ({ table, count, ms }) => ...);
//   batcher.on('flush-error', (err, { table, count }) => ...);
//   await batcher.flush();                          // force write now (tests, shutdown)
//   await batcher.stop();                           // final flush + stop timer
//
// Every row goes through two steps before it is queued (both live in this folder, both configured by env vars):
//   1. redactor.js  masks secrets (passwords, tokens, card numbers ...)             REDACT_KEYS
//   2. sampler.js   keeps every error / slow trace, samples the rest (tail-based)   SAMPLE_RATE, SLOW_MS
// The live tail ('logs' / 'spans' events) sees every redacted row immediately, even rows the sampler later drops.
// With the default SAMPLE_RATE=1 nothing is sampled out, exactly as before.
//
// A table is flushed when it holds >= maxBatch rows or every flushIntervalMs, whichever comes first.
// If the DB write fails the batch is dropped (counted in stats().dropped) and 'flush-error' is emitted,
// so memory can't grow without limit; maxQueue caps the in-memory backlog too.
const { EventEmitter } = require('node:events');
const db = require('../db');
const { createRedactor } = require('./redactor');
const { createSampler } = require('./sampler');

const INSERTERS = { spans: (r) => db.insertSpans(r), logs: (r) => db.insertLogs(r) };

class Batcher extends EventEmitter {
  constructor({ maxBatch = 500, flushIntervalMs = 1000, maxQueue = 100_000, redactor, sampling } = {}) {
    super();
    this.redactor = redactor ?? createRedactor();
    this.sampler = createSampler({ ...sampling, onRelease: (table, rows) => this.store(table, rows) });
    this.maxBatch = maxBatch;
    this.flushIntervalMs = flushIntervalMs;
    this.maxQueue = maxQueue;
    this.queues = { spans: [], logs: [] };
    this.counters = { spans: { written: 0, dropped: 0 }, logs: { written: 0, dropped: 0 } };
    this.timer = null;
    this.inflight = Promise.resolve();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sampler.sweep(); this.flush().catch(() => {}); }, this.flushIntervalMs);
    this.timer.unref();
  }

  enqueue(table, rows) {
    if (!this.queues[table]) throw new Error(`unknown table "${table}" (use 'spans' or 'logs')`);
    if (!rows || rows.length === 0) return;
    rows = this.redactor.redact(table, rows);
    this.emit(table, rows); // 'spans' | 'logs' live event (live tail sees everything, before sampling)
    const keep = this.sampler.process(table, rows);
    if (keep.length) this.store(table, keep);
  }

  // Put rows that survived sampling into the write queue (bounded by maxQueue).
  store(table, rows) {
    const q = this.queues[table];
    const room = this.maxQueue - q.length;
    if (rows.length > room) {
      this.counters[table].dropped += rows.length - Math.max(room, 0);
      rows = rows.slice(0, Math.max(room, 0));
    }
    q.push(...rows);
    if (q.length >= this.maxBatch) this.flush(table).catch(() => {});
  }

  // Flush one table (or both). Flushes run one after another.
  flush(only) {
    const tables = only ? [only] : Object.keys(this.queues);
    this.inflight = this.inflight.then(async () => {
      for (const table of tables) {
        const rows = this.queues[table].splice(0);
        if (rows.length === 0) continue;
        const t0 = Date.now();
        try {
          await INSERTERS[table](rows);
          this.counters[table].written += rows.length;
          this.emit('flush', { table, count: rows.length, ms: Date.now() - t0 });
        } catch (err) {
          this.counters[table].dropped += rows.length;
          this.emit('flush-error', err, { table, count: rows.length });
        }
      }
    });
    return this.inflight;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampler.stop(); // decide traces that are still waiting, so shutdown does not lose them
    await this.flush();
  }

  stats() {
    return {
      queued: { spans: this.queues.spans.length, logs: this.queues.logs.length },
      ...this.counters,
      sampling: this.sampler.stats(),
      redaction: this.redactor.stats(),
    };
  }
}

const batcher = new Batcher();
batcher.on('flush-error', (err, info) => console.error(`[batcher] ${info.table} write failed (${info.count} rows dropped):`, err.message));

module.exports = { batcher, Batcher };