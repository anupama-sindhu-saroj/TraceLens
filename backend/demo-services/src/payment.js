require('./instrument/payment');

const { randomUUID } = require('node:crypto');
const { createApp, errorHandler, listen, sleep, jitter } = require('./common');

const { app, log } = createApp('payment');

// Baseline: ~100-250ms latency (so healthy p99 is ~200ms), ~1% flaky 500s, ~2% card declines (402).
app.post('/charge', async (req, res) => {
  const { userId, amount } = req.body ?? {};
  if (!userId || typeof amount !== 'number' || amount <= 0) {
    log.warn('invalid charge request', { 'user.id': String(userId) });
    res.status(400).json({ error: 'userId and positive amount required' });
    return;
  }

  await sleep(jitter(100, 250));

  if (Math.random() < 0.01) {
    log.error('payment gateway timeout', { 'user.id': userId, amount });
    res.status(500).json({ error: 'payment gateway timeout' });
    return;
  }
  if (Math.random() < 0.02) {
    log.warn('card declined', { 'user.id': userId, amount });
    res.status(402).json({ error: 'card declined' });
    return;
  }

  const paymentId = `pay_${randomUUID().slice(0, 8)}`;
  log.info('payment succeeded', { 'user.id': userId, amount, 'payment.id': paymentId });
  res.json({ ok: true, paymentId });
});

app.use(errorHandler(log));
listen(app, 'payment', log);
