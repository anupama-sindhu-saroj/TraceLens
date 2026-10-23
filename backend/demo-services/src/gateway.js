require('./instrument/gateway');

const { randomUUID } = require('node:crypto');
const { createApp, errorHandler, listen, call } = require('./common');
const { url } = require('./config');

const { app, log } = createApp('gateway');

// Pass downstream HTTP status through (404/409/402 stay 4xx, real failures become 5xx)
function forward(res, err) {
  const status = err?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: message });
  } else {
    log.error('downstream failure', { error: message });
    res.status(502).json({ error: 'upstream failure', detail: message });
  }
}

// GET /api/products -> inventory
app.get('/api/products', async (_req, res) => {
  try {
    res.json(await call(url('inventory'), '/stock'));
  } catch (e) {
    forward(res, e);
  }
});

// GET /api/cart/:userId -> cart
app.get('/api/cart/:userId', async (req, res) => {
  try {
    res.json(await call(url('cart'), `/cart/${req.params.userId}`));
  } catch (e) {
    forward(res, e);
  }
});

// POST /api/cart/:userId/items -> cart -> inventory
app.post('/api/cart/:userId/items', async (req, res) => {
  try {
    const out = await call(url('cart'), `/cart/${req.params.userId}/items`, { method: 'POST', body: req.body });
    log.info('add to cart', { 'user.id': req.params.userId });
    res.json(out);
  } catch (e) {
    forward(res, e);
  }
});

// POST /api/checkout -> cart -> inventory (reserve) -> payment -> cart (clear)
app.post('/api/checkout', async (req, res) => {
  const userId = req.body?.userId;
  if (!userId) {
    res.status(400).json({ error: 'userId required' });
    return;
  }
  const orderId = `ord_${randomUUID().slice(0, 8)}`;
  log.info('checkout started', { 'user.id': userId, 'order.id': orderId });
  try {
    const cart = await call(url('cart'), `/cart/${userId}`);
    if (cart.items.length === 0) {
      log.warn('checkout with empty cart', { 'user.id': userId, 'order.id': orderId });
      res.status(400).json({ error: 'cart is empty' });
      return;
    }
    for (const item of cart.items) {
      await call(url('inventory'), '/reserve', { method: 'POST', body: { sku: item.sku, qty: item.qty } });
    }
    const payment = await call(url('payment'), '/charge', {
      method: 'POST',
      body: { userId, amount: cart.total },
    });
    await call(url('cart'), `/cart/${userId}`, { method: 'DELETE' });
    log.info('checkout completed', { 'user.id': userId, 'order.id': orderId, 'payment.id': payment.paymentId });
    res.json({ orderId, paymentId: payment.paymentId, total: cart.total });
  } catch (e) {
    log.error('checkout failed', {
      'user.id': userId,
      'order.id': orderId,
      error: e instanceof Error ? e.message : String(e),
    });
    forward(res, e);
  }
});

app.use(errorHandler(log));
listen(app, 'gateway', log);
