#!/usr/bin/env bash
# Patch .env for split API vs worker deploy (Phase 2).
# Usage:
#   bash scripts/patch-env-split-deploy.sh api   [path/to/.env]
#   bash scripts/patch-env-split-deploy.sh worker [path/to/.env]
#
# Prefer this over fix-production-api-env.sh when running separate API + worker processes.

set -euo pipefail

ROLE="${1:-}"
ENV_FILE="${2:-$HOME/chatbot-backend/.env}"

if [[ "$ROLE" != "api" && "$ROLE" != "worker" && "$ROLE" != "strip" ]]; then
  echo "Usage: $0 api|worker|strip [ENV_FILE]"
  echo "  strip — remove RUN_* from shared .env (same-host: use ecosystem.config.cjs per process)"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  exit 1
fi

strip_keys='^RUN_API=|^RUN_CRONS=|^RUN_WORKERS=|^CHATBOT_PROCESS_ROLE=|^EMAIL_SCHEDULE_TICK_ON_API=|^ABANDON_CART_TICK_ON_API=|^SUPPRESS_SPLIT_DEPLOY_WARN=|^CRON_USE_COORDINATOR=|^CRON_MONGO_CONCURRENCY=|^CRON_MONGO_BUDGET=|^ENABLE_SELF_PING=|^DEFER_STARTUP_HEAVY_MS=|^MONGODB_MAX_POOL_SIZE='
grep -v -E "$strip_keys" "$ENV_FILE" > "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "$ENV_FILE"

if [[ "$ROLE" == "strip" ]]; then
  cat >> "$ENV_FILE" <<'EOF'

# Split deploy — RUN_* owned by ecosystem.config.cjs (patched strip by patch-env-split-deploy.sh)
# Do not set RUN_API/RUN_CRONS/RUN_WORKERS here when API + worker share this host.
EOF
  echo "Stripped RUN_* from $ENV_FILE — per-process flags live in ecosystem.config.cjs"
  exit 0
fi

if [[ "$ROLE" == "api" ]]; then
  cat >> "$ENV_FILE" <<'EOF'

# Split deploy — API process (patched by patch-env-split-deploy.sh)
RUN_API=true
RUN_CRONS=false
RUN_WORKERS=false
CHATBOT_PROCESS_ROLE=api
EMAIL_SCHEDULE_TICK_ON_API=true
ABANDON_CART_TICK_ON_API=false
SUPPRESS_SPLIT_DEPLOY_WARN=true
EOF
  echo "Patched $ENV_FILE for API role. Start with: ./scripts/start-api-prod.sh or pm2 restart --update-env"
else
  cat >> "$ENV_FILE" <<'EOF'

# Split deploy — worker process (patched by patch-env-split-deploy.sh)
RUN_API=false
RUN_CRONS=true
RUN_WORKERS=true
CHATBOT_PROCESS_ROLE=worker
EMAIL_SCHEDULE_TICK_ON_API=false
ABANDON_CART_TICK_ON_API=false
SUPPRESS_SPLIT_DEPLOY_WARN=true
EOF
  echo "Patched $ENV_FILE for worker role. Start with: ./scripts/start-worker-prod.sh or pm2 restart --update-env"
fi
