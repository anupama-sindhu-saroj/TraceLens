// Side-effect import. Must be the FIRST require of cart.js so OpenTelemetry
// patches http/express/fetch before they are loaded.
const { initTelemetry } = require('../telemetry');
initTelemetry('cart');
