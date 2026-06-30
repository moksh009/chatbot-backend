# API-only local dev — frees Mongo pool; skips BullMQ workers (see start-api-dev.sh).
Set-Location (Join-Path $PSScriptRoot "..")
$env:RUN_API = "true"
$env:RUN_CRONS = "false"
$env:RUN_WORKERS = "false"
$env:CRON_USE_COORDINATOR = "true"
if (-not $env:PERF_LOGGING) { $env:PERF_LOGGING = "false" }
if (-not $env:DEFER_STARTUP_HEAVY_MS) { $env:DEFER_STARTUP_HEAVY_MS = "60000" }
$env:ENABLE_SELF_PING = "false"
$env:CRON_ENABLE_AMAZON_SYNC = "false"
$env:CRON_ENABLE_AB_WINNER = "false"
if (-not $env:MONGODB_MAX_POOL_SIZE) { $env:MONGODB_MAX_POOL_SIZE = "25" }
if (-not $env:MONGODB_WAIT_QUEUE_TIMEOUT_MS) { $env:MONGODB_WAIT_QUEUE_TIMEOUT_MS = "12000" }
$port = if ($env:PORT) { $env:PORT } else { "5001" }
Write-Host "Starting API-only on port $port (RUN_CRONS=false RUN_WORKERS=false)"
node index.js
