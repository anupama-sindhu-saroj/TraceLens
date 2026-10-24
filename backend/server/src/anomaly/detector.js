// Anomaly detection (feature 16, owner: A).
//   const { runDetection, startDetector } = require('./anomaly/detector');
//   const created = await runDetection();     // one pass, returns the anomaly rows it wrote
//   const d = startDetector(); ... d.stop();  // every 10 s (server/src/index.js does this)
//
// Idea: for every service compare the SERVER spans of a short CURRENT window with a longer BASELINE window
// shortly before it (30 min, ending 5 min earlier). p99 latency and 5xx error rate are checked. Rows go to the `anomalies` table; B's
// findRootCause() fills `root_cause` (stub returns null until B finishes it).
//
// False-alarm guards (risk table): >= minSpans spans in BOTH windows, p99 floor 100 ms, and at least
// minBad really-bad spans, so one slow request in a quiet service never raises an alarm.
// Cooldown: the same service+metric is not reported again for 5 min unless the severity gets worse.
const db = require('../db');
const { findRootCause } = require('./rootcause');
const { ERROR_SQL } = require('../api/util');

const DEFAULTS = {
  currentWindowsMs: [120_000, 300_000], // try 2 min first; widen to 5 min when a service has < minSpans spans
  baselineWindowMs: 30 * 60_000,        // 30 min of baseline ...
  baselineGapMs: 5 * 60_000,            // ... that ends 5 min BEFORE the current window, so the start of an incident does not pollute its own baseline
  minSpans: 20,
  minBad: 3,
  p99FloorMs: 100,
  p99WarnRatio: 3,
  p99CritRatio: 5,
  errorBaselineFloor: 0.005,            // baseline of 0 errors counts as 0.5%, so ratio stays finite
  errorMinRate: 0.05,
  errorWarnRatio: 5,
  errorCritRatio: 10,
  errorCritRate: 0.1,
  cooldownMs: 5 * 60_000,
};

const SEVERITY_RANK = { WARNING: 1, CRITICAL: 2 };
const round3 = (n) => Math.round(n * 1000) / 1000;

async function windowStats(from, to) {
  const rows = await db.query(
    `SELECT service_name, count(*) AS n,
            quantile_cont(duration_ms, 0.99) AS p99,
            count(*) FILTER (WHERE ${ERROR_SQL}) AS errors
     FROM spans WHERE kind = 'SERVER' AND start_time_ms >= ? AND start_time_ms < ?
     GROUP BY service_name`, [from, to]);
  return new Map(rows.map((r) => [r.service_name, { n: r.n, p99: r.p99, errors: r.errors, errorRate: r.n ? r.errors / r.n : 0 }]));
}

async function sampleTraces(service, from, to, where, params) {
  const rows = await db.query(
    `SELECT trace_id FROM spans
     WHERE service_name = ? AND kind = 'SERVER' AND start_time_ms >= ? AND start_time_ms < ? AND ${where}
     ORDER BY duration_ms DESC LIMIT 3`, [service, from, to, ...params]);
  return rows.map((r) => r.trace_id);
}

function judgeLatency(cur, base, o) {
  if (cur.p99 < o.p99FloorMs || base.p99 <= 0) return null;
  const ratio = cur.p99 / base.p99;
  if (ratio < o.p99WarnRatio) return null;
  return { ratio, severity: ratio >= o.p99CritRatio ? 'CRITICAL' : 'WARNING' };
}

function judgeErrors(cur, base, o) {
  if (cur.errors < o.minBad || cur.errorRate < o.errorMinRate) return null;
  const baseline = Math.max(base.errorRate, o.errorBaselineFloor);
  const ratio = cur.errorRate / baseline;
  if (ratio < o.errorWarnRatio) return null;
  const critical = ratio >= o.errorCritRatio && cur.errorRate >= o.errorCritRate;
  return { ratio, severity: critical ? 'CRITICAL' : 'WARNING', baseline };
}

let running = null;

// One detection pass. opts.now lets tests pin the clock; other opts override DEFAULTS.
function runDetection(opts = {}) {
  if (running) return running; // never run two passes at once
  running = detect(opts).finally(() => { running = null; });
  return running;
}

async function detect(opts) {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now();

  const recent = await db.query(
    'SELECT service_name, metric, severity FROM anomalies WHERE detected_at_ms > ?', [now - o.cooldownMs]);
  const lastSeverity = new Map();
  for (const r of recent) {
    const key = `${r.service_name}|${r.metric}`;
    lastSeverity.set(key, Math.max(lastSeverity.get(key) ?? 0, SEVERITY_RANK[r.severity] ?? 0));
  }

  const created = [];
  const handled = new Set();
  for (const win of o.currentWindowsMs) {
    const curFrom = now - win;
    const baseTo = curFrom - o.baselineGapMs;
    const baseFrom = baseTo - o.baselineWindowMs;
    const [current, baseline] = await Promise.all([windowStats(curFrom, now + 1), windowStats(baseFrom, baseTo)]);

    for (const [service, cur] of current) {
      const base = baseline.get(service);
      if (handled.has(service) || cur.n < o.minSpans) continue; // wider window may give this service enough spans
      handled.add(service);
      if (!base || base.n < o.minSpans) continue;                // no trustworthy baseline yet

      const findings = [];
      const lat = judgeLatency(cur, base, o);
      if (lat) {
        // at least minBad spans must really be above the warning line (p99 of a small sample is just its max)
        const [{ n }] = await db.query(
          `SELECT count(*) AS n FROM spans WHERE service_name = ? AND kind = 'SERVER'
           AND start_time_ms >= ? AND start_time_ms < ? AND duration_ms > ?`,
          [service, curFrom, now + 1, base.p99 * o.p99WarnRatio]);
        if (n >= o.minBad) findings.push({ metric: 'p99_latency', baseline: base.p99, current: cur.p99, ...lat, bad: n });
      }
      const err = judgeErrors(cur, base, o);
      if (err) findings.push({ metric: 'error_rate', baseline: err.baseline, current: cur.errorRate, ...err, bad: cur.errors });

      for (const f of findings) {
        const prev = lastSeverity.get(`${service}|${f.metric}`) ?? 0;
        if (prev >= SEVERITY_RANK[f.severity]) continue; // cooldown: already reported at this level
        const related = f.metric === 'p99_latency'
          ? await sampleTraces(service, curFrom, now + 1, 'duration_ms > ?', [base.p99 * o.p99WarnRatio])
          : await sampleTraces(service, curFrom, now + 1, ERROR_SQL, []);
        const row = {
          id: `det-${service}-${f.metric}-${now}`,
          detected_at_ms: now,
          service_name: service,
          metric: f.metric,
          baseline: round3(f.baseline),
          current: round3(f.current),
          ratio: round3(f.ratio),
          severity: f.severity,
          root_cause: null,
          details: {
            window: { from_ms: curFrom, to_ms: now },
            baseline_window: { from_ms: baseFrom, to_ms: baseTo },
            spans_in_window: cur.n,
            bad_spans: f.bad,
            related_trace_ids: related,
          },
        };
        try {
          const rc = await findRootCause(row);
          row.root_cause = rc && typeof rc === 'object' ? (rc.service ?? null) : (rc ?? null);
        } catch (e) {
          console.error('[detector] findRootCause failed:', e.message); // keep the anomaly even if B's code throws
        }
        created.push(row);
      }
    }
  }
  if (created.length) {
    await db.insertAnomalies(created);
    for (const a of created) {
      console.log(`[detector] ${a.severity} ${a.service_name} ${a.metric}: ${a.baseline} -> ${a.current} (${a.ratio}x)`);
    }
  }
  return created;
}

function startDetector({ intervalMs = 10_000 } = {}) {
  const timer = setInterval(() => {
    runDetection().catch((e) => console.error('[detector] run failed:', e.message));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { runDetection, startDetector, DEFAULTS };
