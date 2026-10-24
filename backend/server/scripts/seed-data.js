// Seed data generator (owner: B). Pure JS, no dependencies, so it can be unit tested without DuckDB.
//
//   const { generate } = require('./seed-data');
//   const { spans, logs, anomalies, summary } = generate({ now: Date.now() });
//
// The output matches db/schema.sql (SpanRow / LogRow / AnomalyRow in shared/types.js), so it can go straight
// into db.insertSpans / insertLogs / insertAnomalies.
//
// It imitates what demo-services really emit:
//   * request shapes (gateway -> cart -> inventory, checkout -> payment), span names, kinds and HTTP statuses
//   * the exact log messages and dynamic tags (user.id, order.id, payment.id, sku)
//   * healthy baseline: payment 100-250 ms (p99 ~ 250 ms), ~1% 500, ~2% 402, ~3% invalid sku (404)
//   * the "payment slow" incident: the LAST `incidentMinutes` minutes payment gets a 1550 ms latency fault
//     (same as Demo Controls) and 18% of charges time out with a 500. Gateway checkouts get slower and fail
//     as a side effect, which is exactly what root-cause correlation has to untangle.

const SERVICE_PORTS = { gateway: 3000, cart: 3001, inventory: 3002, payment: 3003 };
const PRODUCTS = {
  'sku-001': { name: 'Mechanical Keyboard', price: 4999 },
  'sku-002': { name: 'USB-C Hub', price: 1999 },
  'sku-003': { name: 'Noise Cancelling Headphones', price: 7999 },
  'sku-004': { name: 'Webcam 1080p', price: 3499 },
  'sku-005': { name: 'Laptop Stand', price: 1499 },
};
const SKUS = Object.keys(PRODUCTS);

const FAULT_LATENCY_MS = 1550;
const INCIDENT_TIMEOUT_RATE = 0.18;

// ---- deterministic random numbers (same --seed => same data) ----------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  const between = (a, b) => a + next() * (b - a);
  return {
    between,
    int: (a, b) => Math.floor(between(a, b + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    hex: (bytes) => Array.from({ length: bytes }, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join(''),
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const round3 = (n) => Math.round(n * 1000) / 1000;

// ---- simulator ---------------------------------------------------------------------------------

class Simulator {
  constructor({ seed, incidentStart }) {
    this.rng = makeRng(seed);
    this.incidentStart = incidentStart; // epoch ms or null
    this.spans = [];
    this.logs = [];
  }

  // One trace = one request into the gateway. begin() creates a span, finish() closes it.
  newTrace() {
    const rng = this.rng;
    const traceId = rng.hex(16);
    const begin = ({ service, name, kind, parent = null, start, attrs = {} }) => {
      const s = {
        trace_id: traceId,
        span_id: rng.hex(8),
        parent_span_id: parent ? parent.span_id : null,
        service_name: service,
        name,
        kind,
        start_time_ms: 0,
        duration_ms: 0,
        status_code: 'UNSET',
        http_status: null,
        attributes: attrs,
        _start: start,
      };
      this.spans.push(s);
      return s;
    };
    const finish = (s, end, { status, http, attrs } = {}) => {
      s.start_time_ms = Math.floor(s._start);
      s.duration_ms = round3(Math.max(0, end - s._start));
      if (status) s.status_code = status;
      if (http !== undefined) {
        s.http_status = http;
        s.attributes['http.response.status_code'] = http;
      }
      if (attrs) Object.assign(s.attributes, attrs);
      delete s._start;
    };
    const log = (service, span, level, message, time, attrs = {}) => {
      this.logs.push({
        time_ms: Math.floor(time),
        service_name: service,
        level,
        message,
        trace_id: span ? traceId : null,
        span_id: span ? span.span_id : null,
        attributes: attrs,
      });
    };
    return { traceId, begin, finish, log };
  }

  // Express "request handler" span inside a SERVER span. `body(h, t)` returns { end, status, error?, serverAttrs? }.
  handle(T, service, server, start, route, body, faultDelay = 0) {
    const { rng } = this;
    const hStart = start + faultDelay + rng.between(0.3, 1.0);
    const h = T.begin({
      service, name: `request handler - ${route}`, kind: 'INTERNAL', parent: server, start: hStart,
      attrs: { 'http.route': route, 'express.name': route, 'express.type': 'request_handler' },
    });
    const r = body(h, hStart);
    T.finish(h, r.end, { status: r.status >= 500 ? 'ERROR' : 'UNSET' });
    return { ...r, end: r.end + rng.between(0.2, 0.6) };
  }

  // CLIENT span in `from`, SERVER span in `to`. `handler(server, startMs)` simulates the callee.
  httpCall(T, { from, parent, start, method, path, route, to, handler }) {
    const { rng } = this;
    const port = SERVICE_PORTS[to];
    const client = T.begin({
      service: from, name: method, kind: 'CLIENT', parent, start,
      attrs: { 'http.request.method': method, 'url.full': `http://localhost:${port}${path}`, 'server.address': 'localhost', 'server.port': port },
    });
    const sStart = start + rng.between(0.6, 2.0);
    const server = T.begin({
      service: to, name: `${method} ${route}`, kind: 'SERVER', parent: client, start: sStart,
      attrs: { 'http.request.method': method, 'http.route': route, 'url.path': path, 'url.scheme': 'http', 'server.port': port },
    });
    const r = handler(server, sStart);
    // OTel semantic conventions: SERVER spans are ERROR only for 5xx, CLIENT spans are ERROR for 4xx and 5xx.
    T.finish(server, r.end, { status: r.status >= 500 ? 'ERROR' : 'UNSET', http: r.status, attrs: r.serverAttrs });
    const cEnd = r.end + rng.between(0.4, 1.5);
    T.finish(client, cEnd, { status: r.status >= 400 ? 'ERROR' : 'UNSET', http: r.status });
    const errText = r.status >= 400
      ? `${path} -> HTTP ${r.status}: ${JSON.stringify({ error: r.error }).slice(0, 120)}`
      : null;
    return { end: cEnd, status: r.status, errText, result: r };
  }

  // ---- inventory ----
  invList(T, from, parent, start) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'GET', path: '/stock', route: '/stock', to: 'inventory',
      handler: (server, s) => this.handle(T, 'inventory', server, s, '/stock', (_h, t) => ({ end: t + rng.between(10, 30), status: 200 })),
    });
  }

  invGet(T, from, parent, start, sku) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'GET', path: `/stock/${sku}`, route: '/stock/:sku', to: 'inventory',
      handler: (server, s) => this.handle(T, 'inventory', server, s, '/stock/:sku', (h, t) => {
        const end = t + rng.between(8, 25);
        if (!PRODUCTS[sku]) {
          T.log('inventory', h, 'WARN', 'sku not found', end - 0.1, { sku });
          return { end, status: 404, error: 'sku not found' };
        }
        return { end, status: 200 };
      }),
    });
  }

  invReserve(T, from, parent, start, sku, qty) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'POST', path: '/reserve', route: '/reserve', to: 'inventory',
      handler: (server, s) => this.handle(T, 'inventory', server, s, '/reserve', (h, t) => {
        const end = t + rng.between(15, 40);
        if (rng.chance(0.003)) {
          T.log('inventory', h, 'WARN', 'out of stock', end - 0.1, { sku, requested: qty, available: qty - 1 });
          return { end, status: 409, error: 'out of stock' };
        }
        T.log('inventory', h, 'INFO', 'stock reserved', end - 0.1, { sku, qty });
        return { end, status: 200 };
      }),
    });
  }

  // ---- cart ----
  cartGet(T, from, parent, start, userId) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'GET', path: `/cart/${userId}`, route: '/cart/:userId', to: 'cart',
      handler: (server, s) => this.handle(T, 'cart', server, s, '/cart/:userId', (_h, t) => ({ end: t + rng.between(5, 15), status: 200 })),
    });
  }

  cartAdd(T, from, parent, start, userId, sku, qty) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'POST', path: `/cart/${userId}/items`, route: '/cart/:userId/items', to: 'cart',
      handler: (server, s) => this.handle(T, 'cart', server, s, '/cart/:userId/items', (h, t) => {
        const afterSleep = t + rng.between(5, 15);
        const inv = this.invGet(T, 'cart', h, afterSleep + 0.2, sku);
        const end = inv.end + rng.between(0.2, 0.6);
        if (inv.status >= 400) {
          T.log('cart', h, 'WARN', 'request rejected', end - 0.1, { error: inv.errText, status: inv.status });
          return { end, status: inv.status, error: inv.errText };
        }
        T.log('cart', h, 'INFO', 'item added to cart', end - 0.1, { 'user.id': userId, sku, qty });
        return { end, status: 200 };
      }),
    });
  }

  cartClear(T, from, parent, start, userId) {
    const { rng } = this;
    return this.httpCall(T, {
      from, parent, start, method: 'DELETE', path: `/cart/${userId}`, route: '/cart/:userId', to: 'cart',
      handler: (server, s) => this.handle(T, 'cart', server, s, '/cart/:userId', (h, t) => {
        const end = t + rng.between(3, 10);
        T.log('cart', h, 'INFO', 'cart cleared', end - 0.1, { 'user.id': userId });
        return { end, status: 200 };
      }),
    });
  }

  // ---- payment (this is where the incident lives) ----
  charge(T, from, parent, start, userId, amount) {
    const { rng } = this;
    const faulty = this.incidentStart !== null && start >= this.incidentStart;
    const timeoutRate = faulty ? INCIDENT_TIMEOUT_RATE : 0.01;
    return this.httpCall(T, {
      from, parent, start, method: 'POST', path: '/charge', route: '/charge', to: 'payment',
      handler: (server, s) => {
        // fault.js sleeps in a middleware BEFORE the route handler, so the SERVER span includes the delay
        const faultDelay = faulty ? FAULT_LATENCY_MS + rng.between(0, 40) : 0;
        const r = this.handle(T, 'payment', server, s, '/charge', (h, t) => {
          const end = t + rng.between(100, 250);
          if (rng.chance(timeoutRate)) {
            T.log('payment', h, 'ERROR', 'payment gateway timeout', end - 0.1, { 'user.id': userId, amount });
            return { end, status: 500, error: 'payment gateway timeout' };
          }
          if (rng.chance(0.02)) {
            T.log('payment', h, 'WARN', 'card declined', end - 0.1, { 'user.id': userId, amount });
            return { end, status: 402, error: 'card declined' };
          }
          const paymentId = `pay_${rng.hex(4)}`;
          T.log('payment', h, 'INFO', 'payment succeeded', end - 0.1, { 'user.id': userId, amount, 'payment.id': paymentId });
          return { end, status: 200, paymentId };
        }, faultDelay);
        return faulty ? { ...r, serverAttrs: { 'fault.injected': true, 'fault.type': 'latency' } } : r;
      },
    });
  }

  // ---- gateway (entry point of every trace) ----
  gatewayRequest(start, method, route, path, body) {
    const { rng } = this;
    const T = this.newTrace();
    const server = T.begin({
      service: 'gateway', name: `${method} ${route}`, kind: 'SERVER', parent: null, start,
      attrs: { 'http.request.method': method, 'http.route': route, 'url.path': path, 'url.scheme': 'http', 'server.port': SERVICE_PORTS.gateway },
    });
    const r = this.handle(T, 'gateway', server, start, route, (h, t) => body(T, h, t));
    T.finish(server, r.end, { status: r.status >= 500 ? 'ERROR' : 'UNSET', http: r.status });
    return r.end + rng.between(0.1, 0.4);
  }

  // gateway forward(): 4xx passes through, anything else becomes 502 and logs 'downstream failure'
  forward(T, h, r, time) {
    if (r.status < 500) return r.status;
    T.log('gateway', h, 'ERROR', 'downstream failure', time, { error: r.errText });
    return 502;
  }

  browse(start) {
    const { rng } = this;
    return this.gatewayRequest(start, 'GET', '/api/products', '/api/products', (T, h, t) => {
      const r = this.invList(T, 'gateway', h, t + 0.3);
      const end = r.end + rng.between(0.2, 0.6);
      return { end, status: r.status < 400 ? 200 : this.forward(T, h, r, end) };
    });
  }

  viewCart(start, userId) {
    const { rng } = this;
    return this.gatewayRequest(start, 'GET', '/api/cart/:userId', `/api/cart/${userId}`, (T, h, t) => {
      const r = this.cartGet(T, 'gateway', h, t + 0.3, userId);
      const end = r.end + rng.between(0.2, 0.6);
      return { end, status: r.status < 400 ? 200 : this.forward(T, h, r, end) };
    });
  }

  addToCart(start, userId, sku, qty) {
    const { rng } = this;
    let ok = false;
    const end = this.gatewayRequest(start, 'POST', '/api/cart/:userId/items', `/api/cart/${userId}/items`, (T, h, t) => {
      const r = this.cartAdd(T, 'gateway', h, t + 0.3, userId, sku, qty);
      const end2 = r.end + rng.between(0.2, 0.6);
      if (r.status >= 400) return { end: end2, status: this.forward(T, h, r, end2) };
      T.log('gateway', h, 'INFO', 'add to cart', end2 - 0.1, { 'user.id': userId });
      ok = true;
      return { end: end2, status: 200 };
    });
    return { end, ok };
  }

  checkout(start, userId, items) {
    const { rng } = this;
    return this.gatewayRequest(start, 'POST', '/api/checkout', '/api/checkout', (T, h, t) => {
      const orderId = `ord_${rng.hex(4)}`;
      const ids = { 'user.id': userId, 'order.id': orderId };
      T.log('gateway', h, 'INFO', 'checkout started', t + 0.2, ids);
      let c = t + 0.6;

      const cart = this.cartGet(T, 'gateway', h, c, userId);
      c = cart.end + rng.between(0.1, 0.4);
      if (items.length === 0) {
        T.log('gateway', h, 'WARN', 'checkout with empty cart', c, ids);
        return { end: c, status: 400 };
      }

      const fail = (r) => {
        T.log('gateway', h, 'ERROR', 'checkout failed', c, { ...ids, error: r.errText });
        return { end: c + 0.3, status: this.forward(T, h, r, c + 0.2) };
      };

      for (const item of items) {
        const r = this.invReserve(T, 'gateway', h, c, item.sku, item.qty);
        c = r.end + rng.between(0.1, 0.4);
        if (r.status >= 400) return fail(r);
      }
      const total = items.reduce((sum, i) => sum + PRODUCTS[i.sku].price * i.qty, 0);
      const pay = this.charge(T, 'gateway', h, c, userId, total);
      c = pay.end + rng.between(0.1, 0.4);
      if (pay.status >= 400) return fail(pay);

      const clear = this.cartClear(T, 'gateway', h, c, userId);
      c = clear.end + rng.between(0.1, 0.4);
      T.log('gateway', h, 'INFO', 'checkout completed', c, { ...ids, 'payment.id': pay.result.paymentId });
      return { end: c, status: 200 };
    });
  }
}

// ---- public API --------------------------------------------------------------------------------

/**
 * @param {Object} o
 * @param {number} [o.now]              end of the data window (epoch ms)
 * @param {number} [o.minutes=60]       window length
 * @param {number} [o.flowsPerMin=20]   user sessions per minute (about 36 spans each; 60 gives 100K+ spans/hour)
 * @param {number} [o.incidentMinutes=6] length of the "payment slow" incident at the END of the window (0 = none)
 * @param {boolean} [o.incident=true]
 * @param {boolean} [o.anomalies=true]  also produce rows for the anomalies table (so the Anomalies page works before A's detector)
 * @param {number} [o.seed=42]
 */
function generate({ now = Date.now(), minutes = 60, flowsPerMin = 20, incidentMinutes = 6, incident = true, anomalies: withAnomalies = true, seed = 42 } = {}) {
  const t0 = now - minutes * 60_000;
  const incidentStart = incident && incidentMinutes > 0 ? now - incidentMinutes * 60_000 : null;
  const sim = new Simulator({ seed, incidentStart });
  const { rng } = sim;

  // service start-up logs, like the demo services print on boot
  for (const [service, port] of Object.entries(SERVICE_PORTS)) {
    sim.logs.push({ time_ms: Math.floor(t0), service_name: service, level: 'INFO', message: `${service} listening`, trace_id: null, span_id: null, attributes: { port } });
  }
  if (incidentStart !== null) {
    sim.logs.push({
      time_ms: Math.floor(incidentStart), service_name: 'payment', level: 'WARN', message: 'fault injected', trace_id: null, span_id: null,
      attributes: { fault: 'latency', type: 'latency', latencyMs: FAULT_LATENCY_MS },
    });
  }

  // user sessions: browse -> add 1-3 items -> (sometimes look at the cart) -> checkout 40% of the time
  const totalFlows = Math.round(minutes * flowsPerMin);
  const think = () => rng.between(500, 2500);
  for (let i = 0; i < totalFlows; i++) {
    const userId = `user-${rng.int(1, 50)}`;
    let t = rng.between(t0, now - 15_000);
    const run = (fn) => { if (t > now) return null; const r = fn(); t = (typeof r === 'number' ? r : r.end) + think(); return r; };

    run(() => sim.browse(t));
    const items = [];
    for (let k = rng.int(1, 3); k > 0; k--) {
      const sku = rng.chance(0.03) ? 'sku-999' : rng.pick(SKUS); // ~3% invalid sku (404)
      const qty = rng.int(1, 3);
      const r = run(() => sim.addToCart(t, userId, sku, qty));
      if (r?.ok) items.push({ sku, qty });
    }
    if (rng.chance(0.2)) run(() => sim.viewCart(t, userId));
    if (rng.chance(0.4)) run(() => sim.checkout(t, userId, items));
  }

  const spans = sim.spans.sort((a, b) => a.start_time_ms - b.start_time_ms);
  const logs = sim.logs.sort((a, b) => a.time_ms - b.time_ms);

  const summary = { windowStart: t0, windowEnd: now, incidentStart, traces: new Set(spans.map((s) => s.trace_id)).size, spans: spans.length, logs: logs.length };
  const anomalies = [];
  if (incidentStart !== null) {
    const stats = (service, from, to, kind = 'SERVER') => {
      const rows = spans.filter((s) => s.service_name === service && s.kind === kind && s.start_time_ms >= from && s.start_time_ms < to);
      const d = rows.map((s) => s.duration_ms);
      return { n: rows.length, p99: percentile(d, 0.99), errorRate: rows.length ? rows.filter((s) => s.http_status >= 500).length / rows.length : 0 };
    };
    const base = { payment: stats('payment', t0, incidentStart), gateway: stats('gateway', t0, incidentStart) };
    const cur = { payment: stats('payment', incidentStart, now + 1), gateway: stats('gateway', incidentStart, now + 1) };
    summary.payment = { baselineP99: round3(base.payment.p99), currentP99: round3(cur.payment.p99), baselineErrorRate: base.payment.errorRate, currentErrorRate: cur.payment.errorRate };

    if (withAnomalies) {
      const slowestPaymentTraces = spans
        .filter((s) => s.service_name === 'payment' && s.kind === 'SERVER' && s.start_time_ms >= incidentStart)
        .sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 3).map((s) => s.trace_id);
      const details = (service, n) => ({
        seeded: true,
        window: { from_ms: incidentStart, to_ms: now },
        baseline_window: { from_ms: t0, to_ms: incidentStart },
        spans_in_window: n,
        related_trace_ids: slowestPaymentTraces,
      });
      const row = (id, service, metric, baseline, current, detectedAfterMs, n, symptom = false) => {
        const ratio = baseline > 0 ? current / baseline : null;
        return {
          id, detected_at_ms: Math.min(now, incidentStart + detectedAfterMs), service_name: service, metric,
          baseline: round3(baseline), current: round3(current), ratio: ratio === null ? null : round3(ratio),
          severity: !symptom && ratio !== null && ratio >= 5 ? 'CRITICAL' : 'WARNING', // gateway is only a symptom of payment
          root_cause: 'payment', details: details(service, n),
        };
      };
      anomalies.push(
        row('seed-payment-p99', 'payment', 'p99_latency', base.payment.p99, cur.payment.p99, 90_000, cur.payment.n),
        row('seed-payment-errors', 'payment', 'error_rate', Math.max(base.payment.errorRate, 0.005), cur.payment.errorRate, 105_000, cur.payment.n),
        row('seed-gateway-p99', 'gateway', 'p99_latency', base.gateway.p99, cur.gateway.p99, 120_000, cur.gateway.n, true),
      );
    }
  }
  return { spans, logs, anomalies, summary };
}

module.exports = { generate, percentile, SERVICE_PORTS, PRODUCTS, FAULT_LATENCY_MS };
