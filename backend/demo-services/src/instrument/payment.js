// Side-effect import. Must be the FIRST require of payment.js so OpenTelemetry
// patches http/express/fetch before they are loaded.
const { initTelemetry } = require('../telemetry');
initTelemetry('payment');
