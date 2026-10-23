const express = require('express');
const { faultMiddleware } = require('./fault');
const { createLogger } = require('./logger');
const { SERVICES } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

/** Creates an express app with JSON parsing, /health, and the fault hook. */
function createApp(service) {
  const app = express();
  const log = createLogger(service);
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ service, status: 'ok' });
  });
  app.use(faultMiddleware(service)); // <- the one line B's Failure Injection plugs into
  return { app, log };
}

/** Error handler: logs with the trace context and returns the right status. Register LAST. */
function errorHandler(log) {
  return (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = err?.status;
    if (status && status >= 400 && status < 500) {
      // downstream said "client error" (404/409/402...): pass it through, log as WARN
      log.warn('request rejected', { error: message, status });
      res.status(status).json({ error: message });
      return;
    }
    log.error('unhandled error', { error: message });
    res.status(500).json({ error: message });
  };
}

function listen(app, service, log) {
  const port = SERVICES[service].port;
  app.listen(port, () => log.info(`${service} listening`, { port }));
}

/** Calls another service; throws with status info if it responds non-2xx. */
async function call(baseUrl, path, init) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

module.exports = { sleep, jitter, createApp, errorHandler, listen, call };
