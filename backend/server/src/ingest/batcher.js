// Batching engine (feature 6, owner: A). Single choke point between ingestion (HTTP + B's gRPC) and DuckDB.
//
//   const { batcher } = require('./ingest/batcher');
//   batcher.start();                                // once, after db.init()
//   batcher.enqueue('spans', rows);                 // or enqueue('logs', rows)
//   batcher.on('logs', (rows) => ...);              // fires immediately on enqueue -> B's Live Tail (WebSocket)
//   batcher.on('spans', (rows) => ...);
//   batcher.on('flush', ({ table, count, ms }) => ...);
//   batcher.on('flush-retry', (err, { table, count, attempt }) => ...);   // write failed, batch kept and retried
//   batcher.on('flush-error', (err, { table, count }) => ...);            // retries exhausted, batch dropped
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
// If the DB write fails the batch goes back to the FRONT of the queue and is retried with exponential backoff
// (maxFlushRetries attempts, 'flush-retry' is emitted each time). Only after the last attempt fails is it dropped
// (counted in stats().dropped, 'flush-error' emitted). Span inserts are idempotent (see db.insertSpans), so a retry after an
// uncertain write cannot duplicate spans. Log rows have no identity yet, so a retry after a partly-applied write could duplicate logs.
// Admission control: enqueue() returns false (and takes NOTHING) when the whole request does not fit in maxQueue
// (queued + in-flight rows), so receivers can answer 503 / UNAVAILABLE instead of silently truncating.
const { EventEmitter } = require('node:events');
const db = require('../db');
const { createRedactor } = require('./redactor');
const { createSampler } = require('./sampler');

const INSERTERS = { spans: (r) => db.insertSpans(r), logs: (r) => db.insertLogs(r) };

class Batcher extends EventEmitter {
  constructor({ maxBatch = 500, flushIntervalMs = 1000, maxQueue = 100_000, maxFlushRetries = 3, retryBaseMs = 200, redactor, sampling } = {}) {
    super();
    this.redactor = redactor ?? createRedactor();
    this.sampler = createSampler({ ...sampling, onRelease: (table, rows) => this.store(table, rows) });
    this.maxBatch = maxBatch;
    this.flushIntervalMs = flushIntervalMs;
    this.maxQueue = maxQueue;
    this.queues = { spans: [], logs: [] };
    this.counters = { spans: { written: 0, dropped: 0 }, logs: { written: 0, dropped: 0 } };
    this.maxFlushRetries = maxFlushRetries;
    this.retryBaseMs = retryBaseMs;
    this.inflightRows = { spans: 0, logs: 0 }; // rows taken out of the queue and being written right now
    this.failures = { spans: 0, logs: 0 };     // consecutive failed writes of the batch at the head of the queue
    this.retryAt = { spans: 0, logs: 0 };      // do not retry before this time (backoff)
    this.extra = { retried: { spans: 0, logs: 0 }, rejectedRequests: { spans: 0, logs: 0 } };
    this.timer = null;
    this.inflight = Promise.resolve();
  }

  // Would a request of n rows fit? Counts queued + in-flight rows, not just the queue.
  canAccept(table, n) {
    return this.queues[table].length + this.inflightRows[table] + n <= this.maxQueue;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sampler.sweep(); this.flush().catch(() => {}); }, this.flushIntervalMs);
    this.timer.unref();
  }

  enqueue(table, rows) {
    if (!this.queues[table]) throw new Error(`unknown table "${table}" (use 'spans' or 'logs')`);
    if (!rows || rows.length === 0) return true;
    if (!this.canAccept(table, rows.length)) { this.extra.rejectedRequests[table]++; return false; }
    rows = this.redactor.redact(table, rows);
    this.emit(table, rows); // 'spans' | 'logs' live event (live tail sees everything, before sampling)
    const keep = this.sampler.process(table, rows);
    if (keep.length) this.store(table, keep);
    return true; // accepted into the in-memory queue
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

  // Flush one table (or both). Flushes run one after another. `force` ignores the retry backoff (shutdown, tests).
  flush(only, { force = false } = {}) {
    const tables = only ? [only] : Object.keys(this.queues);
    this.inflight = this.inflight.then(async () => {
      for (const table of tables) {
        if (!force && Date.now() < this.retryAt[table]) continue; // still backing off after a failed write
        const rows = this.queues[table].splice(0);
        if (rows.length === 0) continue;
        this.inflightRows[table] = rows.length;
        const t0 = Date.now();
        try {
          await INSERTERS[table](rows);
          this.counters[table].written += rows.length;
          this.failures[table] = 0;
          this.retryAt[table] = 0;
          this.emit('flush', { table, count: rows.length, ms: Date.now() - t0 });
        } catch (err) {
          const attempt = ++this.failures[table];
          if (attempt <= this.maxFlushRetries) {
            this.queues[table] = rows.concat(this.queues[table]); // keep the batch, oldest rows first
            this.extra.retried[table] += rows.length;
            this.retryAt[table] = Date.now() + this.retryBaseMs * 2 ** (attempt - 1);
            this.emit('flush-retry', err, { table, count: rows.length, attempt });
          } else {
            this.failures[table] = 0;
            this.retryAt[table] = 0;
            this.counters[table].dropped += rows.length;
            this.emit('flush-error', err, { table, count: rows.length });
          }
        } finally {
          this.inflightRows[table] = 0;
        }
      }
    });
    return this.inflight;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampler.stop(); // decide traces that are still waiting, so shutdown does not lose them
    // force-flush, and keep going while a failed batch is still being retried (bounded)
    for (let i = 0; i <= this.maxFlushRetries; i++) {
      await this.flush(undefined, { force: true });
      if (this.queues.spans.length + this.queues.logs.length === 0) break;
    }
  }

  stats() {
    return {
      queued: { spans: this.queues.spans.length, logs: this.queues.logs.length },
      inflight: { ...this.inflightRows },
      maxQueue: this.maxQueue,
      retried: { ...this.extra.retried },
      rejectedRequests: { ...this.extra.rejectedRequests },
      ...this.counters,
      sampling: this.sampler.stats(),
      redaction: this.redactor.stats(),
    };
  }
}

const batcher = new Batcher();
batcher.on('flush-retry', (err, info) => console.warn(`[batcher] ${info.table} write failed (attempt ${info.attempt}), will retry ${info.count} rows:`, err.message));
batcher.on('flush-error', (err, info) => console.error(`[batcher] ${info.table} write failed (${info.count} rows dropped):`, err.message));

module.exports = { batcher, Batcher };