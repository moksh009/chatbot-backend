#!/usr/bin/env bash
# Fix api.topedgeai.com CORS failures caused by RUN_API=false on the main PM2 app.
# Run on the server: bash scripts/fix-production-api-env.sh

set -euo pipefail
ENV_FILE="${1:-$HOME/chatbot-backend/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE"
  exit 1
fi

echo "Patching $ENV_FILE — ensuring RUN_API=true for main API process..."

# Remove conflicting RUN_* lines at end of file; append canonical block.
grep -v '^RUN_API=' "$ENV_FILE" | grep -v '^RUN_CRONS=' | grep -v '^RUN_WORKERS=' | grep -v '^ABANDON_CART_TICK_ON_API=' | grep -v '^SUPPRESS_SPLIT_DEPLOY_WARN=' > "${ENV_FILE}.tmp"
mv "${ENV_FILE}.tmp" "$ENV_FILE"

cat >> "$ENV_FILE" <<'EOF'

# Process role — main Contabo PM2 app serves API + crons + workers
RUN_API=true
RUN_CRONS=true
RUN_WORKERS=true
ABANDON_CART_TICK_ON_API=false
SUPPRESS_SPLIT_DEPLOY_WARN=true
EOF

echo "Done. Restart with: pm2 restart chatbot-backend --update-env"
echo "Verify logs show: Starting HTTP server on port ..."
