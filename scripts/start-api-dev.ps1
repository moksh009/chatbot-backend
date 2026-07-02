# API-only local dev on Windows — no Redis required.
# For full journeys/workers: .\scripts\start-local-full.ps1
# Usage: .\scripts\start-api-dev.ps1Set-Location (Split-Path $PSScriptRoot -Parent)

$env:RUN_API = "true"
$env:RUN_CRONS = "false"
$env:RUN_WORKERS = "false"
$env:REDIS_DISABLED = "true"
$env:NODE_ENV = "development"
$env:SUPPRESS_SPLIT_DEPLOY_WARN = "true"

Write-Host "Starting API-only dev server (port $($env:PORT ?? '5001'))"
Write-Host "  RUN_CRONS=false  RUN_WORKERS=false  REDIS_DISABLED=true"
Write-Host "MongoDB: uses MONGODB_URI from .env (Atlas)"
Write-Host "Tip: for full workers/crons, install Redis then run without REDIS_DISABLED"
node index.js
