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
