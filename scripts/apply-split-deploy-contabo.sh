#!/usr/bin/env bash
# Apply Phase 2 split deploy on Contabo (or any VPS with PM2).
# Run ONCE per host after git pull — patches .env then restarts processes.
#
# Usage:
#   bash scripts/apply-split-deploy-contabo.sh api    # api.topedgeai.com process
#   bash scripts/apply-split-deploy-contabo.sh worker # cron + BullMQ process
#
# Prerequisites: pm2, .env at $ENV_FILE (default ~/chatbot-backend/.env)

set -euo pipefail

ROLE="${1:-}"
ENV_FILE="${ENV_FILE:-$HOME/chatbot-backend/.env}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$ROLE" != "api" && "$ROLE" != "worker" ]]; then
  echo "Usage: $0 api|worker"
  echo "  api    — HTTP only (RUN_CRONS=false RUN_WORKERS=false)"
  echo "  worker — crons + BullMQ (RUN_API=false)"
  exit 1
fi

bash "$SCRIPT_DIR/patch-env-split-deploy.sh" "$ROLE" "$ENV_FILE"

cd "$BACKEND_ROOT"

# Clean install when lockfile present — prevents MODULE_NOT_FOUND crash loops after partial pulls.
if [[ -f package-lock.json ]]; then
  echo "==> npm ci --omit=dev (lockfile install)"
  npm ci --omit=dev
  echo "==> integration probe"
  npm run integration-probe
else
  echo "WARN: no package-lock.json — skipping npm ci"
fi

if [[ "$ROLE" == "api" ]]; then
  if pm2 describe topedge-api >/dev/null 2>&1; then
    pm2 restart topedge-api --update-env
    echo "Restarted pm2: topedge-api"
  else
    echo "No pm2 process 'topedge-api' — start manually:"
    echo "  pm2 start $SCRIPT_DIR/start-api-prod.sh --name topedge-api"
  fi
else
  if pm2 describe topedge-worker >/dev/null 2>&1; then
    pm2 restart topedge-worker --update-env
    echo "Restarted pm2: topedge-worker"
  else
    echo "No pm2 process 'topedge-worker' — start manually:"
    echo "  pm2 start $SCRIPT_DIR/start-worker-prod.sh --name topedge-worker"
  fi
fi

echo ""
echo "Verify logs:"
if [[ "$ROLE" == "api" ]]; then
  echo "  pm2 logs topedge-api --lines 30 | rg 'RUN_CRONS=false|HTTP server'"
else
  echo "  pm2 logs topedge-worker --lines 30 | rg 'RUN_API=false|workers/crons only'"
fi
