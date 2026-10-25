# TraceLens

Self-hosted observability platform (OpenTelemetry traces + logs): OTLP HTTP/gRPC ingestion, DuckDB storage, trace flamegraph,
live log explorer, service topology, anomaly detection with root-cause hints, and a Demo Controls drawer to inject faults.
Plain JavaScript (CommonJS backend, React + Vite frontend), no build step for the backend.

## Structure

```
.
├─ backend/
│  ├─ server/              # API :8080, OTLP/HTTP :4318, OTLP/gRPC :4317, WebSocket live tail, DuckDB
│  │  ├─ src/
│  │  │  ├─ db/            # schema.sql, DuckDB connection, appender, query() (BigInt -> Number)
│  │  │  ├─ ingest/        # http.js, grpc.js, otlp-parser.js, batcher.js
│  │  │  ├─ api/           # traces, stats, logs, topology, anomalies, demo (fault injection)
│  │  │  ├─ anomaly/       # detector.js, rootcause.js
│  │  │  ├─ ws/            # logs.js (live tail)
│  │  │  └─ shared/        # health.js, types.js
│  │  ├─ proto/            # OTLP protos (trace + logs)
│  │  ├─ scripts/          # seed.js, seed-data.js, seed-otlp.js, seed-ingest.js
│  │  └─ test/             # node:test suites (npm test)
│  ├─ demo-services/       # gateway, cart, inventory, payment (OTel instrumented, fault.js)
│  ├─ loadgenerator/       # virtual users (browse -> add to cart -> checkout)
│  └─ tools/otlp-sink/     # dev-only fake OTLP/HTTP receiver
├─ frontend/               # React + Vite: Dashboard, Traces (+ flamegraph, span panel), Logs, Topology, Anomalies, Demo Controls
└─ .env.example
```

## Setup

Requirements: Node 20+ (tested on Node 22).

```bash
npm install
```

Note: `.env` file auto-load nahi hoti; config env vars se hoti hai (defaults sahi hain, `.env.example` sirf reference ke liye hai).

## Run (3 terminals)

```bash
npm run server                                # 1) API :8080 + OTLP HTTP :4318 + OTLP gRPC :4317 + DuckDB
npm run services                              # 2) gateway :3000, cart :3001, inventory :3002, payment :3003
npm run loadgen -- --rps 5 --duration 60      # 3) traffic
npm run web                                   # 4) UI on http://localhost:5173 (proxies /api and /ws to :8080)
```

Load generator flags: `--rps` (flows/sec, default 5), `--duration` (sec, 0 = forever), `--users` (default 50), `--checkout` (0..1, default 0.4).

Manual check:

```bash
curl -X POST localhost:3000/api/cart/user-1/items -H 'content-type: application/json' -d '{"sku":"sku-001","qty":2}'
curl -X POST localhost:3000/api/checkout -H 'content-type: application/json' -d '{"userId":"user-1"}'
```

## Exporter protocol (HTTP json / protobuf / gRPC)

Har service ka alag env var hai. Day-4 check ke liye 2 services gRPC pe, 2 HTTP pe:

```bash
GATEWAY_PROTOCOL=json CART_PROTOCOL=proto INVENTORY_PROTOCOL=grpc PAYMENT_PROTOCOL=grpc npm run services
```

- `json`  -> `POST {OTLP_HTTP_ENDPOINT}/v1/traces|logs` (application/json) - curl wala test
- `proto` -> same URLs, application/x-protobuf
- `grpc`  -> `OTLP_GRPC_ENDPOINT` (default http://localhost:4317). Server ka gRPC ingestion (`:4317`) chalna chahiye.

Windows PowerShell: `$env:CART_PROTOCOL="proto"; npm run services`

## API behind the gateway

| Route | Calls |
|---|---|
| GET /api/products | gateway -> inventory |
| GET /api/cart/:userId | gateway -> cart |
| POST /api/cart/:userId/items `{sku, qty}` | gateway -> cart -> inventory |
| POST /api/checkout `{userId}` | gateway -> cart -> inventory (reserve) -> payment -> cart (clear) |

Baseline (healthy) behaviour, taaki anomaly detection ko saaf signal mile:
payment latency 100-250 ms (p99 ~ 200 ms), ~1% 500 errors, ~2% 402 (declined); ~3% add-to-cart requests invalid sku (404).

## Contracts between demo services and failure injection

- Har service `faultMiddleware(service)` ko `common.js -> createApp()` mein ek line se lagati hai (`demo-services/src/fault.js`).
- Logs mein dynamic tags: `user.id`, `order.id`, `payment.id`, `sku`. Log records ke saath `trace_id`/`span_id` OTel khud attach karta hai.
- Resource attributes: `service.name` (gateway|cart|inventory|payment), `service.version`, `deployment.environment=demo`.
- Express ke per-middleware spans band hain (noise kam): trace mein server span + route handler span + client (fetch) spans dikhte hain.

## Troubleshooting

- `EADDRINUSE`: purani process chal rahi hai, band karo (ports 3000-3003, 4318).
- Spans alag-alag traces mein dikhein: `instrument/<service>` ko service file ka **pehla import** rakho.
- Exporter errors (`ECONNREFUSED :4318`): sink / ingestion start nahi hai. Services phir bhi chalti hain, bas telemetry drop hoti hai.

## Seeding: direct vs through ingestion

`backend/server/scripts/seed.js` can put the fake data into DuckDB in two ways:

```bash
# 1) direct (default): writes into the DB file. Server must be STOPPED.
npm run seed -w backend/server -- --reset

# 2) through ingestion: server must be RUNNING (npm run server)
npm run seed -w backend/server -- --via http         # OTLP/HTTP JSON      -> :4318
npm run seed -w backend/server -- --via http-proto   # OTLP/HTTP protobuf   -> :4318
npm run seed -w backend/server -- --via grpc         # OTLP/gRPC            -> :4317
npm run seed:ingest -w backend/server                # mixed: rotates all three in one run
```

Through ingestion the seed goes parser -> batcher -> DuckDB like real traffic, and at the end it compares
rows sent with rows written/dropped (from `/api/health`). Seeded anomaly rows are not sent; the detector must create them.
To wipe the tables: stop the server, run `npm run seed -w backend/server -- --clear`, start the server again.
Tests: `npm run test:seed-ingest -w backend/server`.

## Tests

```bash
npm test                    # backend/server, all suites (55 tests)
npm test -w frontend        # frontend lib tests
npm run build -w frontend   # production build
npm run lint -w frontend
```
