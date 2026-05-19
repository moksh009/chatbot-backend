# Production sign-off (Plan G)

Use this checklist before promoting a release. Assumes Plans A–F are already merged.

## 1. Split processes (required)

| Service | `RUN_API` | `RUN_CRONS` | `RUN_WORKERS` |
|---------|-----------|-------------|---------------|
| **Web** | `true` | `false` | `false` |
| **Worker** | `false` | `true` | `true` |

See [PHASE5_DEPLOY.md](./PHASE5_DEPLOY.md) and [CRON_SCHEDULE.md](./CRON_SCHEDULE.md).

Local smoke:

```bash
# Terminal 1
./scripts/start-api-dev.sh

# Terminal 2 (optional)
./scripts/start-crons-only.sh
```

Verify: `curl -s http://localhost:5001/api/health | jq '.process,.mongoPool,.mongoCronBudget'`

Web dyno must show `RUN_CRONS: false`. Worker dyno must show `RUN_API: false`.

## 2. Environment (production)

Copy from [.env.example](../.env.example). Minimum:

- `MONGODB_URI`, `JWT_SECRET`
- `MONGODB_MAX_POOL_SIZE=25`, `MONGODB_WAIT_QUEUE_TIMEOUT_MS=12000`
- `CRON_USE_COORDINATOR=true`, `CRON_MONGO_CONCURRENCY=3`
- `INBOUND_QUEUE_FIRST_FLUSH_MS=0`, `AI_CALL_TIMEOUT_MS=5000`
- `BOOTSTRAP_CACHE_TTL_SEC=45`
- `PERF_LOGGING=true` (first week), `SLOW_REQUEST_MS=5000`

Do **not** run `RUN_API=true` and `RUN_CRONS=true` on the same web dyno in production.

## 3. CI / QA scripts

```bash
# Backend (from chatbot-backend-main/)
npm run qa:ci

# Frontend (from chatbot-dashboard-frontend-main/)
npm run qa:ci
```

Backend `qa:ci` runs: module probe, flow regression smoke, preflight guards, unit tests.

Frontend `qa:ci` runs: duplicate route check + production `vite build`.

## 4. Automated checklists

```bash
node scripts/archive/verify-checklists/verifyPlanGChecklist.js
node scripts/verifyAllPhases.js          # Plans F→B + phases 5–11
node scripts/verifyPerfHotpaths.js       # needs API + auth in .env
node scripts/runSystemAudit.js           # 0 critical issues
```

## 5. Manual smoke (15 min)

| Check | Pass criteria |
|-------|----------------|
| Login / bootstrap | No 429; dashboard loads &lt;3s cached |
| Live Chat | Send message; appears &lt;2s |
| WhatsApp inbound | Send "hi"; reply &lt;3s (`message_saved_early` in logs) |
| Orders / Catalog | List loads &lt;500ms warm |
| Campaign estimate | Debounced; no request storm |
| Crons | Worker logs show coordinator ticks; no pool queue warnings on web |

## 6. Rollup maintenance

After deploy or schema change:

```bash
node scripts/backfillDailyStatRollup.js --all --days=90
```

Confirm 30D dashboard uses `rollup_read_path` in perf logs.

## 7. Rollback

- Redeploy previous web + worker images together.
- `invalidateClientCache` / bootstrap cache clears on settings PUT — no manual Redis flush required for config-only rollback.
