#!/usr/bin/env bash
set -e

echo "Starting Docker Compose stack for Lab 04..."
docker compose up -d

echo "Waiting 6 seconds for services to initialize..."
sleep 6

echo "Executing automated end-to-end integration tests..."
node test-integration.js

echo ""
echo "Cleaning up containers..."
docker compose down
