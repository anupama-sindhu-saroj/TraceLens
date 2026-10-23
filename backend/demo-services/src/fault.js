// Failure Injection (feature 3, owner: B).
// Replaces A's pass-through stub. Same export and signature: faultMiddleware(service).
// createApp() already mounts it with one line, after express.json() and /health.
//
// Besides injecting latency/errors it serves its own control endpoints, so no
// extra wiring is needed in the service files:
//   GET    /_fault   -> { fault }
//   POST   /_fault   -> body { type: "latency"|"error", latencyMs?, errorRate?, durationSec? }
//   DELETE /_fault   -> { ok, cleared }
// The server's /api/demo router (server/src/api/demo.js) forwards to these.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { createLogger } = require('./logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateFault(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { type, latencyMs, errorRate, durationSec } = body;
  if (type !== 'latency' && type !== 'error') return 'type must be "latency" or "error"';
  if (type === 'latency' && !(Number.isFinite(latencyMs) && latencyMs > 0 && latencyMs <= 60000)) {
    return 'latencyMs must be a number between 1 and 60000';
  }
  if (type === 'error' && !(Number.isFinite(errorRate) && errorRate > 0 && errorRate <= 1)) {
    return 'errorRate must be a number above 0 and at most 1';
  }
  if (durationSec !== undefined && !(Number.isFinite(durationSec) && durationSec > 0)) {
    return 'durationSec must be a positive number';
  }
  return null;
}

function faultMiddleware(service) {
  const log = createLogger(service);
  let fault = null; // { type, latencyMs?, errorRate?, durationSec?, expiresAt? }
  let timer = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const had = fault !== null;
    fault = null;
    return had;
  };

  const set = (body) => {
    clear();
    const { type, latencyMs, errorRate, durationSec } = body;
    fault = { type };
    if (type === 'latency') fault.latencyMs = latencyMs;
    if (type === 'error') fault.errorRate = errorRate;
    if (durationSec) {
      fault.durationSec = durationSec;
      fault.expiresAt = new Date(Date.now() + durationSec * 1000).toISOString();
      timer = setTimeout(() => {
        log.info('injected fault expired', { fault: fault?.type });
        fault = null;
        timer = null;
      }, durationSec * 1000);
      timer.unref();
    }
    log.warn('fault injected', { fault: type, ...fault });
    return fault;
  };

  return async (req, res, next) => {
    // control endpoints
    if (req.path === '/_fault') {
      if (req.method === 'GET') return res.json({ fault });
      if (req.method === 'POST') {
        const problem = validateFault(req.body);
        if (problem) return res.status(400).json({ error: problem });
        return res.status(201).json(set(req.body));
      }
      if (req.method === 'DELETE') {
        const cleared = clear();
        if (cleared) log.info('fault cleared');
        return res.json({ ok: true, cleared });
      }
      return res.status(405).json({ error: 'method not allowed' });
    }

    if (!fault || req.path === '/health') return next();

    const active = fault; // it can be cleared while we sleep
    const span = trace.getActiveSpan();
    span?.setAttribute('fault.injected', true);
    span?.setAttribute('fault.type', active.type);

    if (active.type === 'latency') {
      await sleep(active.latencyMs);
      return next();
    }

    if (active.type === 'error' && Math.random() < active.errorRate) {
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'injected fault' });
      log.error('Injected fault: request failed', { fault: 'error', path: req.path });
      return res.status(500).json({ error: 'injected fault' });
    }
    return next();
  };
}

module.exports = { faultMiddleware };