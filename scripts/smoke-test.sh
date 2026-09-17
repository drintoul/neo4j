#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the Neo4j Docker Compose stack.
# This script validates the Compose file, starts the stack, waits for all
# services to become healthy, then curls the public health endpoints.

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [[ ! -f .env ]]; then
  echo "WARN: .env not found; copying .env.example for this test"
  cp .env.example .env
fi

echo "Validating docker-compose.yml..."
docker compose config > /dev/null

echo "Starting stack..."
docker compose up -d --build

cleanup() {
  echo "Shutting down stack..."
  docker compose down
}
trap cleanup EXIT

wait_for_healthy() {
  local service="$1"
  local attempts=30
  local delay=2
  echo "Waiting for $service to be healthy..."
  for ((i=1; i<=attempts; i++)); do
    if docker compose ps "$service" --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
      echo "  $service is healthy"
      return 0
    fi
    sleep "$delay"
  done
  echo "ERROR: $service did not become healthy in time"
  docker compose logs "$service" --tail 50
  return 1
}

wait_for_healthy neo4j
wait_for_healthy llm-proxy
wait_for_healthy ui
wait_for_healthy mcp

UI_PORT=$(grep '^UI_PORT=' .env | cut -d= -f2 || echo 3000)
MCP_PORT=$(grep '^MCP_PUBLISHED_PORT=' .env | cut -d= -f2 || echo 3001)
LLM_PORT=$(grep '^LLM_PROXY_PUBLISHED_PORT=' .env | cut -d= -f2 || echo 3005)

echo "Checking health endpoints..."
curl -fsS "http://127.0.0.1:${UI_PORT}/" > /dev/null && echo "  UI OK"
curl -fsS "http://127.0.0.1:${LLM_PORT}/health" > /dev/null && echo "  LLM proxy OK"
curl -fsS "http://127.0.0.1:${MCP_PORT}/" > /dev/null && echo "  MCP OK"

echo "Smoke test passed."
