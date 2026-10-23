// ─────────────────────────────────────────────────────────────
// OWNER: B (Failure Injection, feature 3).
// This is only a PASS-THROUGH STUB so that A's services run today.
// B replaces this file with the real latency/error injection logic
// (and the /api/demo control surface). The exported name
// `faultMiddleware` and its signature must stay the same.
// ─────────────────────────────────────────────────────────────
function faultMiddleware(_service) {
  return (_req, _res, next) => next();
}

module.exports = { faultMiddleware };
