const http = require('http');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const VALID_KEY = 'm6_secret_token_123';

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GATEWAY_URL);
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

async function runIntegrationSuite() {
  console.log('===============================================================');
  console.log('  Lab 04: End-to-End Integrated API Layer Verification Suite   ');
  console.log('===============================================================\n');

  try {
    // 1. Edge Authentication Enforcement at Gateway
    console.log('Test 1: Calling /api/v1/orders WITHOUT X-API-Key through Gateway...');
    const r1 = await request('POST', '/api/v1/orders', {}, { item_id: 1, quantity: 1, amount: 50 });
    if (r1.status === 401) {
      console.log(' PASS: 401 Unauthorized returned by Nginx Gateway edge.\n');
    } else {
      throw new Error(`Test 1 Failed: Status was ${r1.status}`);
    }

    // 2. OpenAPI Schema & Header Enforcement at API Service
    console.log('Test 2: Calling /api/v1/orders WITH X-API-Key but WITHOUT Idempotency-Key...');
    const r2 = await request('POST', '/api/v1/orders', { 'X-API-Key': VALID_KEY }, { item_id: 1, quantity: 1, amount: 50 });
    if (r2.status === 400 && r2.body.title === 'Missing Required Header') {
      console.log(' PASS: 400 Bad Request returned by API Service validation layer.\n');
    } else {
      throw new Error(`Test 2 Failed: Status was ${r2.status}`);
    }

    // 3. First End-to-End Idempotent Mutation through Gateway
    const testKey = 'm6_e2e_tx_881';
    console.log(`Test 3: Primary POST through Gateway with Idempotency-Key="${testKey}"...`);
    const r3 = await request('POST', '/api/v1/orders', {
      'X-API-Key': VALID_KEY,
      'Idempotency-Key': testKey
    }, {
      item_id: 501,
      quantity: 2,
      amount: 299.99
    });

    if (r3.status === 201 && r3.headers['x-cache'] === 'MISS' && r3.body.id) {
      console.log(` PASS: 201 Created (X-Cache: MISS). Order ID: ${r3.body.id}, Amount: $${r3.body.amount}\n`);
    } else {
      throw new Error(`Test 3 Failed: Status ${r3.status}, Cache ${r3.headers['x-cache']}`);
    }

    // 4. Duplicate POST through Gateway with Identical Idempotency-Key
    console.log(`Test 4: Simulating Client Retry through Gateway with exact same key="${testKey}"...`);
    const r4 = await request('POST', '/api/v1/orders', {
      'X-API-Key': VALID_KEY,
      'Idempotency-Key': testKey
    }, {
      item_id: 501,
      quantity: 2,
      amount: 299.99
    });

    if (r4.status === 201 && r4.headers['x-cache'] === 'HIT-IDEMPOTENT' && r4.body.id === r3.body.id) {
      console.log(` PASS: 201 Created (X-Cache: HIT-IDEMPOTENT). Exact same Order ID ${r4.body.id} returned from Redis cache!`);
    } else {
      throw new Error(`Test 4 Failed: Status ${r4.status}, Cache ${r4.headers['x-cache']}`);
    }

    // 5. Database State Verification (Proving exactly ONE record created)
    console.log('\nTest 5: Querying database state through Gateway...');
    const r5 = await request('GET', '/api/v1/orders', { 'X-API-Key': VALID_KEY });
    console.log(`Persistent database total orders = ${r5.body.total}`);
    if (r5.body.total === 1) {
      console.log(' PASS: Exactly ONE order committed to persistent store. Idempotency enforced end-to-end!\n');
    } else {
      throw new Error(`Expected 1 order in DB, found ${r5.body.total}`);
    }

    console.log('===============================================================');
    console.log(' ALL END-TO-END INTEGRATION TESTS PASSED SUCCESSFULLY!         ');
    console.log('===============================================================');
  } catch (err) {
    console.error('Integration suite error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runIntegrationSuite();
}

module.exports = { runIntegrationSuite };
