// Starts all 4 demo services as child processes, prefixing their output.
// Per-service exporter protocol comes from env: GATEWAY_PROTOCOL, CART_PROTOCOL, ...
const { spawn } = require('node:child_process');
const path = require('node:path');

const names = ['inventory', 'payment', 'cart', 'gateway']; // dependencies first
const children = [];

for (const name of names) {
  const child = spawn(process.execPath, [path.join(__dirname, `${name}.js`)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code) => {
    console.log(`[start-all] ${name} exited (${code})`);
  });
  children.push(child);
}

const stop = () => {
  children.forEach((c) => c.kill('SIGTERM'));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('[start-all] started: ' + names.join(', ') + '  (Ctrl+C to stop)');
