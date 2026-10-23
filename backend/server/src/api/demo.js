// Failure Injection, API side (feature 3, owner: B).
// The server mounts it with:  app.use('/api/demo', require('./api/demo').demoRouter);
// The browser calls this router; it forwards to each demo service's /_fault endpoint.
const { Router } = require('express');

const HOST = process.env.DEMO_HOST || 'localhost';

// Same ports as demo-services/src/config.js. Override: DEMO_SERVICES='{"gateway":3000,...}'
const SERVICES = process.env.DEMO_SERVICES
  ? JSON.parse(process.env.DEMO_SERVICES)
  : { gateway: 3000, cart: 3001, inventory: 3002, payment: 3003 };

const TIMEOUT_MS = 2000;

async function call(service, method, body) {
  const res = await fetch(`http://${HOST}:${SERVICES[service]}/_fault`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { service, type, latencyMs, errorRate, durationSec } = body;
  if (!service || !(service in SERVICES)) {
    return `service must be one of: ${Object.keys(SERVICES).join(', ')}`;
  }
  if (type !== 'latency' && type !== 'error') return 'type must be "latency" or "error"';
  if (type === 'latency' && !(Number.isFinite(latencyMs) && latencyMs > 0 && latencyMs <= 60000)) {
    return 'latencyMs is required for latency faults (1 to 60000)';
  }
  if (type === 'error' && !(Number.isFinite(errorRate) && errorRate > 0 && errorRate <= 1)) {
    return 'errorRate is required for error faults (above 0, at most 1)';
  }
  if (durationSec !== undefined && !(Number.isFinite(durationSec) && durationSec > 0)) {
    return 'durationSec must be a positive number';
  }
  return null;
}

const demoRouter = Router();

// One row per service. fault is null when healthy; reachable=false if the service is down.
demoRouter.get('/faults', async (_req, res) => {
  const rows = await Promise.all(
    Object.keys(SERVICES).map(async (service) => {
      try {
        const { data } = await call(service, 'GET');
        return { service, fault: data.fault ?? null, reachable: true };
      } catch {
        return { service, fault: null, reachable: false };
      }
    }),
  );
  res.json(rows);
});

// Inject: { service, type: "latency"|"error", latencyMs?, errorRate?, durationSec? }
demoRouter.post('/faults', async (req, res) => {
  const problem = validate(req.body);
  if (problem) return res.status(400).json({ error: problem });

  const { service, ...faultBody } = req.body;
  try {
    const { status, data } = await call(service, 'POST', faultBody);
    if (status !== 201) return res.status(status).json(data);
    res.status(201).json({ service, ...data });
  } catch {
    res.status(502).json({ error: `${service} is not reachable on port ${SERVICES[service]}` });
  }
});

// Clear one service.
demoRouter.delete('/faults/:service', async (req, res) => {
  const { service } = req.params;
  if (!(service in SERVICES)) return res.status(404).json({ error: `unknown service "${service}"` });
  try {
    await call(service, 'DELETE');
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: `${service} is not reachable on port ${SERVICES[service]}` });
  }
});

// Clear everything. cleared = how many services actually had a fault.
demoRouter.delete('/faults', async (_req, res) => {
  const results = await Promise.all(
    Object.keys(SERVICES).map(async (service) => {
      try {
        const { data } = await call(service, 'DELETE');
        return data.cleared === true;
      } catch {
        return false;
      }
    }),
  );
  res.json({ ok: true, cleared: results.filter(Boolean).length });
});

module.exports = { demoRouter, SERVICES };