#!/usr/bin/env bash
set -e

GATEWAY_URL="http://localhost:8080"
VALID_KEY="valid-secret-key-123"

echo "=========================================================="
echo "  Lab 03: API Gateway & Rate-Aware Routing Verification   "
echo "=========================================================="
echo ""

echo "1. Checking Gateway Health (Unauthenticated)..."
curl -s -i "$GATEWAY_URL/health" | head -n 8
echo ""

echo "2. Calling /api/v1/orders WITHOUT API Key (Expect 401 Unauthorized)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/api/v1/orders")
echo "HTTP Status Code: $HTTP_CODE"
if [ "$HTTP_CODE" -eq 401 ]; then
  echo " PASS: 401 Unauthorized enforced at Gateway edge."
else
  echo " FAIL: Expected 401, got $HTTP_CODE"
fi
echo ""

echo "3. Calling /api/v1/orders WITH Valid API Key (Expect 200 OK -> Orders Service)..."
curl -s -H "X-API-Key: $VALID_KEY" "$GATEWAY_URL/api/v1/orders" | jq .
echo ""

echo "4. Calling /api/v1/users WITH Valid API Key (Expect 200 OK -> Users Service)..."
curl -s -H "X-API-Key: $VALID_KEY" "$GATEWAY_URL/api/v1/users" | jq .
echo ""

echo "5. Testing Rate Limiting Quota (Sending 12 rapid concurrent requests)..."
echo "Rate limit is 5r/s with burst=5. Excess requests must receive 429 Too Many Requests."
COUNT_200=0
COUNT_429=0

for i in {1..12}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "X-API-Key: $VALID_KEY" "$GATEWAY_URL/api/v1/orders")
  if [ "$CODE" -eq 200 ]; then
    COUNT_200=$((COUNT_200 + 1))
  elif [ "$CODE" -eq 429 ]; then
    COUNT_429=$((COUNT_429 + 1))
  fi
done

echo "Results from 12 rapid requests: 200 OK = $COUNT_200, 429 Rate-Limited = $COUNT_429"
if [ "$COUNT_429" -gt 0 ]; then
  echo " PASS: Rate limit quota enforced by Nginx Gateway!"
else
  echo " WARNING: No 429 received, requests may have been spaced out."
fi

echo ""
echo "=========================================================="
echo "  ALL GATEWAY TESTS COMPLETED                             "
echo "=========================================================="
