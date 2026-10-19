# Lab 03: API Gateway & Rate-Aware Routing with Nginx

Welcome to **Lab 03**! In this lab, you will design and implement a production-grade **API Gateway** pattern using **Nginx** and **Docker Compose** in your Poridhi cloud environment.

In modern cloud-native architectures, you almost never expose individual backend microservices directly to the public internet. If you had 20 internal services, exposing them directly would mean managing 20 public firewall ports, writing redundant authentication logic in 20 different codebases, and risking an outage whenever a single aggressive client spams one of the services.

Instead, companies like Netflix, Uber, and Shopify place an **API Gateway** at the edge of their network. The gateway acts as a high-performance reverse proxy that centralizes:
1. **Edge Authentication:** Verifying client API keys before requests ever touch downstream application servers.
2. **Rate Limiting & Traffic Shaping:** Protecting private services from traffic surges with token-bucket rate limits.
3. **Dynamic Path-Based Routing:** Dispatching `/api/v1/orders` and `/api/v1/users` to isolated internal microservices running on a private Docker bridge network.

---

## Architecture & Unified Ingress Topology

Below is the complete architectural layout and end-to-end routing lifecycle for your multi-service cluster. Everything—from public client traffic through the Poridhi Load Balancer to Nginx edge validation and isolated backend dispatch—is captured in this single diagram:

<p align="center">
  <img src="images/lab03-architecture.svg" alt="Lab 03 Architecture & Ingress Topology" width="950">
</p>

### Understanding the Three Execution Lifecycles

As illustrated in the diagram above, your Nginx Gateway handles three distinct operational lifecycles:

1. **Authorized Dynamic Routing (`HTTP 200 OK`):**
   - The client calls `GET /api/v1/orders` or `GET /api/v1/users` supplying a valid `X-API-Key: valid-key-123`.
   - Nginx validates the key using its memory-mapped lookup table and verifies that the request complies with the rate limit zone.
   - It reverse-proxies the request over the private Docker bridge (`lab-net`) to `http://orders_service:3001` or `http://users_service:3002`.
   - The internal service responds with `200 OK`, and Nginx relays the payload back to the client while forwarding real client IP headers.

2. **Edge Authentication Guard (`HTTP 401 Unauthorized`):**
   - If a request arrives with an invalid or missing `X-API-Key`, Nginx's declarative map evaluates `$api_client_name` to empty.
   - Nginx immediately terminates the connection with `401 Unauthorized` directly at the edge.
   - **Crucial engineering benefit:** Downstream Node.js containers and databases are never invoked, conserving 100% of internal compute resources!

3. **Token Bucket Rate Limiting (`HTTP 429 Too Many Requests`):**
   - Nginx enforces a `limit_req_zone` configured for `rate=5r/s` with a small burst buffer (`burst=5 nodelay`).
   - If an aggressive client spams requests beyond this quota, Nginx drops the excess calls with `429 Too Many Requests`.
   - This "noisy-neighbor" protection prevents any single consumer from degrading cluster performance.

---

## Core Concepts at a Glance

| Concept | Why It Matters | Real-World Intuition |
| :--- | :--- | :--- |
| **API Gateway** | Single public entry point fronting multiple internal microservices. | Like a secure building lobby with a security desk that checks badges and directs visitors to the right department. |
| **Reverse Proxy** | An intermediary server that receives public client requests and forwards them to private backend servers. | Hides internal container topology and private ports from external visibility. |
| **Edge Authentication** | Checking credentials (API keys / JWTs) at the gateway boundary. | Blocks malicious traffic at the perimeter before it consumes downstream application memory or CPU. |
| **Token Bucket Rate Limiting** | Regulates traffic rates (`rate=5r/s`) while permitting controlled bursts (`burst=5 nodelay`). | Smooths traffic spikes and rejects spam with `HTTP 429 Too Many Requests`. |
| **Declarative `map` Block** | High-performance hash table lookup in Nginx memory. | Evaluates incoming headers (`X-API-Key`) with $O(1)$ efficiency without invoking external auth services. |
| **Private Docker Bridge (`lab-net`)** | Container network where services talk via internal DNS names (`orders_service:3001`). | Zero host port exposure; internal microservices are physically unreachable from the public internet except through Nginx. |

---

## What You Will Build

```text
lab03-gateway-routing/
├── docker-compose.yml       # Docker Compose multi-container stack
├── nginx.conf               # Nginx API Gateway config (Auth + Rate Quotas + Routing)
├── services/
│   ├── orders-service/
│   │   ├── package.json
│   │   └── server.js        # Internal Orders Microservice (Port 3001)
│   └── users-service/
│       ├── package.json
│       └── server.js        # Internal Users Microservice (Port 3002)
├── verify-gateway.sh        # Automated cURL test script
└── images/
    └── lab03-architecture.svg  # Master architecture & routing topology diagram
```

---

## Step 1: Initialize Project and Microservices

In this step, you will create the project directories and set up two lightweight Node.js microservices: the **Orders Service** (running on internal port `3001`) and the **Users Service** (running on internal port `3002`).

### 1. Create directory structure:

```bash
mkdir -p ~/lab03-gateway-routing/services/orders-service
mkdir -p ~/lab03-gateway-routing/services/users-service
cd ~/lab03-gateway-routing
```

![Create Directories](images/step1-create-dirs.png)

---

### 2. Configure Orders Microservice

Create `services/orders-service/package.json`:

```bash
cat << 'EOF' > services/orders-service/package.json
{
  "name": "orders-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
EOF
```

![Create Orders package.json](images/step1-orders-package-json.png)

Create `services/orders-service/server.js`:

```bash
cat << 'EOF' > services/orders-service/server.js
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const orders = [
  { id: 101, item: "Mechanical Keyboard", amount: 150.00, status: "CONFIRMED" },
  { id: 102, item: "Ultra-Wide Monitor", amount: 450.00, status: "SHIPPED" },
  { id: 103, item: "USB-C Docking Station", amount: 89.99, status: "PENDING" }
];

app.get('/api/v1/orders', (req, res) => {
  const clientName = req.header('X-Client-Name') || 'Unknown';
  console.log(`[ORDERS SERVICE] Query processed for client: ${clientName}`);
  res.json({
    service: "Orders Service",
    port: PORT,
    authenticated_client: clientName,
    count: orders.length,
    data: orders
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Orders Service] Running on internal port ${PORT}`);
});
EOF
```

![Create Orders server.js](images/step1-orders-server-js.png)

---

### 3. Configure Users Microservice

Create `services/users-service/package.json`:

```bash
cat << 'EOF' > services/users-service/package.json
{
  "name": "users-service",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
EOF
```

![Create Users package.json](images/step1-users-package-json.png)

Create `services/users-service/server.js`:

```bash
cat << 'EOF' > services/users-service/server.js
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const users = [
  { id: 1, name: "Alice Rahman", role: "DevOps Engineer", active: true },
  { id: 2, name: "Bob Smith", role: "Backend Architect", active: true },
  { id: 3, name: "Charlie Davis", role: "Frontend Developer", active: false }
];

app.get('/api/v1/users', (req, res) => {
  const clientName = req.header('X-Client-Name') || 'Unknown';
  console.log(`[USERS SERVICE] Query processed for client: ${clientName}`);
  res.json({
    service: "Users Service",
    port: PORT,
    authenticated_client: clientName,
    count: users.length,
    data: users
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Users Service] Running on internal port ${PORT}`);
});
EOF
```

![Create Users server.js](images/step1-users-server-js.png)

---

## Step 2: Configure Nginx API Gateway (`nginx.conf`)

Now write the Nginx configuration. This file governs the entire ingress layer:

- **Upstream Definitions:** Uses Docker internal service names (`orders_service:3001` and `users_service:3002`).
- **Token Bucket Rate Limiting:** Allocates a 10MB memory zone (`limit_req_zone`) tracking client IPs at `rate=5r/s`.
- **API Key Map:** Maps valid keys (`valid-key-123`, `admin-key-999`) to client identities with $O(1)$ memory lookups.
- **Header Injection:** Forwards client metadata (`X-Real-IP`, `X-Forwarded-For`, `X-Client-Name`) to upstreams.
- **Edge Security:** Checks `$api_client_name` on protected endpoints; rejects unauthorized requests with `401`.

Create `nginx.conf`:

```bash
cat << 'EOF' > nginx.conf
events {
    worker_connections 1024;
}

http {
    # 1. Rate Limiting Zone: 5 requests/sec per client IP with a 10MB memory zone
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=5r/s;
    limit_req_status 429;

    # 2. Declarative API Key Authentication Map
    map $http_x_api_key $api_client_name {
        default             "";
        "valid-key-123"     "Frontend-App";
        "admin-key-999"     "Admin-Portal";
    }

    # 3. Upstream Internal Services
    upstream orders_upstream {
        server orders_service:3001;
    }

    upstream users_upstream {
        server users_service:3002;
    }

    server {
        listen 80;

        # Standard Proxy Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Client-Name $api_client_name;

        # Public Health Endpoint (Bypasses Auth & Rate Limits)
        location /healthz {
            access_log off;
            add_header Content-Type application/json;
            return 200 '{"status":"UP","gateway":"Nginx","timestamp":"$time_iso8601"}';
        }

        # Protected Orders Route
        location /api/v1/orders {
            # Edge Authentication Check
            if ($api_client_name = "") {
                return 401 '{"error":"Unauthorized: Invalid or Missing API Key","status":401}';
            }

            # Rate Limit Enforcement: Allow burst of 5 with nodelay
            limit_req zone=api_limit burst=5 nodelay;

            proxy_pass http://orders_upstream;
        }

        # Protected Users Route
        location /api/v1/users {
            # Edge Authentication Check
            if ($api_client_name = "") {
                return 401 '{"error":"Unauthorized: Invalid or Missing API Key","status":401}';
            }

            # Rate Limit Enforcement
            limit_req zone=api_limit burst=5 nodelay;

            proxy_pass http://users_upstream;
        }
    }
}
EOF
```

![Create nginx.conf](images/step2-nginx-conf.png)

---

## Step 3: Define Multi-Service Stack with Docker Compose

Now assemble the entire system in `docker-compose.yml`. 

> [!IMPORTANT]
> Notice that `orders_service` and `users_service` do **NOT** expose any host ports! Only Nginx exposes port `8080:80`. The microservices communicate exclusively across the private `lab-net` bridge network.

Create `docker-compose.yml`:

```bash
cat << 'EOF' > docker-compose.yml
version: '3.8'

services:
  gateway:
    image: nginx:alpine
    container_name: lab03-gateway
    ports:
      - "8080:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - orders_service
      - users_service
    networks:
      - lab-net
    restart: unless-stopped

  orders_service:
    image: node:18-alpine
    container_name: lab03-orders
    working_dir: /app
    volumes:
      - ./services/orders-service:/app
    command: sh -c "npm install && node server.js"
    networks:
      - lab-net
    restart: unless-stopped

  users_service:
    image: node:18-alpine
    container_name: lab03-users
    working_dir: /app
    volumes:
      - ./services/users-service:/app
    command: sh -c "npm install && node server.js"
    networks:
      - lab-net
    restart: unless-stopped

networks:
  lab-net:
    driver: bridge
EOF
```

![Create docker-compose.yml](images/step3-docker-compose.png)

---

## Step 4: Launch the Microservices Cluster

Start all three containers in the background:

```bash
docker compose up -d --build
```

![Launch Containers](images/step4-docker-compose-up.png)

Verify that all three services are running healthily:

```bash
docker compose ps
```

![Verify Running Containers](images/step4-docker-compose-ps.png)

Expected output:
```text
NAME           IMAGE          COMMAND                  SERVICE          CREATED         STATUS         PORTS
lab03-gateway  nginx:alpine   "/docker-entrypoint.…"   gateway          5 seconds ago   Up 4 seconds   0.0.0.0:8080->80/tcp
lab03-orders   node:18-alpine "sh -c 'npm install …"   orders_service   5 seconds ago   Up 4 seconds   
lab03-users    node:18-alpine "sh -c 'npm install …"   users_service    5 seconds ago   Up 4 seconds   
```

---

## Step 5: Verify Gateway Routing, Auth, and Rate Limiting

Now, test each gateway capability using `curl`.

### 1. Test Public Health Endpoint (Expect 200 OK)

The `/healthz` endpoint is open to monitoring tools without requiring an API key:

```bash
curl -i http://localhost:8080/healthz
```

![Test Health Endpoint](images/step5-test1-health.png)

Expected output:
```text
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"UP","gateway":"Nginx","timestamp":"2026-10-02T02:10:00+00:00"}
```

---

### 2. Test Edge Authentication Failure (Expect 401 Unauthorized)

Call the protected `/api/v1/orders` endpoint **without** the `X-API-Key` header:

```bash
curl -i http://localhost:8080/api/v1/orders
```

![Test Auth Failure](images/step5-test2-auth-unauthorized.png)

Expected output:
```text
HTTP/1.1 401 Unauthorized

{"error":"Unauthorized: Invalid or Missing API Key","status":401}
```

> [!NOTE]
> Nginx rejected the request instantly. The `orders-service` container was never invoked!

---

### 3. Test Authorized Route to Orders Service (Expect 200 OK)

Provide a valid `X-API-Key: valid-key-123`:

```bash
curl -i -H "X-API-Key: valid-key-123" http://localhost:8080/api/v1/orders
```

![Test Orders Routing](images/step5-test3-orders-service.png)

Expected output:
```text
HTTP/1.1 200 OK

{
  "service": "Orders Service",
  "port": 3001,
  "authenticated_client": "Frontend-App",
  "count": 3,
  "data": [ ... ]
}
```

Notice that Nginx successfully injected `authenticated_client: "Frontend-App"` into the downstream microservice!

---

### 4. Test Authorized Route to Users Service (Expect 200 OK)

Now query the separate `users-service` through the exact same gateway:

```bash
curl -i -H "X-API-Key: valid-key-123" http://localhost:8080/api/v1/users
```

![Test Users Routing](images/step5-test4-users-service.png)

Expected output:
```text
HTTP/1.1 200 OK

{
  "service": "Users Service",
  "port": 3002,
  "authenticated_client": "Frontend-App",
  "count": 3,
  "data": [ ... ]
}
```

---

### 5. Automated Verification & Rate-Limit Spikes

Create `verify-gateway.sh` to test route verification and flood the gateway with a burst of requests to trigger rate limiting:

```bash
cat << 'EOF' > verify-gateway.sh
#!/bin/bash
BASE_URL="http://localhost:8080"
VALID_KEY="valid-key-123"
INVALID_KEY="wrong-key-000"

echo "=== 1. Testing Healthz ==="
curl -s -o /dev/null -w "Health Status: %{http_code}\n" "$BASE_URL/healthz"

echo -e "\n=== 2. Testing Missing Key (Expect 401) ==="
curl -s -o /dev/null -w "Missing Key Status: %{http_code}\n" "$BASE_URL/api/v1/orders"

echo -e "\n=== 3. Testing Invalid Key (Expect 401) ==="
curl -s -o /dev/null -w "Invalid Key Status: %{http_code}\n" -H "X-API-Key: $INVALID_KEY" "$BASE_URL/api/v1/orders"

echo -e "\n=== 4. Testing Authorized Orders Route (Expect 200) ==="
curl -s -o /dev/null -w "Orders Route Status: %{http_code}\n" -H "X-API-Key: $VALID_KEY" "$BASE_URL/api/v1/orders"

echo -e "\n=== 5. Testing Authorized Users Route (Expect 200) ==="
curl -s -o /dev/null -w "Users Route Status: %{http_code}\n" -H "X-API-Key: $VALID_KEY" "$BASE_URL/api/v1/users"

echo -e "\n=== 6. Flooding Gateway to Test Rate Limiting (Expect 429) ==="
for i in {1..15}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $VALID_KEY" "$BASE_URL/api/v1/orders")
  echo "Request #$i -> Status $CODE"
done
EOF
```

![Create verify-gateway.sh](images/step5-test5-verify-script.png)

Execute the verification script:

```bash
bash verify-gateway.sh
```

![Execute verify-gateway.sh](images/step5-verify-script-run.png)

Expected output:
```text
=== 1. Testing Healthz ===
Health Status: 200

=== 2. Testing Missing Key (Expect 401) ===
Missing Key Status: 401

=== 3. Testing Invalid Key (Expect 401) ===
Invalid Key Status: 401

=== 4. Testing Authorized Orders Route (Expect 200) ===
Orders Route Status: 200

=== 5. Testing Authorized Users Route (Expect 200) ===
Users Route Status: 200

=== 6. Flooding Gateway to Test Rate Limiting (Expect 429) ===
Request #1 -> Status 200
Request #2 -> Status 200
Request #3 -> Status 200
Request #4 -> Status 200
Request #5 -> Status 200
Request #6 -> Status 200
Request #7 -> Status 429
Request #8 -> Status 429
Request #9 -> Status 429
...
```

Notice how requests #1 to #6 succeeded within the burst allowance, and subsequent rapid requests were throttled with `429 Too Many Requests`!

---

## Key Engineering Takeaways

1. **Edge Offloading Saves Compute:** Performing authentication and rate limiting at the Nginx edge blocks malicious and abusive traffic before it ever touches application servers or databases.
2. **True Network Isolation:** Using a private Docker bridge network (`lab-net`) ensures downstream microservices expose zero host ports, neutralizing unauthorized direct access attempts.
3. **Decoupled Architecture:** Frontends interact with a single ingress URL (`/api/v1/...`). Upstream service names, ports, and internal locations can change at any time without impacting client apps.
4. **Resilient Rate Shaping:** Token-bucket rate limiting gracefully absorbs normal traffic bursts while preventing denial-of-service and noisy-neighbor degradations.
