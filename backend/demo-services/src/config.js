// Ports, URLs and protocol for every demo service in one place.
// protocol: 'json' | 'proto' | 'grpc'
const SERVICES = {
  gateway: { port: 3000, envKey: 'GATEWAY_PROTOCOL' },
  cart: { port: 3001, envKey: 'CART_PROTOCOL' },
  inventory: { port: 3002, envKey: 'INVENTORY_PROTOCOL' },
  payment: { port: 3003, envKey: 'PAYMENT_PROTOCOL' },
};

const url = (name) =>
  process.env[`${name.toUpperCase()}_URL`] ?? `http://localhost:${SERVICES[name].port}`;

const protocolFor = (name) => {
  const p = (process.env[SERVICES[name].envKey] ?? process.env.OTLP_PROTOCOL ?? 'json').toLowerCase();
  if (p !== 'json' && p !== 'proto' && p !== 'grpc') {
    throw new Error(`Invalid protocol "${p}" for ${name}. Use json | proto | grpc`);
  }
  return p;
};

const endpoints = {
  http: process.env.OTLP_HTTP_ENDPOINT ?? 'http://localhost:4318',
  grpc: process.env.OTLP_GRPC_ENDPOINT ?? 'http://localhost:4317',
};

module.exports = { SERVICES, url, protocolFor, endpoints };
