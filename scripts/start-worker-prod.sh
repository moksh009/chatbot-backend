#!/usr/bin/env bash
# Production worker process — all crons + BullMQ workers; no HTTP listener.
# Pair with start-api-prod.sh on the API service.
cd "$(dirname "$0")/.."
export RUN_API=false
export RUN_CRONS=true
export RUN_WORKERS=true
export CHATBOT_PROCESS_ROLE=worker
export CRON_USE_COORDINATOR=true
export CRON_MONGO_CONCURRENCY="${CRON_MONGO_CONCURRENCY:-3}"
export CRON_MONGO_BUDGET="${CRON_MONGO_BUDGET:-true}"
export ENABLE_SELF_PING=false
export SUPPRESS_SPLIT_DEPLOY_WARN=true
export MONGODB_MAX_POOL_SIZE="${MONGODB_MAX_POOL_SIZE:-15}"
echo "Starting production worker (RUN_API=false RUN_CRONS=true RUN_WORKERS=true)"
exec node index.js
