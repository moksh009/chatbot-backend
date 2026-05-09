# SLOs and observability

## Targets (tune to your contract)

| Signal | Default env | Meaning |
|--------|-------------|---------|
| Authenticated JSON API latency | `SLO_P95_MS_AUTH_API` (default **500** ms) | Compare to `p95` from `/api/metrics/summary`. |

Uptime and error budgets should be defined per product (for example **99.9%** monthly API availability).

## Built-in measurement

- **`GET /api/metrics/summary`** — rolling in-process **P50/P90/P95/P99** and approximate **5xx rate**.  
  - In **production**, set **`METRICS_SECRET`** and send header **`X-Metrics-Secret: <value>`**.
  - In non-production, allowed without secret unless `METRICS_SECRET` is set.
- **`GET /api/health`** — dependency checks (MongoDB, Redis, NLP) plus embedded metrics snapshot and circuit breaker states.

## Recommended additions

- Ship logs as **JSON** to your host (Render, etc.) and alert on **5xx spikes** and **queue depth** if you add Redis queue metrics externally.
- Add **OpenTelemetry** or hosted APM when traffic grows — replace or complement in-process percentiles.

See also **`docs/load-testing.md`** for k6 smoke scripts.

## Environment variables

| Variable | Purpose |
|----------|-----------|
| `SLO_P95_MS_AUTH_API` | Documented comparison target for dashboards (default 500). |
| `METRICS_SECRET` | Protects `/api/metrics/summary` in production. |
| `ALERT_WEBHOOK_URL` | Optional Slack/Discord-style webhook for degraded `/api/health` (rate-limited). |
| `MONGODB_MAX_POOL_SIZE` | Upper bound for Mongo pool (default 10, clamped 2–50). |
| `REQUEST_LOG` | Set to `true` to log every HTTP line (default off in prod). |
