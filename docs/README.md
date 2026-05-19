# Backend documentation index

Start here for performance work, deploy, and audits. Work through [MASTER_SYSTEM_PLAN.md](./MASTER_SYSTEM_PLAN.md) one plan at a time (A → G).

## Core (Plans A–G)

| Doc | Purpose |
|-----|---------|
| [MASTER_SYSTEM_PLAN.md](./MASTER_SYSTEM_PLAN.md) | Master checklist — audit, API cache, crons, WhatsApp speed, frontend, hygiene, prod sign-off |
| [PERFORMANCE_ROADMAP.md](./PERFORMANCE_ROADMAP.md) | Phases 0–11 — what shipped (performance baseline) |
| [PRODUCTION_SIGNOFF.md](./PRODUCTION_SIGNOFF.md) | Plan G — pre-release checklist + `qa:ci` |
| [CRON_SCHEDULE.md](./CRON_SCHEDULE.md) | Cron tiers, coordinator bundles, env vars |
| [SYSTEM_AUDIT_REPORT.md](./SYSTEM_AUDIT_REPORT.md) | Auto-generated inventory — `node scripts/runSystemAudit.js` |

## Operations & QA

| Doc | Purpose |
|-----|---------|
| [staging-validation-checklist.md](./staging-validation-checklist.md) | Pre-prod staging checks |
| [template-lifecycle-qa-checklist.md](./template-lifecycle-qa-checklist.md) | Meta template lifecycle QA |
| [load-testing.md](./load-testing.md) | Load / soak testing notes |
| [slo-and-observability.md](./slo-and-observability.md) | SLOs, metrics, alerting |
| [deployment-cdn-nginx.md](./deployment-cdn-nginx.md) | CDN / nginx / static deploy |
| [runbooks/redis-mongo-queue.md](./runbooks/redis-mongo-queue.md) | Redis, Mongo pool, queue incidents |

## Product

| Doc | Purpose |
|-----|---------|
| [TOPEDGE_AI_USER_GUIDE.md](./TOPEDGE_AI_USER_GUIDE.md) | End-user / merchant guide |

## Related repos in this workspace

| Path | Doc |
|------|-----|
| `chatbot-dashboard-frontend-main/` | [../chatbot-dashboard-frontend-main/README.md](../chatbot-dashboard-frontend-main/README.md) |
| `chatbot-backend-main/scripts/` | [../scripts/README.md](../scripts/README.md) — smoke scripts & dev entrypoints |

## Quick commands

```bash
# API-only local dev (no crons — frees Mongo pool)
./scripts/start-api-dev.sh

# Regenerate audit report
node scripts/runSystemAudit.js

# HTTP hot-path timing (needs running API + .env)
node scripts/verifyPerfHotpaths.js

# Frontend production build
cd ../chatbot-dashboard-frontend-main && npm run build
```
