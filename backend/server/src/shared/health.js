// Service health rule: ONE place so the Dashboard (A), Topology (B), MCP get_service_health (B) show the same color.
// Owner: B (feature 14). A created this first version because the Dashboard needed it; B may tune the numbers,
// but keep the export names (classifyHealth, HEALTH_THRESHOLDS) and the 4 return values.
//
//   classifyHealth({ requests, errorRate, p99Ms }) -> 'healthy' | 'degraded' | 'failing' | 'unknown'
//   healthy = green, degraded = orange, failing = red, unknown = grey (no traffic in the window)
//
// Baseline demo traffic is ~1% 5xx and payment p99 ~250 ms, so those stay green.
const HEALTH_THRESHOLDS = {
  degraded: { errorRate: 0.03, p99Ms: 500 },
  failing: { errorRate: 0.1, p99Ms: 1000 },
};

function classifyHealth({ requests = 0, errorRate = 0, p99Ms = 0 } = {}) {
  if (!requests) return 'unknown';
  const { failing, degraded } = HEALTH_THRESHOLDS;
  if (errorRate >= failing.errorRate || p99Ms >= failing.p99Ms) return 'failing';
  if (errorRate >= degraded.errorRate || p99Ms >= degraded.p99Ms) return 'degraded';
  return 'healthy';
}

module.exports = { classifyHealth, HEALTH_THRESHOLDS };
