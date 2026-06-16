#!/usr/bin/env bash
# Apply Phase 2 split deploy on Contabo (API + worker on same host).
#
# Usage (recommended — one npm ci, both processes):
#   bash scripts/apply-split-deploy-contabo.sh
#   bash scripts/apply-split-deploy-contabo.sh both
#
# Legacy single-role (avoid on same host — races on node_modules):
#   bash scripts/apply-split-deploy-contabo.sh api
#   bash scripts/apply-split-deploy-contabo.sh worker
#
# Prerequisites: pm2, .env at $ENV_FILE (default ~/chatbot-backend/.env)

set -euo pipefail

ROLE="${1:-both}"
ENV_FILE="${ENV_FILE:-$HOME/chatbot-backend/.env}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

install_deps() {
  echo "==> Stopping pm2 (avoid MODULE_NOT_FOUND during npm ci)"
  pm2 stop topedge-api topedge-worker 2>/dev/null || true

  cd "$BACKEND_ROOT"
  if [[ -f package-lock.json ]]; then
    echo "==> npm ci --omit=dev (lockfile install)"
    npm ci --omit=dev
    echo "==> integration probe"
    npm run integration-probe
    echo "==> core module smoke"
    node -e "require('express'); require('mongoose'); console.log('express + mongoose ok')"
  else
    echo "WARN: no package-lock.json — skipping npm ci"
  fi
}

start_or_reload_ecosystem() {
  cd "$BACKEND_ROOT"
  if [[ ! -f ecosystem.config.cjs ]]; then
    echo "ERROR: ecosystem.config.cjs missing — git pull first"
    exit 1
  fi

  if pm2 describe topedge-api >/dev/null 2>&1 || pm2 describe topedge-worker >/dev/null 2>&1; then
    echo "==> pm2 reload ecosystem (update env + cwd)"
    pm2 delete topedge-api topedge-worker 2>/dev/null || true
  fi

  pm2 start ecosystem.config.cjs --update-env
  pm2 save
  pm2 list
}

restart_one_pm2() {
  local name="$1"
  if pm2 describe "$name" >/dev/null 2>&1; then
    pm2 restart "$name" --update-env
    echo "Restarted pm2: $name"
  else
    echo "No pm2 process '$name' — use: bash $0 both"
  fi
}

case "$ROLE" in
  both|"")
    echo "==> Split deploy: BOTH processes (recommended)"
    bash "$SCRIPT_DIR/patch-env-split-deploy.sh" strip "$ENV_FILE"
    install_deps
    start_or_reload_ecosystem
    echo ""
    echo "Verify:"
    echo "  pm2 logs topedge-api --lines 25 --nostream | tail -15"
    echo "  pm2 logs topedge-worker --lines 25 --nostream | tail -15"
    echo "  curl -s https://api.topedgeai.com/api/health/workers"
    ;;
  api)
    echo "WARN: single-role 'api' on a shared host can break worker — prefer: bash $0 both"
    bash "$SCRIPT_DIR/patch-env-split-deploy.sh" strip "$ENV_FILE"
    install_deps
    restart_one_pm2 topedge-api
    ;;
  worker)
    echo "WARN: single-role 'worker' on a shared host can break api — prefer: bash $0 both"
    bash "$SCRIPT_DIR/patch-env-split-deploy.sh" strip "$ENV_FILE"
    install_deps
    restart_one_pm2 topedge-worker
    ;;
  *)
    echo "Usage: $0 [both|api|worker]"
    exit 1
    ;;
esac
