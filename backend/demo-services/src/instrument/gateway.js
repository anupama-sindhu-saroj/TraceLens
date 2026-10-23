// Side-effect import. Must be the FIRST require of gateway.js so OpenTelemetry
// patches http/express/fetch before they are loaded.
const { initTelemetry } = require('../telemetry');
initTelemetry('gateway');
