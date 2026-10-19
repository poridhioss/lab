# Lab 01: Contract-First API Design with OpenAPI 3

Welcome to **Lab 01**! In this hands-on lab, you will step into the shoes of a backend platform engineer building a production-ready REST service. Instead of jumping straight into writing JavaScript code, you will use the **Contract-First API Design** methodology. 

In modern software engineering (practiced by companies like Stripe, GitHub, and Twilio), teams never write backend endpoints in isolation. They first write an unambiguous contract using **OpenAPI 3.0** (formerly Swagger). This contract becomes the **single source of truth** that frontend engineers, mobile developers, backend services, and automated test runners align on from day one.

By the end of this lab, you will have designed an OpenAPI 3.0.3 specification and implemented a compliant **Node.js (Express)** microservice that enforces write idempotency, cursor-based pagination, and RFC 7807 error formats.

---

## Architecture & Unified Execution Topology

Below is the complete architectural layout and request execution topology for the service you will build. Everything—from the client request and network routing to contract verification, data persistence, and error handling—flows through this unified pipeline:

<p align="center">
  <img src="images/lab01-architecture.svg" alt="Lab 01 Architecture & Execution Topology" width="950">
</p>

### Understanding the Three Core Lifecycles

As illustrated in the diagram above, your API enforces three distinct production patterns:

1. **Write Mutation Lifecycle (`POST /api/v1/orders`):**
   - The client submits a new order and **must** provide a client-generated UUID via the `Idempotency-Key` header.
   - The server validates the request headers and body payload types against the OpenAPI schema.
   - If valid, the order is stored in the database, and the server returns `HTTP 201 Created` with a `Location: /api/v1/orders/{id}` resource pointer.
   - If the network drops and the client retries with the identical idempotency key, duplicate orders or billing charges are prevented.

2. **High-Performance Cursor Pagination (`GET /api/v1/orders`):**
   - The client requests a slice of records using `?limit=3&cursor=103`.
   - The server validates that the requested limit does not exceed the contract boundary (`1 <= limit <= 50`).
   - The server queries records strictly greater than the cursor (`WHERE id > cursor LIMIT limit`), eliminating the duplicate or skipped records common to offset pagination.
   - The response includes `next_cursor` and `has_more` metadata for smooth infinite scrolling.

3. **Standardized RFC 7807 Problem Details (`HTTP 400 Bad Request`):**
   - If a client omits the `Idempotency-Key` or requests `limit=100`, the server does not return an arbitrary error string.
   - Instead, it responds with `application/problem+json` containing standard diagnostic fields: `type`, `title`, `status`, `detail`, and `instance`.

---

## Core Concepts at a Glance

| Concept | Why It Matters | Real-World Intuition |
| :--- | :--- | :--- |
| **Contract-First Design** | Eliminates integration mismatches between frontend and backend teams. | Frontend developers can generate mock servers immediately while backend engineers build the actual implementation to spec. |
| **OpenAPI 3.0.3** | Machine-readable JSON/YAML standard for documenting and validating REST APIs. | Allows auto-generating client SDKs, Swagger interactive documentation, and automated regression test suites. |
| **Idempotency Key** | Guarantees that performing the same operation multiple times yields the exact same outcome. | Protects users from double billing if they click "Pay Now" on a spotty cellular connection that auto-retries. |
| **Cursor Pagination** | Paginates through chronological datasets using a unique record pointer (`id > cursor`). | Fast $O(1)$ indexed database queries; immune to duplicate or missed items when new records are inserted concurrently. |
| **RFC 7807 Problem Details** | IETF standard (`application/problem+json`) for HTTP error payloads. | Frontend clients parse a single, consistent JSON structure (`title`, `status`, `detail`) across all microservices. |
| **URI Versioning** | Explicit version numbers in the URL path (`/api/v1/orders`). | Guarantees backwards compatibility when introducing new features without breaking existing mobile or third-party consumers. |

---

## What You Will Build

```text
lab01-contract-first-api/
├── openapi.yaml       # OpenAPI 3.0.3 contract (Single source of truth)
├── package.json       # Node.js project manifest & dependencies (Express, YAML)
├── server.js          # Express backend server implementing the contract
├── test.js            # Automated contract verification test suite
└── images/
    └── lab01-architecture.svg  # Unified topology & lifecycle diagram
```

---

## Step 1: Initialize the Project Workspace

In this step, you will set up your project folder and install the necessary Node.js libraries: **Express** for routing and **YAML** for parsing the OpenAPI contract directly into memory.

### 1. Create and enter the project directory:

```bash
mkdir -p ~/lab01-contract-first-api
cd ~/lab01-contract-first-api
```

![Create Project Directory](images/step1-create-dir.png)

### 2. Create `package.json`:

Write the project configuration file defining start and test scripts:

```bash
cat << 'EOF' > package.json
{
  "name": "lab01-contract-first-api",
  "version": "1.0.0",
  "description": "Lab 01: Contract-First API with OpenAPI 3",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node test.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "yaml": "^2.4.2"
  }
}
EOF
```

![Create package.json](images/step1-package-json.png)

### 3. Install dependencies:

Run `npm install` to download Express and the YAML parser:

```bash
npm install
```

![Install Dependencies](images/step1-npm-install.png)

Expected output:
```text
added 69 packages in 2s
found 0 vulnerabilities
```

---

## Step 2: Define the OpenAPI 3 Contract (`openapi.yaml`)

Now you will author the heart of this lab: the OpenAPI 3.0.3 specification. 

Notice how this file defines:
- The base server URI with versioning: `http://localhost:5000/api/v1`.
- The mandatory `Idempotency-Key` header on `POST /orders`.
- Boundary rules on query parameters (`minimum: 1, maximum: 50, default: 10` on `limit`).
- The standardized `ProblemDetails` schema conforming to **RFC 7807**.

Create `openapi.yaml`:

```bash
cat << 'EOF' > openapi.yaml
openapi: 3.0.3
info:
  title: Orders Service API
  version: 1.0.0
  description: Contract-first API specification supporting cursor pagination, idempotency keys, and RFC 7807 error formats.
servers:
  - url: http://localhost:5000/api/v1
    description: Local Development Server

paths:
  /orders:
    post:
      summary: Create an order (Idempotent write)
      description: Submits a new order mutation. The client MUST include an Idempotency-Key header to prevent duplicate orders upon retries.
      operationId: createOrder
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          description: Unique client-generated token (UUID v4) guaranteeing idempotent execution.
          schema:
            type: string
            format: uuid
            example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateOrderRequest'
      responses:
        '201':
          description: Order successfully placed and committed.
          headers:
            Location:
              schema:
                type: string
                example: "/api/v1/orders/101"
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderResponse'
        '400':
          $ref: '#/components/responses/ProblemDetails400'

    get:
      summary: List orders with cursor-based pagination
      description: Retrieves a chronological stream of orders using high-performance cursor pagination.
      operationId: listOrders
      parameters:
        - name: cursor
          in: query
          required: false
          description: Opaque cursor identifier representing the last seen order ID.
          schema:
            type: integer
            example: 100
        - name: limit
          in: query
          required: false
          description: Number of records to return per page.
          schema:
            type: integer
            minimum: 1
            maximum: 50
            default: 10
            example: 10
      responses:
        '200':
          description: Paginated collection of orders.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedOrdersResponse'
        '400':
          $ref: '#/components/responses/ProblemDetails400'

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
          example: 101
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
          enum: [PENDING, CONFIRMED, COMPLETED]
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
      description: RFC 7807 standard error structure.
      required:
        - type
        - title
        - status
        - detail
      properties:
        type:
          type: string
          format: uri
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
EOF
```

![Create openapi.yaml](images/step2-openapi-yaml.png)

---

## Step 3: Implement the Compliant Server (`server.js`)

With the contract established, we now write the Node.js server. The server faithfully mirrors every requirement specified in `openapi.yaml`:

- **RFC 7807 Helper:** A reusable `sendProblem()` function setting `Content-Type: application/problem+json`.
- **Pre-Seeded Entity Store:** Seeds 25 order records with auto-increment IDs (`101` through `125`) to test cursor pagination immediately.
- **Contract Schema Validation:** Explicit checks for `Idempotency-Key`, payload data types, and boundary limits (`1 <= limit <= 50`).
- **Raw Spec Endpoint:** Serves `/openapi.yaml` directly so external API clients and Swagger documentation viewers can consume the contract.

Create `server.js`:

```bash
cat << 'EOF' > server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Load and parse OpenAPI 3 contract
const openapiPath = path.join(__dirname, 'openapi.yaml');
const openapiSpec = yaml.parse(fs.readFileSync(openapiPath, 'utf8'));

// Helper: RFC 7807 Problem Details Formatter
function sendProblem(res, status, title, detail, instance, type = "about:blank") {
  res.setHeader('Content-Type', 'application/problem+json');
  return res.status(status).json({
    type,
    title,
    status,
    detail,
    instance
  });
}

// In-Memory Orders Database (Seeded with 25 records for pagination testing)
let ordersDb = [];
let nextOrderId = 101;

for (let i = 1; i <= 25; i++) {
  ordersDb.push({
    id: nextOrderId++,
    item_id: 400 + (i % 5),
    quantity: (i % 3) + 1,
    amount: parseFloat((25.5 * i).toFixed(2)),
    status: 'CONFIRMED',
    created_at: new Date(Date.now() - (25 - i) * 60000).toISOString()
  });
}

// Route: Expose raw OpenAPI Spec
app.get('/openapi.yaml', (req, res) => {
  res.setHeader('Content-Type', 'text/yaml');
  res.sendFile(openapiPath);
});

// Route: POST /api/v1/orders (Contract-First Mutation Endpoint)
app.post('/api/v1/orders', (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');

  // Contract Check: Header requirement
  if (!idempotencyKey) {
    return sendProblem(
      res,
      400,
      'Missing Required Header',
      'The Idempotency-Key header is required for this write operation.',
      '/api/v1/orders',
      'https://api.example.com/errors/missing-header'
    );
  }

  // Contract Check: Request Body fields & types
  const { item_id, quantity, amount } = req.body || {};
  if (typeof item_id !== 'number' || typeof quantity !== 'number' || typeof amount !== 'number') {
    return sendProblem(
      res,
      400,
      'Invalid Request Body',
      'item_id, quantity, and amount must all be numbers.',
      '/api/v1/orders',
      'https://api.example.com/errors/invalid-body'
    );
  }

  if (quantity < 1 || amount <= 0) {
    return sendProblem(
      res,
      400,
      'Value Out of Bounds',
      'quantity must be >= 1 and amount must be > 0.',
      '/api/v1/orders',
      'https://api.example.com/errors/out-of-bounds'
    );
  }

  // Create Order Entity
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

// Route: GET /api/v1/orders (Cursor-Based Pagination Endpoint)
app.get('/api/v1/orders', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit)) {
    limit = 10; // Default per OpenAPI contract
  }

  // Contract Check: Limit bounds [1..50]
  if (limit < 1 || limit > 50) {
    return sendProblem(
      res,
      400,
      'Invalid Query Parameter',
      `The limit parameter must be between 1 and 50. Received: ${req.query.limit}`,
      '/api/v1/orders',
      'https://api.example.com/errors/invalid-parameter'
    );
  }

  const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : 0;

  // Filter records chronologically after cursor ID
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Lab 01] Contract-First Server running on port ${PORT}`);
    console.log(`OpenAPI Spec accessible at http://localhost:${PORT}/openapi.yaml`);
  });
}

module.exports = app;
EOF
```

![Create server.js](images/step3-server-js.png)

---

## Step 4: Expose and Verify via Poridhi Load Balancer

Now, launch your server and expose it through Poridhi's cloud infrastructure. We run the service on port `5000` to avoid conflict with default web interface ports.

### 1. Start the Server on Port 5000

Start the Express application in the background:

```bash
node server.js &
```

![Start Server](images/step4-start-server.png)

> [!TIP]
> If your terminal prompt does not reappear after starting the background process, simply press the `Enter` key on your keyboard.

### 2. Configure Poridhi Load Balancer

1. Retrieve the private IP address of your Poridhi virtual machine:

```bash
hostname -I | awk '{print $1}'
```

![Get Private IP](images/step4-hostname-ip.png)

2. Open the **Load Balancer** dialog in the Poridhi interface (the cloud/router icon in the top navigation bar).
3. Fill in the connection settings:
   - **Enter IP**: Paste the IP address obtained above (e.g., `10.x.x.x`).
   - **Enter Port**: `5000`

![Configure Load Balancer](images/step4-loadbalancer-modal.png)

4. Click **Expose**. Poridhi will generate an active public Load Balancer URL:

![Load Balancer Exposed](images/step4-loadbalancer-exposed.png)

5. Open the generated Load Balancer URL in your browser to verify that the server is active:

![Browser Status](images/step4-browser-status.png)

---

### 3. Verify Contract Enforcement via cURL

Now, test each contract requirement using `curl`. You can run these commands directly against `http://localhost:5000` in your terminal, or substitute your **Poridhi Load Balancer URL** to test over the web!

#### Test 1: Missing Idempotency Key (Expect RFC 7807 400 Bad Request)

Send an order creation request **without** the required `Idempotency-Key` header:

```bash
curl -i -X POST http://localhost:5000/api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"item_id": 402, "quantity": 1, "amount": 99.50}'
```

![Test 1 Missing Idempotency Key](images/step4-test1-missing-key.png)

Expected output:
```text
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{
  "type": "https://api.example.com/errors/missing-header",
  "title": "Missing Required Header",
  "status": 400,
  "detail": "The Idempotency-Key header is required for this write operation.",
  "instance": "/api/v1/orders"
}
```

> [!NOTE]
> Notice the response `Content-Type: application/problem+json`. This confirms RFC 7807 compliance!

#### Test 2: Valid Order Placement (Expect 201 Created)

Now include a valid UUID in the `Idempotency-Key` header:

```bash
curl -i -X POST http://localhost:5000/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" \
  -d '{"item_id": 402, "quantity": 2, "amount": 199.00}'
```

![Test 2 Valid Order](images/step4-test2-valid-order.png)

Expected output:
```text
HTTP/1.1 201 Created
Location: /api/v1/orders/126
Content-Type: application/json; charset=utf-8

{
  "id": 126,
  "item_id": 402,
  "quantity": 2,
  "amount": 199,
  "status": "CONFIRMED",
  "created_at": "2026-10-02T02:00:00.000Z"
}
```

#### Test 3: Query Limit Violation (Expect RFC 7807 400 Bad Request)

The OpenAPI contract sets `maximum: 50` on the `limit` query parameter. Request `limit=100` to verify boundary enforcement:

```bash
curl -i "http://localhost:5000/api/v1/orders?limit=100"
```

![Test 3 Query Limit Violation](images/step4-test3-query-limit.png)

Expected output:
```text
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{
  "type": "https://api.example.com/errors/invalid-parameter",
  "title": "Invalid Query Parameter",
  "status": 400,
  "detail": "The limit parameter must be between 1 and 50. Received: 100",
  "instance": "/api/v1/orders"
}
```

#### Test 4: Cursor Pagination (Page 1 & Page 2)

Request the first page with `limit=3`:

```bash
curl -s "http://localhost:5000/api/v1/orders?limit=3" | jq .
```

![Test 4 Pagination Page 1](images/step4-test4-pagination-p1.png)

Expected output:
```json
{
  "data": [
    { "id": 101, "item_id": 401, "quantity": 2, "amount": 25.5, "status": "CONFIRMED" },
    { "id": 102, "item_id": 402, "quantity": 3, "amount": 51, "status": "CONFIRMED" },
    { "id": 103, "item_id": 403, "quantity": 1, "amount": 76.5, "status": "CONFIRMED" }
  ],
  "pagination": {
    "next_cursor": 103,
    "has_more": true,
    "count": 3
  }
}
```

Notice `next_cursor: 103`. Fetch Page 2 by passing `cursor=103`:

```bash
curl -s "http://localhost:5000/api/v1/orders?limit=3&cursor=103" | jq .
```

![Test 4 Pagination Page 2](images/step4-test4-pagination-p2.png)

Expected output:
```json
{
  "data": [
    { "id": 104, "item_id": 404, "quantity": 2, "amount": 102, "status": "CONFIRMED" },
    { "id": 105, "item_id": 400, "quantity": 3, "amount": 127.5, "status": "CONFIRMED" },
    { "id": 106, "item_id": 401, "quantity": 1, "amount": 153, "status": "CONFIRMED" }
  ],
  "pagination": {
    "next_cursor": 106,
    "has_more": true,
    "count": 3
  }
}
```

> [!TIP]
> Notice how Page 2 seamlessly begins at record `104` with zero duplicates and zero skipped items!

---

## Step 5: Run Automated Contract Test Suite

In real-world continuous integration (CI/CD) pipelines, contract compliance is never checked manually with `curl`. Instead, automated test suites execute against the server stub to guarantee that no pull request breaks the API contract.

Create `test.js` to run automated assertions against all 4 contract scenarios:

```bash
cat << 'EOF' > test.js
const http = require('http');
const app = require('./server');

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[TEST RUNNER] Running contract verification against port ${port}...\n`);

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
    // Test 1: Missing Idempotency-Key on POST -> Expect 400 Problem Details
    console.log('Test 1: Asserting 400 Bad Request when Idempotency-Key header is omitted...');
    const res1 = await request('POST', '/api/v1/orders', {}, { item_id: 1, quantity: 2, amount: 50.0 });
    if (res1.status === 400 && res1.body.title === 'Missing Required Header') {
      console.log(' PASS: 400 RFC 7807 returned properly for missing header.\n');
    } else {
      throw new Error(`Test 1 Failed: Received status ${res1.status}`);
    }

    // Test 2: Valid Order Creation with Idempotency-Key -> Expect 201 Created
    console.log('Test 2: Creating an order with valid schema and Idempotency-Key...');
    const res2 = await request('POST', '/api/v1/orders', { 'Idempotency-Key': '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' }, {
      item_id: 402,
      quantity: 3,
      amount: 199.99
    });
    if (res2.status === 201 && res2.body.id && res2.headers.location) {
      console.log(` PASS: 201 Created returned. Order ID: ${res2.body.id}, Location: ${res2.headers.location}\n`);
    } else {
      throw new Error(`Test 2 Failed: Received status ${res2.status}`);
    }

    // Test 3: Pagination Limit Out of Bounds (limit > 50) -> Expect 400 Problem Details
    console.log('Test 3: Requesting pagination limit=100 (exceeding max 50 contract rule)...');
    const res3 = await request('GET', '/api/v1/orders?limit=100');
    if (res3.status === 400 && res3.body.title === 'Invalid Query Parameter') {
      console.log(' PASS: 400 RFC 7807 returned for limit out of bounds.\n');
    } else {
      throw new Error(`Test 3 Failed: Received status ${res3.status}`);
    }

    // Test 4: Cursor-based Pagination Retrieval -> Expect 200 OK with next_cursor
    console.log('Test 4: Querying first page of orders (limit=5)...');
    const res4 = await request('GET', '/api/v1/orders?limit=5');
    if (res4.status === 200 && res4.body.data.length === 5 && res4.body.pagination.next_cursor) {
      const nextCursor = res4.body.pagination.next_cursor;
      console.log(` PASS: Page 1 returned 5 items. Next cursor token: ${nextCursor}`);

      console.log(`Querying Page 2 using cursor=${nextCursor}...`);
      const res5 = await request('GET', `/api/v1/orders?limit=5&cursor=${nextCursor}`);
      if (res5.status === 200 && res5.body.data.length === 5 && res5.body.data[0].id > nextCursor) {
        console.log(` PASS: Page 2 returned next 5 items without overlap. First item ID: ${res5.body.data[0].id}\n`);
      } else {
        throw new Error('Test 4 Page 2 Failed');
      }
    } else {
      throw new Error(`Test 4 Failed: Received status ${res4.status}`);
    }

    console.log(' ALL 4 CONTRACT-FIRST API TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Test suite failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
EOF
```

![Create Test Script](images/step5-test-js.png)

### Run the automated test suite:

```bash
npm test
```

![Automated Test Suite Output](images/step5-npm-test.png)

Expected output:
```text
> lab01-contract-first-api@1.0.0 test
> node test.js

[TEST RUNNER] Running contract verification against port 39707...

Test 1: Asserting 400 Bad Request when Idempotency-Key header is omitted...
 PASS: 400 RFC 7807 returned properly for missing header.

Test 2: Creating an order with valid schema and Idempotency-Key...
 PASS: 201 Created returned. Order ID: 126, Location: /api/v1/orders/126

Test 3: Requesting pagination limit=100 (exceeding max 50 contract rule)...
 PASS: 400 RFC 7807 returned for limit out of bounds.

Test 4: Querying first page of orders (limit=5)...
 PASS: Page 1 returned 5 items. Next cursor token: 105
Querying Page 2 using cursor=105...
 PASS: Page 2 returned next 5 items without overlap. First item ID: 106

 ALL 4 CONTRACT-FIRST API TESTS PASSED SUCCESSFULLY!
```

---

## Key Engineering Takeaways

1. **The Contract is the Source of Truth:** Designing the OpenAPI specification upfront eliminates costly misunderstandings and ensures backend implementation adheres strictly to agreed schemas.
2. **Idempotency Guarantees Safe Network Retries:** Mobile devices, payment gateways, and microservices encounter transient network drops. Enforcing `Idempotency-Key` ensures that automatic retries never result in duplicate orders or double-billing.
3. **Cursor Pagination Scales Effortlessly:** Unlike offset-based pagination (`OFFSET 10000`), cursor pagination leverages indexed sequential keys (`WHERE id > cursor LIMIT limit`). It delivers deterministic performance and prevents phantom records under real-time writes.
4. **RFC 7807 Standardizes Distributed Errors:** Using `application/problem+json` replaces proprietary error formats with a universally recognized IETF standard, simplifying client error-handling logic across web and mobile platforms.
