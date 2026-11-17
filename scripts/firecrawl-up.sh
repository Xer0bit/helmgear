#!/usr/bin/env bash
# Start the self-hosted Firecrawl containers in the order they need: the queue
# and databases first, the API once the queue is healthy. Safe to run again.
set -euo pipefail
P="${FIRECRAWL_PREFIX:-bitseo-firecrawl}"
docker start "$P-redis-1" "$P-rabbitmq-1" "$P-nuq-postgres-1" "$P-foundationdb-1" "$P-playwright-service-1" >/dev/null
for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$P-rabbitmq-1" 2>/dev/null)" = healthy ] && break
  sleep 2
done
docker start "$P-api-1" >/dev/null
for _ in $(seq 1 40); do
  curl -s -m 3 -o /dev/null "${FIRECRAWL_URL:-http://127.0.0.1:3002}/" && { echo "Firecrawl is up."; exit 0; }
  sleep 2
done
echo "Firecrawl did not answer. Check: docker logs $P-api-1" >&2
exit 1
