# Lab 02: Idempotent Write Endpoint with Node.js and Redis

Welcome to **Lab 02**! In this lab, you will tackle one of the most critical challenges in distributed systems and backend engineering: **ensuring safe, idempotent write mutations under network retries and concurrent race conditions**.

Imagine a user shopping on a mobile app on a spotty cellular connection. They tap "Pay $250". The server receives the request, charges their credit card, and creates the order in the database. But just before the `200 OK` response packet reaches the phone, the cellular tower drops the connection. The mobile client times out and automatically retries the payment request.

Without **Idempotency Protection**, the customer gets charged twice and two duplicate orders appear in the database!

In this lab, you will design and implement a production-grade **Idempotency Middleware** using **Node.js (Express)** and **Redis 7** in your Poridhi cloud environment. You will harness Redis atomic locks (`SET key value EX 60 NX`), intermediate state tracking (`IN_PROGRESS`), and automated response caching with TTL expiration.

---

## Architecture & Unified Caching Topology

Below is the complete architectural layout and end-to-end idempotency lifecycle for the service you will build. Everything—from the client request, network routing through the Poridhi Load Balancer, distributed Redis locking, database mutation, and instant cache replaying—is captured in this unified design:

<p align="center">
  <img src="images/lab02-architecture.svg" alt="Lab 02 Architecture & Caching Topology" width="950">
</p>

### Understanding the Three Execution Lifecycles

As illustrated in the diagram above, your middleware handles three distinct operational scenarios:

1. **First Mutation Lifecycle (`X-Cache: MISS`):**
   - The client sends `POST /api/v1/orders` with an `Idempotency-Key` header (e.g., `ord_tx_1001`).
   - The middleware attempts an atomic lock in Redis: `SET idemp:ord_tx_1001 "IN_PROGRESS" EX 60 NX`.
   - The key did not exist, so Redis grants the lock.
   - The server proceeds to execute the business logic, creating Order #1 in the database.
   - Before sending the response, the middleware intercepts the payload and caches `{ status: 201, body: order }` in Redis with a 24-hour TTL (`EX 86400`).
   - The response is sent back with headers `HTTP 201 Created` and `X-Cache: MISS`.

2. **Network Retry Replay Lifecycle (`X-Cache: HIT`):**
   - When the client retries the request with the identical `Idempotency-Key`, the middleware queries Redis.
   - Redis finds the cached completed response.
   - The server **completely bypasses** the business logic and database.
   - It instantly replays the cached `HTTP 201 Created` response with `X-Cache: HIT` and `Idempotency-Replay: true`.
   - Exactly **one** order remains in the database.

3. **Concurrency Race Condition Guard (`HTTP 409 Conflict`):**
   - If two identical requests hit the server concurrently at the exact same millisecond, both attempt the atomic `SETNX` lock.
   - Redis processes commands in a deterministic single thread. Request 1 wins the lock.
   - Request 2 sees that the key is already `IN_PROGRESS` and is immediately rejected with `409 Conflict`.
   - This mutual exclusion prevents duplicate concurrent mutations across multi-instance backends.

---

## Core Concepts at a Glance

| Concept | Why It Matters | Real-World Intuition |
| :--- | :--- | :--- |
| **Idempotency** | Prevents unintended side effects when identical mutations are sent repeatedly (`f(f(x)) = f(x)`). | Tapping "Submit Order" five times during a network freeze results in exactly one order and one charge. |
| **Atomic Lock (`SETNX`)** | Redis primitive `SET key value EX ttl NX` sets a key only if it does not already exist. | Provides instant, lock-safe mutual exclusion without needing slow database table locks. |
| **`IN_PROGRESS` State** | Marks a transaction as currently processing. | Informs concurrent parallel requests that work is already underway, preventing race condition duplicates. |
| **Response Caching** | Storing the HTTP status and JSON response body in Redis under the idempotency key. | Allows the server to replay identical responses instantly without touching disk or databases. |
| **TTL Expiration (`EX 86400`)** | Automatically expires idempotency records after 24 hours. | Prevents Redis memory bloat while comfortably exceeding client retry windows. |
| **At-Least-Once Delivery** | Network reality where distributed systems retry until they receive an acknowledgment. | Requires receiving backend endpoints to be strictly idempotent to avoid duplicate records. |

---

## What You Will Build

```text
lab02-idempotent-write-endpoint/
├── docker-compose.yml    # Redis 7 service definition
├── package.json          # Node dependencies (express, ioredis)
├── server.js             # Express server with Redis Idempotency Middleware
├── test-idempotency.js   # Automated retry and concurrency race condition test
└── images/
    └── lab02-architecture.svg  # Master architecture & caching lifecycle diagram
```

---

## Step 1: Initialize the Project Workspace

In this step, you will create the project folder and install the dependencies: **Express** for web routing and **ioredis** for high-performance communication with Redis.

### 1. Create and enter the project directory:

```bash
mkdir -p ~/lab02-idempotent-write-endpoint
cd ~/lab02-idempotent-write-endpoint
```

![Create Lab Directory](images/step1-create-dir.png)

### 2. Create `package.json`:

Define start and test scripts for your application:

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

### 3. Install dependencies:

Run `npm install` to download Express and the Redis client:

```bash
npm install
```

![Install Dependencies](images/step1-npm-install.png)

---

## Step 2: Start Redis Key Store with Docker Compose

Now, start a lightweight **Redis 7** container using Docker Compose. Redis will act as our fast in-memory key-value store for distributed locking and response caching.

### 1. Create `docker-compose.yml`:

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

### 2. Launch the Redis container in the background:

```bash
docker compose up -d redis
```

![Launch Redis Container](images/step2-docker-compose-up.png)

### 3. Verify Redis connectivity:

Send a `PING` command to verify that Redis is healthy and ready to accept connections:

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

Now, implement `server.js`. This file contains our custom **Idempotency Middleware** factory that wraps write endpoints.

Let's look at how the middleware works:
- **Key Extraction:** Inspects incoming `POST`, `PUT`, or `PATCH` requests for the `Idempotency-Key` header.
- **Cache Check:** If the key already has a cached payload, it intercepts the request, adds `X-Cache: HIT`, and replays the response immediately.
- **Lock Acquisition:** If not cached, it runs `SET idemp:<key> "IN_PROGRESS" EX 60 NX`. If the key is already locked by another worker, it returns `409 Conflict`.
- **Response Monkey-Patching:** Wraps `res.json` so that when the controller finishes execution, the result is automatically saved in Redis with a 24-hour TTL (`EX 86400`).

Create `server.js`:

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

Now launch your Express service on port `5000` and expose it through the Poridhi Load Balancer.

### 1. Start the Server on Port 5000

Launch the server in the background:

```bash
node server.js &
```

![Start Server](images/step4-start-server.png)

> [!TIP]
> If your terminal prompt does not reappear immediately, press `Enter` on your keyboard.

### 2. Expose Service via Poridhi Load Balancer

1. Retrieve the private IP of your Poridhi virtual machine:

```bash
hostname -I | awk '{print $1}'
```

![Get Private IP](images/step4-hostname-ip.png)

2. Open the **Load Balancer** modal in the top Poridhi menu bar.
3. Configure the mapping:
   - **Enter IP**: Paste the IP retrieved above (e.g., `10.x.x.x`).
   - **Enter Port**: `5000`
4. Click **Expose** to obtain your public Load Balancer URL:

![Load Balancer Exposed](images/step4-loadbalancer-exposed.png)

5. Open the URL in your web browser to verify that the service is live:

![Browser Status](images/step4-browser-status.png)

---

### 3. Verify Idempotency via cURL

You can test either against `http://localhost:5000` in your terminal or use your public Poridhi Load Balancer URL.

#### Test 1: Send Primary POST Request (Cache Miss)

Submit a new order with `Idempotency-Key: ord_tx_1001`:

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

Notice `X-Cache: MISS`. The order was processed and assigned Order ID `1`.

#### Test 2: Send Identical Retry (Cache Hit)

Now simulate a network timeout or accidental double-click by sending the **exact same request** with the identical `Idempotency-Key`:

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

> [!NOTE]
> Look at the headers: `X-Cache: HIT` and `Idempotency-Replay: true`! The order ID returned is still `1`, and the timestamp is identical. The server replayed the cached response directly from Redis without creating another database entry.

#### Test 3: Verify Persistent Database State

Query all orders to verify that only a single order was created:

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

Despite sending two write requests, `total_orders` is strictly **1**. Idempotency successfully prevented a duplicate order!

---

## Step 5: Run Automated Idempotency Test Suite

Now create `test-idempotency.js` to run automated assertions covering missing headers, primary mutations, retry replays, database integrity, and **concurrent parallel race conditions**.

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

### Run the automated test suite:

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

## Key Engineering Takeaways

1. **Atomic Locks Protect Against Race Conditions:** Relying on Redis `SET key value EX 60 NX` gives you atomic mutual exclusion across distributed worker nodes without relying on complex database table locking.
2. **Replay Exact Semantics:** Storing both the HTTP status code and response payload ensures client SDKs experience identical behavior on retries, regardless of whether the response came from the database or cache.
3. **Controlled In-Flight States:** Using an explicit intermediate state (`IN_PROGRESS`) and responding with `409 Conflict` prevents split-brain mutations when clients spam retry buttons.
4. **Memory Hygiene with TTL:** Setting a sensible TTL (such as 24 hours) ensures your Redis instance doesn't run out of memory, while giving client mobile devices ample time to complete automatic exponential backoff retries.
