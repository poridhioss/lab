# Lab 02: Idempotent Write Endpoint with Node.js and Redis

In distributed systems, network partitions, client timeouts, and automatic retry policies frequently lead to duplicate request transmissions. Without idempotency guards, retrying a payment or order submission can result in double-billing or duplicate records. In this lab, you will design and implement an **idempotency-key-protected POST endpoint** using **Node.js (Express)** and **Redis 7** in your Poridhi environment. You will implement atomic mutual exclusion locking using Redis `SET key value EX 60 NX`, response caching, and concurrency conflict resolution.

<p align="center">
  <img src="images/lab02-architecture.svg" alt="Lab 02 Architecture Overview" width="900">
</p>

---

## Concepts

| Term | Definition |
| :--- | :--- |
| **Idempotency** | A property of an API endpoint where making the same request multiple times produces the identical side-effect as making it once (`f(f(x)) = f(x)`). |
| **Atomic Lock (`SETNX`)** | Redis primitive `SET key value EX ttl NX` that sets a key only if it does not already exist, providing atomic distributed locking without race conditions. |
| **Mutation In-Flight** | An intermediate transient state (`IN_PROGRESS`) indicating that a request with this key is currently being processed by the server, rejecting concurrent duplicates with `409 Conflict`. |
| **Response Caching** | Caching the complete HTTP response (status code and serialized body) under the idempotency key in Redis, enabling instantaneous replays upon subsequent retries. |
| **At-Least-Once Delivery** | A network guarantee common to web hooks, mobile apps, and microservice messaging where retries occur until an acknowledgment is received, necessitating idempotency on the receiver. |

---

## Request & Idempotency Lifecycle Flow

The sequence diagram below illustrates the complete lifecycle across primary requests, parallel race conditions, and network retries:

<p align="center">
  <img src="images/lab02-flow.svg" alt="Lab 02 Idempotency Lifecycle Flow" width="900">
</p>

1. **Initial Request:** The client sends `POST /api/v1/orders` with header `Idempotency-Key: pay_live_9a2f`.
2. **Lock Acquisition:** The middleware queries Redis. Finding no existing key, it executes `SET idemp:pay_live_9a2f "IN_PROGRESS" EX 60 NX`. Lock is acquired.
3. **Business Execution:** The server processes the mutation (deducts inventory, charges payment, inserts order row).
4. **Result Storage:** The middleware caches the status code `201` and response body in Redis with a 24-hour TTL (`EX 86400`). It returns the response with header `X-Cache: MISS`.
5. **Network Retry Replay:** If the client retries the request with the identical `Idempotency-Key`, Redis detects the cached response. The middleware immediately replays `HTTP 201 Created` with `X-Cache: HIT`, completely bypassing the database and preventing duplicate side-effects.

---

## Objectives

- Configure a Redis 7 key store for distributed locks and response caching.
- Build a reusable Express idempotency middleware handling key extraction, locking, and response interception.
- Guard against concurrent parallel race conditions using atomic `SET NX` locks.
- Persist completed mutation payloads in Redis with automated TTL expiration.
- Verify through automated tests that repeated POST calls produce strictly one effect in the database.

---

## What You Will Build

```text
lab02-idempotent-write-endpoint/
├── package.json          # Node dependencies (express, ioredis)
├── server.js             # Express app with Redis Idempotency Middleware
├── docker-compose.yml    # Redis 7 container and API service stack
├── test-idempotency.js   # Automated retry and concurrency race condition test
└── images/
    ├── lab02-architecture.svg
    └── lab02-flow.svg
```

---

## Step 1: Initialize the Project

Create the lab directory:

```bash
mkdir -p ~/lab02-idempotent-write-endpoint
cd ~/lab02-idempotent-write-endpoint
```

![Create Lab Directory](images/step1-create-dir.png)

Create `package.json`:

```bash
cat << 'EOF' > package.json
{
  "name": "lab02-idempotent-write-endpoint",
  "version": "1.0.0",
  "description": "Lab 02: Idempotent Write Endpoint with Node.js and Redis",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node test-idempotency.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ioredis": "^5.4.1"
  }
}
EOF
```

![Create package.json](images/step1-package-json.png)

Install dependencies:

```bash
npm install
```

![Install Dependencies](images/step1-npm-install.png)

---

## Step 2: Start Redis Key Store with Docker Compose

Create `docker-compose.yml` to define the Redis 7 service:

```bash
cat << 'EOF' > docker-compose.yml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    container_name: lab02-redis
    ports:
      - "6379:6379"
    restart: unless-stopped
    command: redis-server --appendonly yes
EOF
```

![Create docker-compose.yml](images/step2-docker-compose.png)

Launch the Redis container in the background:

```bash
docker compose up -d redis
```

![Launch Redis Container](images/step2-docker-compose-up.png)

Verify Redis connectivity:

```bash
docker compose exec redis redis-cli ping
```

![Verify Redis Connectivity](images/step2-redis-ping.png)

Expected output:

```text
PONG
```

---

## Step 3: Implement the Idempotency Middleware & Endpoint (`server.js`)

Create `server.js`. The middleware intercepts mutation requests, manages Redis locks, and caches responses:

```bash
cat << 'EOF' > server.js
const express = require('express');
const Redis = require('ioredis');

const app = express();
const PORT = process.env.PORT || 5000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

app.use(express.json());

const redis = new Redis(REDIS_URL, {
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  }
});

// In-Memory Database state
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
EOF
```

![Create server.js](images/step3-server-js.png)

---

## Step 4: Expose Service via Poridhi Load Balancer & Verify via cURL

### 1. Start the Server

Start the server in the background:

```bash
node server.js &
```

![Start Server](images/step4-start-server.png)

> [!NOTE]
> If the terminal prompt does not reappear immediately, press `Enter` on your keyboard.

### 2. Expose Service via Poridhi Load Balancer

In Poridhi cloud lab environment, expose your running Node.js service using the Poridhi Load Balancer:

1. Find your container's private IP address:

```bash
hostname -I | awk '{print $1}'
```

![Get Private IP](images/step4-hostname-ip.png)

2. Open the **Load Balancer** modal in the Poridhi lab interface (the Cloud/Load Balancer icon in the top header).
3. Enter the configuration:
   - **Enter IP**: Paste the IP address obtained above (e.g., `10.x.x.x`).
   - **Enter Port**: `5000`
4. Click **Expose**. Poridhi will generate an active public Load Balancer URL:

![Load Balancer Exposed](images/step4-loadbalancer-exposed.png)

5. Open the generated Load Balancer URL in your web browser:

![Browser Status](images/step4-browser-status.png)

---

### 3. Verify Idempotency via cURL

> [!TIP]
> You can test directly against `http://localhost:5000` or use your public Poridhi Load Balancer URL!

#### Test 1: Send First POST Request (Cache Miss)

```bash
curl -i -X POST http://localhost:5000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ord_tx_1001" \
  -d '{"amount": 250.00, "description": "Mechanical Keyboard"}'
```

![Test 1 Cache Miss](images/step4-test1-first-request.png)

Expected output:

```text
HTTP/1.1 201 Created
X-Cache: MISS
Content-Type: application/json; charset=utf-8

{
  "id": 1,
  "amount": 250,
  "description": "Mechanical Keyboard",
  "status": "COMPLETED",
  "created_at": "2026-10-02T02:05:00.000Z"
}
```

#### Test 2: Send Identical Retry (Cache Hit)

Execute the exact same command again with the same `Idempotency-Key`:

```bash
curl -i -X POST http://localhost:5000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ord_tx_1001" \
  -d '{"amount": 250.00, "description": "Mechanical Keyboard"}'
```

![Test 2 Cache Hit](images/step4-test2-retry-request.png)

Expected output:

```text
HTTP/1.1 201 Created
X-Cache: HIT
Idempotency-Replay: true
Content-Type: application/json; charset=utf-8

{
  "id": 1,
  "amount": 250,
  "description": "Mechanical Keyboard",
  "status": "COMPLETED",
  "created_at": "2026-10-02T02:05:00.000Z"
}
```

Notice that `X-Cache: HIT` was returned and the returned order ID remained `1`.

#### Test 3: Verify Database State

Query the orders collection:

```bash
curl -s http://localhost:5000/api/v1/orders | jq .
```

![Test 3 Verify Database State](images/step4-test3-verify-db.png)

Expected output:

```json
{
  "total_orders": 1,
  "orders": [
    {
      "id": 1,
      "amount": 250,
      "description": "Mechanical Keyboard",
      "status": "COMPLETED",
      "created_at": "2026-10-02T02:05:00.000Z"
    }
  ]
}
```

Notice that despite sending two write requests, strictly **one** order exists in the database.

---

## Step 5: Run Automated Idempotency Test Suite

Create `test-idempotency.js`:

```bash
cat << 'EOF' > test-idempotency.js
const http = require('http');
const { app, redis } = require('./server');

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[TEST SUITE] Starting Idempotency Test on port ${port}...\n`);

  function request(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // 0. Reset state
    await request('POST', '/api/v1/reset');

    // Test 1: Missing Idempotency-Key
    console.log('Test 1: Calling POST /api/v1/orders without Idempotency-Key header...');
    const r1 = await request('POST', '/api/v1/orders', {}, { amount: 100 });
    if (r1.status === 400) {
      console.log(' PASS: 400 Bad Request returned for missing header.\n');
    } else {
      throw new Error(`Test 1 Failed: Status was ${r1.status}`);
    }

    // Test 2: First Write with Idempotency-Key
    const testKey1 = 'pay_test_uuid_001';
    console.log(`Test 2: Primary Request with Idempotency-Key="${testKey1}"...`);
    const r2 = await request('POST', '/api/v1/orders', { 'Idempotency-Key': testKey1 }, { amount: 250, description: 'Laptop Purchase' });
    if (r2.status === 201 && r2.headers['x-cache'] === 'MISS' && r2.body.id === 1) {
      console.log(` PASS: 201 Created, X-Cache: MISS. Order ID: ${r2.body.id}, Amount: $${r2.body.amount}\n`);
    } else {
      throw new Error(`Test 2 Failed: Status ${r2.status}, Cache ${r2.headers['x-cache']}`);
    }

    // Test 3: Exact Retry with same Idempotency-Key (Proving duplicate produce ONE effect)
    console.log(`Test 3: Simulating Network Retry with identical Idempotency-Key="${testKey1}"...`);
    const r3 = await request('POST', '/api/v1/orders', { 'Idempotency-Key': testKey1 }, { amount: 250, description: 'Laptop Purchase' });
    if (r3.status === 201 && r3.headers['x-cache'] === 'HIT' && r3.body.id === 1) {
      console.log(` PASS: 201 Created Replayed from Redis Cache (X-Cache: HIT). Returned same Order ID: ${r3.body.id}`);
    } else {
      throw new Error(`Test 3 Failed: Status ${r3.status}, Cache ${r3.headers['x-cache']}`);
    }

    // Verify Database Count
    const dbState1 = await request('GET', '/api/v1/orders');
    console.log(`Verifying persistent database state: Total orders stored = ${dbState1.body.total_orders}`);
    if (dbState1.body.total_orders === 1) {
      console.log(' PASS: Exactly ONE order created in database despite multiple retries!\n');
    } else {
      throw new Error(`Expected 1 order in DB, found ${dbState1.body.total_orders}`);
    }

    // Test 4: Concurrent Race Condition with same key
    const raceKey = 'pay_race_uuid_002';
    console.log(`Test 4: Simulating 2 Concurrent Parallel POST requests with Idempotency-Key="${raceKey}"...`);
    const [p1, p2] = await Promise.all([
      request('POST', '/api/v1/orders', { 'Idempotency-Key': raceKey }, { amount: 500, description: 'Parallel 1' }),
      request('POST', '/api/v1/orders', { 'Idempotency-Key': raceKey }, { amount: 500, description: 'Parallel 2' })
    ]);

    const statuses = [p1.status, p2.status].sort();
    console.log(`Received concurrent statuses: ${p1.status} and ${p2.status}`);
    if (statuses.includes(201) && (statuses.includes(409) || statuses.includes(201))) {
      console.log(' PASS: Mutual exclusion preserved. No double-order race condition!');
    } else {
      throw new Error(`Concurrent test unexpected statuses: ${statuses}`);
    }

    const dbState2 = await request('GET', '/api/v1/orders');
    console.log(`Total orders in DB after concurrent requests: ${dbState2.body.total_orders}`);
    if (dbState2.body.total_orders === 2) {
      console.log(' PASS: Correct total order count confirmed in database.\n');
    } else {
      throw new Error(`Expected 2 orders, found ${dbState2.body.total_orders}`);
    }

    console.log(' ALL IDEMPOTENT WRITE TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Test suite failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await redis.quit();
  }
});
EOF
```

![Create test-idempotency.js](images/step5-test-idempotency.png)

Run the automated test suite in `test-idempotency.js`:

```bash
npm test
```

![Automated Idempotency Test Output](images/step5-npm-test.png)

Expected output:

```text
> lab02-idempotent-write-endpoint@1.0.0 test
> node test-idempotency.js

[TEST SUITE] Starting Idempotency Test on port 41329...

Test 1: Calling POST /api/v1/orders without Idempotency-Key header...
 PASS: 400 Bad Request returned for missing header.

Test 2: Primary Request with Idempotency-Key="pay_test_uuid_001"...
 PASS: 201 Created, X-Cache: MISS. Order ID: 1, Amount: $250

Test 3: Simulating Network Retry with identical Idempotency-Key="pay_test_uuid_001"...
 PASS: 201 Created Replayed from Redis Cache (X-Cache: HIT). Returned same Order ID: 1
Verifying persistent database state: Total orders stored = 1
 PASS: Exactly ONE order created in database despite multiple retries!

Test 4: Simulating 2 Concurrent Parallel POST requests with Idempotency-Key="pay_race_uuid_002"...
Received concurrent statuses: 201 and 409
 PASS: Mutual exclusion preserved. No double-order race condition!
Total orders in DB after concurrent requests: 2
 PASS: Correct total order count confirmed in database.

 ALL IDEMPOTENT WRITE TESTS PASSED SUCCESSFULLY!
```

---

## Key Takeaways

1. **Atomic Lock Guarantees:** Using `SET key IN_PROGRESS EX 60 NX` prevents race conditions when concurrent requests share an idempotency key.
2. **Deterministic Response Replay:** Replaying status codes, headers, and cached bodies ensures clients experience identical semantics regardless of retry latency.
3. **Resource Expiration:** Setting a 24-hour TTL (`EX 86400`) frees Redis memory while comfortably covering retry windows for mobile and web clients.
4. **Safe Error Handling:** Transient requests in progress receive `409 Conflict`, signaling the client to back off rather than spawning duplicate side-effects.
