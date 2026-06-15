#!/usr/bin/env bash
# Production API-only process — HTTP + optional email schedule tick; no crons/workers.
# Pair with start-worker-prod.sh on a separate host/Render service.
cd "$(dirname "$0")/.."
export RUN_API=true
export RUN_CRONS=false
export RUN_WORKERS=false
export CHATBOT_PROCESS_ROLE=api
export EMAIL_SCHEDULE_TICK_ON_API="${EMAIL_SCHEDULE_TICK_ON_API:-true}"
export ABANDON_CART_TICK_ON_API="${ABANDON_CART_TICK_ON_API:-false}"
export SUPPRESS_SPLIT_DEPLOY_WARN=true
export DEFER_STARTUP_HEAVY_MS="${DEFER_STARTUP_HEAVY_MS:-45000}"
export MONGODB_MAX_POOL_SIZE="${MONGODB_MAX_POOL_SIZE:-25}"
echo "Starting production API (RUN_CRONS=false RUN_WORKERS=false EMAIL_SCHEDULE_TICK_ON_API=${EMAIL_SCHEDULE_TICK_ON_API})"
exec node index.js
