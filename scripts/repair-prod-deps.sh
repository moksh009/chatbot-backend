#!/usr/bin/env bash
# Recover from corrupted node_modules (MODULE_NOT_FOUND for express/mongoose/iconv-lite).
# Run on the VPS after git pull, before pm2 restart.
#
# Usage:
#   cd ~/chatbot-backend && bash scripts/repair-prod-deps.sh
#   bash scripts/repair-prod-deps.sh --no-restart   # install + probe only
#
# Safe to re-run. Uses npm ci (lockfile) — do not edit package-lock.json on the server.

set -euo pipefail

NO_RESTART=false
for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=true ;;
    -h|--help)
      echo "Usage: $0 [--no-restart]"
      exit 0
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_ROOT"

echo "==> TopEdge backend dependency repair"
echo "    root: $BACKEND_ROOT"
echo "    node: $(node -v 2>/dev/null || echo 'missing')"
echo "    npm:  $(npm -v 2>/dev/null || echo 'missing')"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -ge 23 ]]; then
  echo ""
  echo "WARN: Node $(node -v) is very new. Prefer Node 20 LTS (nvm install 20 && nvm use 20)."
  echo "      Corrupted installs are usually fixed by npm ci; if issues persist, pin Node 20."
  echo ""
fi

if [[ ! -f package-lock.json ]]; then
  echo "ERROR: package-lock.json missing — cannot run npm ci safely."
  exit 1
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git diff --quiet package-lock.json 2>/dev/null; then
    echo "WARN: package-lock.json has local modifications on server."
    echo "      Run: git checkout -- package-lock.json   (then re-run this script)"
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "==> Stopping pm2 (prevents MODULE_NOT_FOUND during install)"
  pm2 stop topedge-api topedge-worker 2>/dev/null || true
fi

echo "==> Removing node_modules"
rm -rf node_modules

echo "==> npm ci --omit=dev"
npm ci --omit=dev

echo "==> Core module smoke"
node -e "
  const mods = ['express', 'mongoose', 'iconv-lite', 'object-inspect', 'ioredis', 'bullmq'];
  for (const m of mods) {
    require(m);
    console.log('  ok', m);
  }
"

echo "==> Route integration probe"
npm run integration-probe

if [[ "$NO_RESTART" == "true" ]]; then
  echo "==> Skipping pm2 restart (--no-restart)"
  exit 0
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "==> Starting pm2 from ecosystem.config.cjs"
  if [[ -f ecosystem.config.cjs ]]; then
    pm2 delete topedge-api topedge-worker 2>/dev/null || true
    pm2 start ecosystem.config.cjs --update-env
    pm2 save
  else
    pm2 restart topedge-api topedge-worker --update-env 2>/dev/null || true
  fi
  pm2 list
  echo ""
  echo "Tail logs:"
  echo "  pm2 logs topedge-api --lines 40 --nostream"
  echo "  pm2 logs topedge-worker --lines 40 --nostream"
else
  echo "pm2 not found — deps repaired; restart processes manually."
fi

echo "==> Done"
