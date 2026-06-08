#!/usr/bin/env bash
# Phase 5 / Plan C: cron + worker process (no HTTP) — pair with start-api-dev.sh.
cd "$(dirname "$0")/.."
export RUN_API=false
export RUN_CRONS=true
export RUN_WORKERS=true
export CRON_USE_COORDINATOR=true
export CRON_MONGO_CONCURRENCY="${CRON_MONGO_CONCURRENCY:-3}"
export CRON_MONGO_BUDGET="${CRON_MONGO_BUDGET:-true}"
export PERF_LOGGING="${PERF_LOGGING:-false}"
export CRON_ENABLE_AMAZON_SYNC="${CRON_ENABLE_AMAZON_SYNC:-false}"
export CRON_ENABLE_AB_WINNER="${CRON_ENABLE_AB_WINNER:-false}"
export ENABLE_SELF_PING=false
export SUPPRESS_SPLIT_DEPLOY_WARN=true
echo "Starting crons+workers only (RUN_API=false CRON_USE_COORDINATOR=true)"
exec node index.js
