const express = require('express');
const Redis = require('ioredis');
const { createIdempotencyMiddleware } = require('./middleware/idempotency');

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

app.use(express.json());

const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  }
});

const idempotency = createIdempotencyMiddleware(redis, 86400);

let orders = [];
let nextId = 1;

// POST /api/v1/orders with OpenAPI Schema validation & Idempotency
app.post('/api/v1/orders', idempotency, async (req, res) => {
  const { item_id, quantity, amount } = req.body || {};

  // Schema Validation (from OpenAPI contract)
  if (typeof item_id !== 'number' || typeof quantity !== 'number' || typeof amount !== 'number') {
    return res.status(400).json({
      type: 'https://api.example.com/errors/invalid-schema',
      title: 'Invalid Request Schema',
      status: 400,
      detail: 'item_id (integer), quantity (integer), and amount (number) are required.',
      instance: req.originalUrl
    });
  }

  if (quantity < 1 || amount <= 0) {
    return res.status(400).json({
      type: 'https://api.example.com/errors/out-of-bounds',
      title: 'Value Out of Bounds',
      status: 400,
      detail: 'quantity must be >= 1 and amount must be > 0.',
      instance: req.originalUrl
    });
  }

  // Simulate transactional order execution
  await new Promise(r => setTimeout(r, 60));

  const order = {
    id: nextId++,
    item_id,
    quantity,
    amount: parseFloat(amount.toFixed(2)),
    status: 'CONFIRMED',
    created_at: new Date().toISOString()
  };

  orders.push(order);

  return res.status(201).json(order);
});

// GET /api/v1/orders
app.get('/api/v1/orders', (req, res) => {
  res.json({
    total: orders.length,
    orders: orders
  });
});

// Reset endpoint
app.post('/api/v1/reset', async (req, res) => {
  orders = [];
  nextId = 1;
  const keys = await redis.keys('idemp:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  res.json({ status: 'RESET_OK' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Lab 04 API SERVICE] Running on port ${PORT}`);
    console.log(`Connected to Redis at ${REDIS_URL}`);
  });
}

module.exports = { app, redis };
