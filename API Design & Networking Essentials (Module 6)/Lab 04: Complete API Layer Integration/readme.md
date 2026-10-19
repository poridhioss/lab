# Complete API Layer Integration

You will build a unified API platform integrating OpenAPI 3 contract validation, Redis-backed write idempotency, and an Nginx API gateway using Docker Compose. The architecture coordinates edge authentication and rate limiting at the gateway, header propagation of `Idempotency-Key`, schema validation in Express, and atomic distributed locking in Redis. You will deploy the multi-container stack and execute an automated end-to-end integration test suite.

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/lab04-architecture.svg" alt="Complete API Layer Integration Architecture Overview" width="750">
</p>

---

## Concepts

| Term | Definition |
| :--- | :--- |
| **Unified API Layer** | An integrated architecture that separates edge ingress security, contract schema enforcement, and distributed state locking across tiers. |
| **Header Propagation** | The explicit reverse-proxy forwarding of custom client headers (`Idempotency-Key`, `X-Forwarded-For`) to internal backend services. |
| **Separation of Concerns** | Isolating edge authentication and coarse rate limiting at the gateway while maintaining domain business logic and data locking at the service layer. |
| **End-to-End Idempotency** | Guaranteeing that client retries through public gateways and internal services produce strictly one state mutation in the persistent database. |
| **Layered Defense** | Rejecting malformed or unauthorized requests at the earliest possible boundary (`401` at Gateway, `400` at Contract, `409` at Redis lock). |

Client traffic enters Nginx on port 8080. Nginx authenticates the client using an in-memory API key map and checks rate quotas before reverse-proxying the request to the Express API service with the `Idempotency-Key` header preserved. The API service validates request bodies and query parameters against the OpenAPI 3 specification. Write mutations acquire an atomic mutex in Redis (`SETNX`) to ensure that concurrent requests sharing an idempotency key are rejected with `409 Conflict`. Valid orders are committed to the data store, and completed responses are cached in Redis for 24 hours. Subsequent retries replay the cached response with `X-Cache: HIT-IDEMPOTENT` without touching the database.

---

## Objectives

- Configure an integrated multi-container Docker Compose architecture connecting Nginx, Express, and Redis.
- Implement reverse-proxy header propagation for custom client headers (`Idempotency-Key`, `X-API-Key`).
- Enforce edge authentication at the gateway and contract schema validation at the application service layer.
- Execute an automated end-to-end integration test suite verifying layered defense and idempotency replays.
- Verify system health, authentication boundaries, contract enforcement, and replay caching.

---

## What You Will Build

```text
lab04-api-layer-integration/
├── docker-compose.yml       # Multi-container stack (Gateway + API + Redis)
├── nginx.conf               # Nginx Gateway config with header propagation & edge auth
├── test-integration.js      # Automated end-to-end integration test suite
└── api-service/
    ├── package.json         # Node dependencies (express, ioredis, yaml)
    ├── openapi.yaml         # Single source of truth OpenAPI 3 specification
    ├── server.js            # Express API service implementing the contract
    └── middleware/
        └── idempotency.js   # Redis-backed idempotency middleware
```

The Nginx gateway terminates edge security and passes verified traffic and headers to the Express API service, which enforces the OpenAPI contract and coordinates distributed idempotency locks with Redis.

---

## Step 1: Project Setup and Dependencies

Create the project directories:

```bash
mkdir -p ~/lab04-api-layer-integration/api-service/middleware
cd ~/lab04-api-layer-integration
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step1-create-dirs.png" alt="Create project directories" width="700">
</p>

Create a file named `api-service/package.json` with the following contents:

```json
{
  "name": "lab04-api-service",
  "version": "1.0.0",
  "description": "Unified API Service with OpenAPI Validation & Idempotency",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ioredis": "^5.4.1",
    "yaml": "^2.4.2"
  }
}
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step1-package-json.png" alt="Create package.json" width="700">
</p>

**Explanation:**
- `main`: Designates `server.js` as the application entrypoint.
- `scripts.start`: Defines the start script to execute the service with Node.js.
- `dependencies.express`: Installs Express to handle routing and middleware.
- `dependencies.ioredis`: Installs the Redis client library for atomic locks and response caching.
- `dependencies.yaml`: Installs the YAML parser to read the OpenAPI contract.

---

## Step 2: Define OpenAPI 3 Contract

Create a file named `api-service/openapi.yaml` with the following contents:

```yaml
openapi: 3.0.3
info:
  title: Orders Service API (Production Integration)
  version: 1.0.0
  description: Integrated contract-first orders service enforcing idempotency and RFC 7807 errors.
servers:
  - url: http://localhost:8080/api/v1
    description: Public Gateway Entrypoint

paths:
  /orders:
    post:
      summary: Create an order (Idempotent write)
      description: Submits a new order mutation. The client MUST include an Idempotency-Key header.
      operationId: createOrder
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema:
            type: string
            example: "tx_live_8912"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateOrderRequest'
      responses:
        '201':
          description: Order successfully created.
          headers:
            Location:
              schema:
                type: string
                example: "/api/v1/orders/1"
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderResponse'
        '400':
          $ref: '#/components/responses/ProblemDetails400'

    get:
      summary: List orders with cursor pagination
      parameters:
        - name: cursor
          in: query
          required: false
          schema:
            type: integer
            example: 100
        - name: limit
          in: query
          required: false
          schema:
            type: integer
            minimum: 1
            maximum: 50
            default: 10
      responses:
        '200':
          description: Paginated collection of orders.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedOrdersResponse'

components:
  schemas:
    CreateOrderRequest:
      type: object
      required:
        - item_id
        - quantity
        - amount
      properties:
        item_id:
          type: integer
          example: 402
        quantity:
          type: integer
          minimum: 1
          example: 2
        amount:
          type: number
          format: float
          minimum: 0.01
          example: 150.50

    OrderResponse:
      type: object
      required:
        - id
        - item_id
        - quantity
        - amount
        - status
        - created_at
      properties:
        id:
          type: integer
          example: 1
        item_id:
          type: integer
          example: 402
        quantity:
          type: integer
          example: 2
        amount:
          type: number
          example: 150.50
        status:
          type: string
          example: CONFIRMED
        created_at:
          type: string
          format: date-time
          example: "2026-10-02T10:00:00Z"

    PaginationMetadata:
      type: object
      required:
        - next_cursor
        - has_more
        - count
      properties:
        next_cursor:
          type: integer
          nullable: true
          example: 110
        has_more:
          type: boolean
          example: true
        count:
          type: integer
          example: 10

    PaginatedOrdersResponse:
      type: object
      required:
        - data
        - pagination
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/OrderResponse'
        pagination:
          $ref: '#/components/schemas/PaginationMetadata'

    ProblemDetails:
      type: object
      required:
        - type
        - title
        - status
        - detail
      properties:
        type:
          type: string
          example: "https://api.example.com/errors/invalid-parameter"
        title:
          type: string
          example: "Invalid Request Parameter"
        status:
          type: integer
          example: 400
        detail:
          type: string
          example: "The limit parameter exceeds maximum allowed of 50."
        instance:
          type: string
          example: "/api/v1/orders"

  responses:
    ProblemDetails400:
      description: Bad Request (RFC 7807 Problem Details).
      content:
        application/problem+json:
          schema:
            $ref: '#/components/schemas/ProblemDetails'
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step2-openapi-yaml.png" alt="Create openapi.yaml" width="700">
</p>

**Explanation:**
- `servers.url`: Specifies `http://localhost:8080/api/v1` to point to the public Nginx gateway ingress rather than internal service ports.
- `paths./orders.post.parameters`: Enforces the presence of the `Idempotency-Key` header on write operations.
- `paths./orders.get.parameters`: Defines `cursor` and `limit` bounds (`1 <= limit <= 50`).
- `components.schemas.CreateOrderRequest`: Enforces typed fields (`item_id`, `quantity`, `amount`) and minimum values.
- `components.schemas.ProblemDetails`: Standardizes RFC 7807 error responses for bad requests.

---

## Step 3: Implement Idempotency Middleware

Create a file named `api-service/middleware/idempotency.js` with the following contents:

```javascript
function idempotencyMiddleware(redisClient, ttlSeconds = 86400) {
  return async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    const key = req.header('Idempotency-Key');
    if (!key) {
      return res.status(400).setHeader('Content-Type', 'application/problem+json').json({
        type: 'https://api.example.com/errors/missing-header',
        title: 'Missing Required Header',
        status: 400,
        detail: 'The Idempotency-Key header is required for this write operation.',
        instance: req.originalUrl
      });
    }

    const redisKey = `idemp:${key}`;

    try {
      // 1. Check existing cached state
      const cached = await redisClient.get(redisKey);
      if (cached) {
        if (cached === 'IN_PROGRESS') {
          return res.status(409).setHeader('Content-Type', 'application/problem+json').json({
            type: 'https://api.example.com/errors/concurrent-mutation',
            title: 'Conflict: Mutation In Progress',
            status: 409,
            detail: 'A mutation with this Idempotency-Key is currently processing. Retry shortly.',
            instance: req.originalUrl
          });
        }

        // Cache Hit: Replay response
        const record = JSON.parse(cached);
        res.setHeader('X-Cache', 'HIT-IDEMPOTENT');
        res.setHeader('Idempotency-Replay', 'true');
        if (record.headers && record.headers.location) {
          res.setHeader('Location', record.headers.location);
        }
        return res.status(record.status).json(record.body);
      }

      // 2. Acquire Atomic Lock (60s timeout)
      const acquired = await redisClient.set(redisKey, 'IN_PROGRESS', 'EX', 60, 'NX');
      if (!acquired) {
        return res.status(409).setHeader('Content-Type', 'application/problem+json').json({
          type: 'https://api.example.com/errors/concurrent-mutation',
          title: 'Conflict: Concurrent Request',
          status: 409,
          detail: 'Another request is currently executing with this Idempotency-Key.',
          instance: req.originalUrl
        });
      }

      // Cache Miss: Proceed and intercept response
      res.setHeader('X-Cache', 'MISS');

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const payloadToCache = {
          status: res.statusCode,
          headers: {
            location: res.getHeader('Location') || null
          },
          body: body
        };

        redisClient.set(redisKey, JSON.stringify(payloadToCache), 'EX', ttlSeconds).catch(err => {
          console.error('[IDEMPOTENCY] Cache store failed:', err.message);
        });

        return originalJson(body);
      };

      next();
    } catch (err) {
      console.error('[IDEMPOTENCY ERROR]', err);
      next();
    }
  };
}

module.exports = idempotencyMiddleware;
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step3-idempotency-middleware.png" alt="Create idempotency middleware" width="700">
</p>

**Explanation:**
- `req.header('Idempotency-Key')`: Validates the forwarded idempotency key from the gateway.
- `redisClient.get(redisKey)`: Checks if a completed response already exists for this transaction token.
- `redisClient.set(..., 'NX')`: Acquires an atomic mutual exclusion lock to defend against concurrent duplicate submissions.
- `res.setHeader('X-Cache', 'HIT-IDEMPOTENT')`: Adds cache diagnosis headers to indicate when responses are replayed from Redis.
- `res.json = (body) => { ... }`: Intercepts completed HTTP responses and caches them in Redis with a 24-hour TTL (`EX 86400`).

---

## Step 4: Implement Express Server

Create a file named `api-service/server.js` with the following contents:

```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const Redis = require('ioredis');
const idempotencyMiddleware = require('./middleware/idempotency');

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

app.use(express.json());

const redis = new Redis(REDIS_URL, {
  retryStrategy: times => Math.min(times * 100, 2000)
});

// Load OpenAPI 3 contract
const openapiPath = path.join(__dirname, 'openapi.yaml');
const openapiSpec = yaml.parse(fs.readFileSync(openapiPath, 'utf8'));

// Helper: RFC 7807 Problem Details
function sendProblem(res, status, title, detail, instance, type = "about:blank") {
  res.setHeader('Content-Type', 'application/problem+json');
  return res.status(status).json({ type, title, status, detail, instance });
}

// In-Memory Database
let ordersDb = [];
let nextOrderId = 1;

for (let i = 1; i <= 15; i++) {
  ordersDb.push({
    id: nextOrderId++,
    item_id: 400 + (i % 5),
    quantity: (i % 3) + 1,
    amount: parseFloat((25.5 * i).toFixed(2)),
    status: 'CONFIRMED',
    created_at: new Date(Date.now() - (15 - i) * 60000).toISOString()
  });
}

// Raw spec endpoint
app.get('/openapi.yaml', (req, res) => {
  res.setHeader('Content-Type', 'text/yaml');
  res.sendFile(openapiPath);
});

// Mutation Endpoint (Protected by Idempotency Middleware)
app.post('/api/v1/orders', idempotencyMiddleware(redis, 86400), (req, res) => {
  const { item_id, quantity, amount } = req.body || {};

  if (typeof item_id !== 'number' || typeof quantity !== 'number' || typeof amount !== 'number') {
    return sendProblem(res, 400, 'Invalid Request Body', 'item_id, quantity, and amount must be numbers.', '/api/v1/orders');
  }

  if (quantity < 1 || amount <= 0) {
    return sendProblem(res, 400, 'Value Out of Bounds', 'quantity must be >= 1 and amount > 0.', '/api/v1/orders');
  }

  const newOrder = {
    id: nextOrderId++,
    item_id,
    quantity,
    amount: parseFloat(amount.toFixed(2)),
    status: 'CONFIRMED',
    created_at: new Date().toISOString()
  };

  ordersDb.push(newOrder);

  res.setHeader('Location', `/api/v1/orders/${newOrder.id}`);
  return res.status(201).json(newOrder);
});

// Query Endpoint (Cursor Pagination)
app.get('/api/v1/orders', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit)) limit = 10;

  if (limit < 1 || limit > 50) {
    return sendProblem(res, 400, 'Invalid Query Parameter', `limit must be between 1 and 50. Received: ${req.query.limit}`, '/api/v1/orders');
  }

  const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : 0;
  const filtered = ordersDb.filter(o => o.id > cursor);
  const pageItems = filtered.slice(0, limit);
  const nextCursor = pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null;
  const hasMore = filtered.length > limit;

  return res.status(200).json({
    data: pageItems,
    pagination: {
      next_cursor: hasMore ? nextCursor : null,
      has_more: hasMore,
      count: pageItems.length
    }
  });
});

// Reset endpoint for automated test runner
app.post('/api/v1/reset', async (req, res) => {
  ordersDb = ordersDb.slice(0, 15);
  nextOrderId = 16;
  const keys = await redis.keys('idemp:*');
  if (keys.length > 0) await redis.del(...keys);
  res.json({ status: 'RESET_OK' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API Service] Running on port ${PORT}`);
});
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step4-server-js.png" alt="Create server.js" width="700">
</p>

**Explanation:**
- `PORT = process.env.PORT || 3000`: Binds the API service to internal port 3000 within the private container network.
- `sendProblem()`: Generates RFC 7807 compliant error payloads with `application/problem+json`.
- `idempotencyMiddleware(redis, 86400)`: Mounts the Redis-backed idempotency protection on the `POST /api/v1/orders` route.
- `ordersDb.filter(o => o.id > cursor)`: Executes cursor-based pagination logic returning next-cursor metadata.

---

## Step 5: Configure Nginx Gateway with Header Propagation

Create a file named `nginx.conf` with the following contents:

```nginx
events {
    worker_connections 1024;
}

http {
    # 1. Rate Limiting Zone: 5 req/s per client IP
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=5r/s;
    limit_req_status 429;

    # 2. Declarative API Key Authentication Map
    map $http_x_api_key $api_client_name {
        default             "";
        "valid-key-123"     "Frontend-App";
        "admin-key-999"     "Admin-Portal";
    }

    upstream api_backend {
        server api_service:3000;
    }

    server {
        listen 80;

        # Standard Proxy Headers & CRITICAL Idempotency Key Propagation
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Client-Name $api_client_name;
        proxy_set_header Idempotency-Key $http_idempotency_key;

        # Preserve downstream cache headers
        proxy_pass_header X-Cache;
        proxy_pass_header Idempotency-Replay;
        proxy_pass_header Location;

        location /healthz {
            access_log off;
            add_header Content-Type application/json;
            return 200 '{"status":"UP","gateway":"Nginx","layer":"Edge"}';
        }

        location /api/v1/orders {
            # Edge Authentication Check
            if ($api_client_name = "") {
                return 401 '{"type":"https://api.example.com/errors/unauthorized","title":"Unauthorized","status":401,"detail":"Missing or invalid X-API-Key"}';
            }

            # Rate Limiting Guard
            limit_req zone=api_limit burst=5 nodelay;

            proxy_pass http://api_backend;
        }

        location /openapi.yaml {
            proxy_pass http://api_backend/openapi.yaml;
        }
    }
}
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step5-nginx-conf.png" alt="Create nginx.conf" width="700">
</p>

**Explanation:**
- `proxy_set_header Idempotency-Key $http_idempotency_key`: Propagates the custom idempotency key header across the reverse-proxy boundary to the internal service.
- `proxy_pass_header X-Cache`: Preserves custom cache miss/hit response headers from the API service so clients receive transparency.
- `map $http_x_api_key $api_client_name`: Validates caller credentials at the edge, rejecting unauthorized traffic with `401 Unauthorized`.
- `limit_req zone=api_limit burst=5 nodelay`: Enforces token-bucket rate limiting before traffic reaches the upstream API container.

---

## Step 6: Assemble Unified Docker Compose Stack

Create a file named `docker-compose.yml` with the following contents:

```yaml
version: '3.8'

services:
  gateway:
    image: nginx:alpine
    container_name: lab04-gateway
    ports:
      - "8080:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - api_service
    networks:
      - api-network
    restart: unless-stopped

  api_service:
    image: node:18-alpine
    container_name: lab04-api
    working_dir: /app
    volumes:
      - ./api-service:/app
    environment:
      - PORT=3000
      - REDIS_URL=redis://redis:6379
    command: sh -c "npm install && node server.js"
    depends_on:
      - redis
    networks:
      - api-network
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: lab04-redis
    networks:
      - api-network
    restart: unless-stopped

networks:
  api-network:
    driver: bridge
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step6-docker-compose-yml.png" alt="Create docker-compose.yml" width="700">
</p>

**Explanation:**
- `gateway.ports: "8080:80"`: Exposes only the gateway port 8080 on the host.
- `api_service.environment`: Injects the internal Redis connection string (`redis://redis:6379`) using Docker DNS.
- `networks.api-network`: Connects all three containers on a private bridge network without exposing internal database or application ports.

---

## Step 7: Launch the Integrated Platform

Start the complete multi-container stack in the background:

```bash
docker compose up -d --build
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step7-docker-compose-up.png" alt="Launch Containers" width="700">
</p>

Verify running container status:

```bash
docker compose ps
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step7-docker-compose-ps.png" alt="Verify Running Containers" width="700">
</p>

---

## Verification

You will execute an automated integration test suite validating edge authentication, contract enforcement, primary idempotent mutations, replay caching, and cursor pagination through the gateway.

Create a file named `test-integration.js` with the following contents:

```javascript
const http = require('http');

const BASE_URL = 'http://localhost:8080';
const VALID_KEY = 'valid-key-123';

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
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

async function runTests() {
  console.log('=== RUNNING COMPLETE API LAYER INTEGRATION TESTS ===\n');

  try {
    // 1. Health check
    console.log('Test 1: Public Gateway Health Endpoint (/healthz)...');
    const h = await request('GET', '/healthz');
    if (h.status === 200 && h.body.status === 'UP') {
      console.log(' PASS: 200 OK received from Gateway.\n');
    } else throw new Error(`Health check failed: ${h.status}`);

    // 2. Gateway Auth Guard (Missing Key)
    console.log('Test 2: Edge Authentication Guard (Missing X-API-Key)...');
    const a1 = await request('POST', '/api/v1/orders', {}, { item_id: 1, quantity: 1, amount: 50 });
    if (a1.status === 401) {
      console.log(' PASS: 401 Unauthorized blocked at gateway boundary.\n');
    } else throw new Error(`Auth guard failed: ${a1.status}`);

    // 3. Contract Schema Guard (Missing Idempotency-Key)
    console.log('Test 3: Contract Guard (Valid API Key, Missing Idempotency-Key)...');
    const c1 = await request('POST', '/api/v1/orders', { 'X-API-Key': VALID_KEY }, { item_id: 1, quantity: 1, amount: 50 });
    if (c1.status === 400 && c1.body.title === 'Missing Required Header') {
      console.log(' PASS: 400 Bad Request returned per OpenAPI contract.\n');
    } else throw new Error(`Contract guard failed: ${c1.status}`);

    // 4. Primary Order Creation (Cache Miss)
    const txKey = 'tx_e2e_prod_001';
    console.log(`Test 4: Primary Idempotent Write (Idempotency-Key="${txKey}")...`);
    const w1 = await request('POST', '/api/v1/orders', {
      'X-API-Key': VALID_KEY,
      'Idempotency-Key': txKey
    }, { item_id: 402, quantity: 2, amount: 199.50 });

    if (w1.status === 201 && w1.headers['x-cache'] === 'MISS' && w1.body.id) {
      console.log(` PASS: 201 Created. Order ID: ${w1.body.id}, Cache: ${w1.headers['x-cache']}\n`);
    } else throw new Error(`Write failed: ${w1.status}`);

    // 5. Network Retry Replay (Cache Hit)
    console.log(`Test 5: Retrying identical write request through Gateway (Idempotency-Key="${txKey}")...`);
    const w2 = await request('POST', '/api/v1/orders', {
      'X-API-Key': VALID_KEY,
      'Idempotency-Key': txKey
    }, { item_id: 402, quantity: 2, amount: 199.50 });

    if (w2.status === 201 && w2.headers['x-cache'] === 'HIT-IDEMPOTENT' && w2.body.id === w1.body.id) {
      console.log(` PASS: 201 Replayed from Cache (X-Cache: ${w2.headers['x-cache']}). Returned same Order ID: ${w2.body.id}\n`);
    } else throw new Error(`Idempotency retry failed: status ${w2.status}, cache: ${w2.headers['x-cache']}`);

    // 6. Cursor Pagination
    console.log('Test 6: Querying paginated collection through Gateway (?limit=3)...');
    const p1 = await request('GET', '/api/v1/orders?limit=3', { 'X-API-Key': VALID_KEY });
    if (p1.status === 200 && p1.body.data.length === 3 && p1.body.pagination.next_cursor) {
      console.log(` PASS: 200 OK. Returned ${p1.body.data.length} orders. Next cursor: ${p1.body.pagination.next_cursor}\n`);
    } else throw new Error(`Pagination failed: ${p1.status}`);

    console.log(' ALL 6 END-TO-END INTEGRATION TESTS PASSED PERFECTLY!');
  } catch (err) {
    console.error('Integration test failed:', err);
    process.exitCode = 1;
  }
}

runTests();
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step7-test-integration-js.png" alt="Create test-integration.js" width="700">
</p>

**Explanation:**
- `Test 1`: Verifies that the public `/healthz` endpoint responds with `200 OK`.
- `Test 2`: Verifies that omitting `X-API-Key` is blocked at the gateway boundary with `401 Unauthorized`.
- `Test 3`: Confirms that requests passing the gateway but omitting `Idempotency-Key` are rejected by the API service with RFC 7807 `400 Bad Request`.
- `Test 4`: Asserts that an initial write produces `201 Created` with header `X-Cache: MISS`.
- `Test 5`: Confirms that an identical retry through the gateway replays `201 Created` with `X-Cache: HIT-IDEMPOTENT` and the same Order ID without creating duplicate database rows.
- `Test 6`: Validates that cursor pagination requests correctly return sliced records and pagination metadata.

Execute the integration test suite:

```bash
node test-integration.js
```

<p align="center">
  <img src="https://raw.githubusercontent.com/iftakhar-323/lab-assets/main/API%20Design%20%26%20Networking%20Essentials%20%28Module%206%29/Lab%2004:%20Complete%20API%20Layer%20Integration/images/step7-node-test-integration.png" alt="Run Integration Tests" width="700">
</p>

Expected output:

```text
=== RUNNING COMPLETE API LAYER INTEGRATION TESTS ===

Test 1: Public Gateway Health Endpoint (/healthz)...
 PASS: 200 OK received from Gateway.

Test 2: Edge Authentication Guard (Missing X-API-Key)...
 PASS: 401 Unauthorized blocked at gateway boundary.

Test 3: Contract Guard (Valid API Key, Missing Idempotency-Key)...
 PASS: 400 Bad Request returned per OpenAPI contract.

Test 4: Primary Idempotent Write (Idempotency-Key="tx_e2e_prod_001")...
 PASS: 201 Created. Order ID: 16, Cache: MISS

Test 5: Retrying identical write request through Gateway (Idempotency-Key="tx_e2e_prod_001")...
 PASS: 201 Replayed from Cache (X-Cache: HIT-IDEMPOTENT). Returned same Order ID: 16

Test 6: Querying paginated collection through Gateway (?limit=3)...
 PASS: 200 OK. Returned 3 orders. Next cursor: 3

 ALL 6 END-TO-END INTEGRATION TESTS PASSED PERFECTLY!
```

---

## Conclusion

You built a unified API platform integrating OpenAPI 3 contract validation, Redis-backed write idempotency, and an Nginx API gateway using Docker Compose. You configured header propagation for idempotency keys, enforced authentication at the edge boundary, and verified end-to-end retry replay behavior under automated integration tests.
