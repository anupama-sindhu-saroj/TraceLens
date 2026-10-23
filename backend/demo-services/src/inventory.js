require('./instrument/inventory');

const { createApp, errorHandler, listen, sleep, jitter } = require('./common');

const { app, log } = createApp('inventory');

const stock = new Map([
  ['sku-001', { name: 'Mechanical Keyboard', price: 4999, qty: 500 }],
  ['sku-002', { name: 'USB-C Hub', price: 1999, qty: 500 }],
  ['sku-003', { name: 'Noise Cancelling Headphones', price: 7999, qty: 500 }],
  ['sku-004', { name: 'Webcam 1080p', price: 3499, qty: 500 }],
  ['sku-005', { name: 'Laptop Stand', price: 1499, qty: 500 }],
]);

app.get('/stock', async (_req, res) => {
  await sleep(jitter(10, 30));
  res.json(Array.from(stock, ([sku, v]) => ({ sku, ...v })));
});

app.get('/stock/:sku', async (req, res) => {
  await sleep(jitter(8, 25));
  const item = stock.get(req.params.sku);
  if (!item) {
    log.warn('sku not found', { sku: req.params.sku });
    res.status(404).json({ error: 'sku not found' });
    return;
  }
  res.json({ sku: req.params.sku, ...item });
});

app.post('/reserve', async (req, res) => {
  const { sku, qty } = req.body ?? {};
  await sleep(jitter(15, 40));
  const item = stock.get(sku);
  if (!item) {
    log.warn('reserve: sku not found', { sku });
    res.status(404).json({ error: 'sku not found' });
    return;
  }
  if (item.qty < qty) {
    log.warn('out of stock', { sku, requested: qty, available: item.qty });
    res.status(409).json({ error: 'out of stock' });
    return;
  }
  item.qty -= qty;
  // demo-friendly: restock so the demo never runs dry
  if (item.qty < 50) item.qty = 500;
  log.info('stock reserved', { sku, qty });
  res.json({ ok: true, sku, qty });
});

app.use(errorHandler(log));
listen(app, 'inventory', log);
