// Load generator: simulates virtual users shopping against the gateway.
// Usage: npm run loadgen -- --rps 5 --duration 60 --users 50
//   --rps       target requests/second for the main user flow (default 5)
//   --duration  seconds to run, 0 = run until Ctrl+C (default 0)
//   --users     size of the fake user pool (default 50)
//   --checkout  fraction of flows that go on to checkout, 0..1 (default 0.4)

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : def;
};

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const RPS = arg('rps', 5);
const DURATION = arg('duration', 0);
const USERS = arg('users', 50);
const CHECKOUT_RATE = arg('checkout', 0.4);

const SKUS = ['sku-001', 'sku-002', 'sku-003', 'sku-004', 'sku-005'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const stats = new Map();
let inFlight = 0;

async function hit(label, path, method = 'GET', body) {
  const start = performance.now();
  const s = stats.get(label) ?? { count: 0, ok: 0, s4xx: 0, s5xx: 0, neterr: 0, totalMs: 0, maxMs: 0 };
  let status = 0;
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    await res.arrayBuffer();
    status = res.status;
  } catch {
    s.neterr++;
  }
  const ms = performance.now() - start;
  s.count++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  if (status >= 200 && status < 300) s.ok++;
  else if (status >= 400 && status < 500) s.s4xx++;
  else if (status >= 500) s.s5xx++;
  stats.set(label, s);
  return status;
}

// One virtual-user journey: browse -> add 1-3 items -> (maybe) checkout.
// A small share of requests are intentionally bad to generate realistic 4xx.
async function userFlow() {
  const user = `user-${Math.floor(Math.random() * USERS) + 1}`;
  inFlight++;
  try {
    await hit('GET /api/products', '/api/products');
    const adds = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < adds; i++) {
      const sku = Math.random() < 0.03 ? 'sku-999' : pick(SKUS); // 3% -> 404
      await hit('POST /api/cart/:id/items', `/api/cart/${user}/items`, 'POST', { sku, qty: 1 + Math.floor(Math.random() * 2) });
    }
    await hit('GET /api/cart/:id', `/api/cart/${user}`);
    if (Math.random() < CHECKOUT_RATE) {
      await hit('POST /api/checkout', '/api/checkout', 'POST', { userId: user });
    }
  } finally {
    inFlight--;
  }
}

function printStats() {
  const rows = [...stats.entries()].map(([k, s]) => ({
    endpoint: k,
    reqs: s.count,
    '2xx': s.ok,
    '4xx': s.s4xx,
    '5xx': s.s5xx,
    'net-err': s.neterr,
    'avg ms': Math.round(s.totalMs / Math.max(s.count, 1)),
    'max ms': Math.round(s.maxMs),
  }));
  console.log(`\n--- load stats (in-flight flows: ${inFlight}) ---`);
  console.table(rows);
}

async function main() {
  // sanity check so a dead gateway gives a clear message
  try {
    await fetch(`${GATEWAY}/health`);
  } catch {
    console.error(`Gateway not reachable at ${GATEWAY}. Start services first: npm run services`);
    process.exit(1);
  }
  console.log(`[loadgen] ${RPS} flows/s -> ${GATEWAY}, ${DURATION ? DURATION + 's' : 'until Ctrl+C'}, ${USERS} users`);

  // Poisson-ish arrivals: tick every 100ms, launch flows with probability rps*0.1
  const tick = setInterval(() => {
    const expected = RPS * 0.1;
    let n = Math.floor(expected);
    if (Math.random() < expected - n) n++;
    for (let i = 0; i < n; i++) void userFlow();
  }, 100);
  const statTimer = setInterval(printStats, 10_000);

  const stop = async () => {
    clearInterval(tick);
    clearInterval(statTimer);
    // let in-flight flows drain (max 5s)
    for (let i = 0; i < 50 && inFlight > 0; i++) await new Promise((r) => setTimeout(r, 100));
    printStats();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (DURATION > 0) setTimeout(stop, DURATION * 1000);
}

void main();
