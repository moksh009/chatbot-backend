# Phase 5 — Production hardening

## Split processes (recommended on Render)

| Service | Env | Role |
|---------|-----|------|
| **Web** | `RUN_API=true` `RUN_CRONS=false` `RUN_WORKERS=false` | Dashboard, Live Chat, webhooks |
| **Worker** | `RUN_API=false` `RUN_CRONS=true` `RUN_WORKERS=true` | BullMQ + all crons |
| **Crons-only** (optional) | `RUN_API=false` `RUN_CRONS=true` `RUN_WORKERS=false` | Heavy schedules without workers |

Local scripts:

```bash
./scripts/start-api-dev.sh      # UI development
./scripts/start-crons-only.sh   # background crons
```

## Cron cleanup (Phase 5)

- **`cron/cronBootstrap.js`** — single registration point
- **Coordinator** — 2m / 5m / 10m / 15m bundles (sequential mongo work, max 3 concurrent via `mongoCronBudget`)
- **Flow resumption** — every **2 min** default (`FLOW_RESUMPTION_EVERY_MINUTE=true` for every minute)
- **Disabled locally by default:** Amazon sync (`CRON_ENABLE_AMAZON_SYNC`), A/B winner cron (`CRON_ENABLE_AB_WINNER`)
- **Self-ping** — only when `SERVER_URL` / `RENDER_EXTERNAL_URL` or `ENABLE_SELF_PING=true`
- **Startup** — NLP + flow prewarm deferred 45s (`DEFER_STARTUP_HEAVY_MS`)

## Mongo pool

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONGODB_MAX_POOL_SIZE` | 25 | Atlas connection cap |
| `MONGODB_WAIT_QUEUE_TIMEOUT_MS` | 12000 | Fail queued ops instead of 20s hang |
| `CRON_MONGO_CONCURRENCY` | 3 | Max parallel cron ticks |
| `RUN_CRONS` | true | Set `false` for API-only dev |

## Observability

- `PERF_LOGGING=true` — step timers in logs
- `SLOW_REQUEST_MS=5000` — `[SlowRequest]` warnings
- `GET /api/health` — includes `mongoCronBudget` stats

## Phase 5A — Frontend request budgets

| Page | Behavior |
|------|----------|
| **Orders** | `/orders/products` and `/orders/states` load only when a filter dropdown opens or filters are already applied |
| **Live Chat** | Billing deferred 8s, 8s timeout |
| **Settings** | Billing only when Billing tab is active |
| **Flow Builder** | WA templates deferred 5s after flow list loads |

## DailyStat rollup maintenance (Phase 5D)

Handled by `cron/statCacheCron.js` (requires `RUN_CRONS=true`):

| Schedule | Job |
|----------|-----|
| `45 18 * * *` (UTC) | Roll up **yesterday** for all clients |
| `25 * * * *` | Refresh **today** hourly |

Backfill after schema changes:

```bash
node scripts/backfillDailyStatRollup.js --clientId=YOUR_CLIENT --days=90
```

## WhatsApp greeting (Phase 8B)

- Inbound saved + socket emit **before** AI (`message_saved_early`)
- Greetings (`hi`, `hello`, `hey`, …) use fast path + optional instant welcome fallback
- Env: `INBOUND_QUEUE_FIRST_FLUSH_MS=0` (no debounce on first message)

## Verification

```bash
./scripts/start-api-dev.sh   # terminal 1 — API only
node scripts/archive/verify-checklists/verifyPhase8Checklist.js --clientId=YOUR_CLIENT
node scripts/archive/verify-checklists/verifyPhase5Checklist.js --clientId=YOUR_CLIENT
node scripts/archive/verify-checklists/verifyPhase3Rollup.js --clientId=YOUR_CLIENT   # uses HTTP when server up
node scripts/benchmarkMongoPool.js
```

Production split:

```bash
./scripts/start-api-dev.sh      # Web dyno: RUN_CRONS=false RUN_WORKERS=false
./scripts/start-crons-only.sh   # Worker dyno: RUN_CRONS=true RUN_WORKERS=true
```
