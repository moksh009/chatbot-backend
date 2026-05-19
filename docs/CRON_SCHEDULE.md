# Cron schedule reference (Plan C)

All crons register through `cron/cronBootstrap.js`. Heavy overlapping jobs are **bundled** in `cron/cronCoordinator.js` when `CRON_USE_COORDINATOR` is not `false` (default).

Every tick wrapped in `wrapCron()` acquires a **Mongo cron budget slot** (`CRON_MONGO_CONCURRENCY`, default `3`) so API routes are not starved.

---

## Local dev (recommended split)

| Terminal | Command | `RUN_API` | `RUN_CRONS` | `RUN_WORKERS` |
|----------|---------|-----------|-------------|---------------|
| Dashboard / WhatsApp API | `./scripts/start-api-dev.sh` | true | **false** | false |
| Background jobs | `./scripts/start-crons-only.sh` | false | true | true |

**Do not** run `node index.js` with all flags true during UI testing — Mongo pool wait queues cause 15–30s API latency.

---

## Coordinator bundles (default)

| Schedule | Bundle | Jobs (sequential inside bundle) |
|----------|--------|----------------------------------|
| `*/2 * * * *` | 2 min | Scheduled messages |
| `*/5 * * * *` | 5 min | Abandoned cart → Follow-up sequences → Campaign scheduler |
| `*/10 * * * *` | 10 min | CSAT primary |
| `*/15 * * * *` | 15 min | COD confirmation → Auto-resume bot → CSAT secondary |

When coordinator is on, per-file `node-cron` timers for those jobs are **skipped**; only `runTick` exports run from the coordinator.

---

## Always-on (separate timers)

| Module | Schedule | Notes |
|--------|----------|-------|
| `flowResumptionCron` | `*/2 * * * *` (or `* * * * *` if `FLOW_RESUMPTION_EVERY_MINUTE=true`) | Resumes paused flow nodes |
| `loyaltyCron` | per file | Loyalty accrual |
| `statCacheCron` | IST evening + hourly rollup | DailyStat / StatCache |
| `checkoutLinkRecoveryCron` | per file | Recovery links |
| `reviewCollection` | per file | Review prompts |
| `birthdayCron` | per file | Birthday wishes |
| `productSyncCron` | per file | Product sync |
| `templateStatusSyncCron` | per file | Meta template status |
| `insightsCron` | per file | Insights generation |
| `abTestCron` | per file | A/B tests |
| `leadScoringCron` | nightly | Lead scores |
| `igTokenRefresher` | per file | Instagram tokens |
| `autoResolutionCron` | hourly | Auto-close conversations |

---

## Daily / IST (`Asia/Kolkata`)

| Job | Schedule |
|-----|----------|
| `resetDailyErrorCounts` | `0 0 * * *` UTC |
| Meta Ads sync | `0 6 * * *` |
| Instagram token refresh | `0 8 * * *` |

---

## Optional (env flags)

| Flag | Cron |
|------|------|
| `CRON_ENABLE_AMAZON_SYNC=true` | `amazonSync` |
| `CRON_ENABLE_AB_WINNER=true` | `abTestWinner` |
| `ENABLE_SELF_PING=true` + `SERVER_URL` | Keepalive `*/14 * * * *` |

---

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN_CRONS` | `true` | Set `false` on API-only dyno |
| `RUN_API` | `true` | Set `false` on workers-only dyno |
| `RUN_WORKERS` | `true` | BullMQ workers |
| `CRON_USE_COORDINATOR` | `true` | Bundle overlapping crons |
| `CRON_MONGO_CONCURRENCY` | `3` | Max concurrent cron Mongo operations |
| `CRON_MONGO_BUDGET` | on | Set `false` to disable budget (not recommended) |
| `MONGODB_MAX_POOL_SIZE` | `25` | Driver pool cap |
| `MONGODB_WAIT_QUEUE_TIMEOUT_MS` | `12000` | Max wait for pool slot |
| `FLOW_RESUMPTION_EVERY_MINUTE` | `false` | `true` = every minute (heavier) |
| `DEFER_STARTUP_HEAVY_MS` | `45000` | Delay flow prewarm + NLP on API boot |

---

## Health check

`GET /api/health` returns:

- `mongoPool` — driver pool sizes / wait queue
- `mongoCronBudget` — active + queued cron slots
- `process` — `RUN_API`, `RUN_CRONS`, `RUN_WORKERS`, `CRON_USE_COORDINATOR`

Sign-off: `./scripts/start-api-dev.sh` + `GET /api/health` shows mongo pool and cron budget.
