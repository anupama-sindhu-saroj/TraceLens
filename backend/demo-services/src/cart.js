require('./instrument/cart');

const { createApp, errorHandler, listen, sleep, jitter, call } = require('./common');
const { url } = require('./config');

const { app, log } = createApp('cart');

// userId -> [{ sku, qty, price, name }]
const carts = new Map();

app.get('/cart/:userId', async (req, res) => {
  await sleep(jitter(5, 15));
  const items = carts.get(req.params.userId) ?? [];
  res.json({ userId: req.params.userId, items, total: items.reduce((s, i) => s + i.price * i.qty, 0) });
});

app.post('/cart/:userId/items', async (req, res) => {
  const { userId } = req.params;
  const { sku, qty = 1 } = req.body ?? {};
  if (!sku || qty < 1) {
    log.warn('invalid add-to-cart request', { 'user.id': userId });
    res.status(400).json({ error: 'sku and qty >= 1 required' });
    return;
  }
  await sleep(jitter(5, 15));
  // validate the sku against inventory (cart -> inventory call)
  const product = await call(url('inventory'), `/stock/${sku}`);
  const items = carts.get(userId) ?? [];
  const existing = items.find((i) => i.sku === sku);
  if (existing) existing.qty += qty;
  else items.push({ sku, qty, price: product.price, name: product.name });
  carts.set(userId, items);
  log.info('item added to cart', { 'user.id': userId, sku, qty });
  res.json({ userId, items });
});

app.delete('/cart/:userId', async (req, res) => {
  await sleep(jitter(3, 10));
  carts.delete(req.params.userId);
  log.info('cart cleared', { 'user.id': req.params.userId });
  res.json({ ok: true });
});

app.use(errorHandler(log));
listen(app, 'cart', log);
