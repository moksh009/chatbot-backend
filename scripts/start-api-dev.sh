#!/usr/bin/env bash
# API-only local dev — frees Mongo pool for Live Chat / dashboard UI testing.
cd "$(dirname "$0")/.."
export RUN_API=true
export RUN_CRONS=false
export RUN_WORKERS=false
export CRON_USE_COORDINATOR=true
export PERF_LOGGING="${PERF_LOGGING:-true}"
export DEFER_STARTUP_HEAVY_MS="${DEFER_STARTUP_HEAVY_MS:-60000}"
export ENABLE_SELF_PING=false
export CRON_ENABLE_AMAZON_SYNC=false
export CRON_ENABLE_AB_WINNER=false
export MONGODB_MAX_POOL_SIZE="${MONGODB_MAX_POOL_SIZE:-25}"
export MONGODB_WAIT_QUEUE_TIMEOUT_MS="${MONGODB_WAIT_QUEUE_TIMEOUT_MS:-12000}"
export INBOUND_QUEUE_FIRST_FLUSH_MS="${INBOUND_QUEUE_FIRST_FLUSH_MS:-0}"
export AI_CALL_TIMEOUT_MS="${AI_CALL_TIMEOUT_MS:-5000}"
export DUAL_BRAIN_BUDGET_MS="${DUAL_BRAIN_BUDGET_MS:-22000}"
echo "Starting API-only on port ${PORT:-5001} (RUN_CRONS=false RUN_WORKERS=false)"
echo "Tip: run crons in another terminal with ./scripts/start-crons-only.sh"
exec node index.js
