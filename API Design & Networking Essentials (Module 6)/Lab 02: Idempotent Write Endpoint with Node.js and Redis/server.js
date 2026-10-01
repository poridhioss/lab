const express = require('express');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

app.use(express.json());

const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  }
});

// Database state
let orders = [];
let nextId = 1;

// Idempotency Middleware Factory
function idempotencyMiddleware(ttlSeconds = 86400) {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');

    // Only apply to write mutations (POST, PUT, PATCH)
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    if (!key) {
      return res.status(400).json({
        type: 'https://api.example.com/errors/missing-idempotency-key',
        title: 'Missing Idempotency-Key Header',
        status: 400,
        detail: 'An Idempotency-Key header is required for this operation.'
      });
    }

    const redisKey = `idemp:${key}`;

    try {
      // 1. Check existing state
      const cached = await redis.get(redisKey);
      if (cached) {
        if (cached === 'IN_PROGRESS') {
          return res.status(409).json({
            type: 'https://api.example.com/errors/concurrent-mutation',
            title: 'Conflict: Mutation In Progress',
            status: 409,
            detail: 'A request with this Idempotency-Key is currently being processed. Please retry shortly.'
          });
        }

        // Cache Hit: Replay cached response
        const record = JSON.parse(cached);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Idempotency-Replay', 'true');
        return res.status(record.status).json(record.body);
      }

      // 2. Acquire Atomic Lock with 60s timeout
      const acquired = await redis.set(redisKey, 'IN_PROGRESS', 'EX', 60, 'NX');
      if (!acquired) {
        return res.status(409).json({
          type: 'https://api.example.com/errors/concurrent-mutation',
          title: 'Conflict: Concurrent Request',
          status: 409,
          detail: 'Another client is currently executing with this Idempotency-Key.'
        });
      }

      // Cache Miss: Proceed with execution and intercept the response
      res.setHeader('X-Cache', 'MISS');

      const originalSend = res.send.bind(res);
      const originalJson = res.json.bind(res);

      res.json = (body) => {
        // Cache the completed result
        const payloadToCache = {
          status: res.statusCode,
          body: body
        };
        // Save in Redis with TTL (default 24 hours)
        redis.set(redisKey, JSON.stringify(payloadToCache), 'EX', ttlSeconds).catch(err => {
          console.error('[IDEMPOTENCY] Failed to save result to Redis:', err.message);
        });

        return originalJson(body);
      };

      res.send = (body) => {
        try {
          const parsed = JSON.parse(body);
          const payloadToCache = {
            status: res.statusCode,
            body: parsed
          };
          redis.set(redisKey, JSON.stringify(payloadToCache), 'EX', ttlSeconds).catch(() => {});
        } catch (_) {}
        return originalSend(body);
      };

      next();
    } catch (err) {
      console.error('[IDEMPOTENCY ERROR]', err);
      // Fallback: continue without caching if Redis is temporarily unreachable
      next();
    }
  };
}

// Order Mutation Endpoint (Protected by Idempotency Middleware)
app.post('/api/v1/orders', idempotencyMiddleware(86400), async (req, res) => {
  const { amount, description } = req.body || {};

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      title: 'Invalid Order Amount',
      status: 400,
      detail: 'The amount field must be a positive number.'
    });
  }

  // Simulate transactional processing latency (e.g. charging card)
  await new Promise(resolve => setTimeout(resolve, 80));

  const order = {
    id: nextId++,
    amount,
    description: description || 'Standard Order',
    status: 'COMPLETED',
    created_at: new Date().toISOString()
  };

  orders.push(order);

  return res.status(201).json(order);
});

// Query all orders (Diagnostic endpoint)
app.get('/api/v1/orders', (req, res) => {
  res.json({
    total_orders: orders.length,
    orders: orders
  });
});

// Reset endpoint (For test suites)
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
    console.log(`[Lab 02] Idempotent Write Server running on port ${PORT}`);
    console.log(`Connected to Redis at ${REDIS_URL}`);
  });
}

module.exports = { app, redis };
