# Full local dev — API + crons + BullMQ workers (Redis 5+ required for BullMQ).
# Usage: .\scripts\start-local-full.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)

$redisDir = Join-Path $PWD "tools\redis"
$redisExe = Join-Path $redisDir "redis-server.exe"
$redisConf = Join-Path $redisDir "redis.local.conf"
$redisPort = 6380

function Test-RedisPort([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
}

if (-not (Test-Path $redisExe)) {
  Write-Host "Portable Redis not found at tools\redis"
  Write-Host "Run once from backend root:"
  Write-Host '  New-Item -ItemType Directory -Force tools\redis | Out-Null'
  Write-Host '  Invoke-WebRequest -Uri "https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip" -OutFile tools\redis\Redis.zip'
  Write-Host '  Expand-Archive tools\redis\Redis.zip -DestinationPath tools\redis -Force'
  exit 1
}

if (-not (Test-RedisPort $redisPort)) {
  Write-Host "Starting Redis 5 on port $redisPort..."
  Start-Process -FilePath $redisExe -ArgumentList $redisConf -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

if (-not (Test-RedisPort $redisPort)) {
  Write-Host "Redis failed to start on $redisPort"
  exit 1
}

Write-Host "Redis: OK ($redisPort)"
Write-Host "Starting full dev server (API + crons + workers) on port $($env:PORT ?? '5001')"
Write-Host "  REDIS_URL should be redis://127.0.0.1:6380 in .env.local"
node index.js
