#!/usr/bin/env bash
# Quick prod boot check — run on VPS before pm2 restart.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: missing $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

missing=0
for key in MONGODB_URI JWT_SECRET; do
  if [[ -z "${!key:-}" ]]; then
    echo "FAIL: $key not set in $ENV_FILE"
    missing=1
  fi
done

enc="${FIELD_ENCRYPTION_KEY:-${ENCRYPTION_KEY:-}}"
if [[ -z "$enc" ]]; then
  echo "FAIL: FIELD_ENCRYPTION_KEY (or ENCRYPTION_KEY) not set"
  missing=1
elif [[ ${#enc} -lt 32 ]]; then
  echo "FAIL: encryption key must be at least 32 characters (got ${#enc})"
  missing=1
else
  echo "OK: encryption key present (${#enc} chars)"
fi

node -e "require('express'); require('mongoose'); console.log('OK: node_modules')"

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi
echo "OK: boot secrets look valid"
