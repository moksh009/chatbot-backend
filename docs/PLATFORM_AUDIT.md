# Platform audit — e-commerce end-to-end (no deletions)

Last updated: 2026-05-23. This document inventories how the system works and what was **wired/fixed** without removing files.

## Architecture (happy path)

```
Shopify webhooks → shopifyWebhook → orderEventDispatcher + commerceAutomationService
WhatsApp inbound → dynamicClientRouter → genericEcommerce → dualBrainEngine
Delayed sends    → ScheduledMessage → scheduledMessageCron (2 min bundle)
Sequences        → FollowUpSequence → followUpSequenceCron (5 min bundle)
Campaigns        → Campaign QUEUED → campaignSchedulerCron (5 min bundle)
Cart recovery    → abandonedCartScheduler (5 min bundle)
Flows            → flowResumptionCron (2 min, separate timer)
```

## Critical fix applied

**ScheduledMessage schema mismatch** — `commerceAutomationService`, `skuTriggerService`, and `upsellEngine` wrote legacy fields (`scheduledFor`, `type`, `templateName`) that did not match the model. Delayed SKU/order automations could fail silently.

- **Fix:** `utils/scheduleOutboundMessage.js` adapter + `scheduledMessageCron` now loads clients by `clientId` string (populate was invalid).

## Legacy niche policy (env-gated, code retained)

| Variable | Default | Effect |
|----------|---------|--------|
| `BLOCK_LEGACY_NICHE_AUTOMATION` | `true` | Cancel/skip appointment reminder sequences; block enroll of `tmpl_appointment_reminder` |
| `ENABLE_LEGACY_APPOINTMENT_REMINDERS` | `false` | Allow `sendAppointmentReminder`, appointment campaigns |
| `HIDE_DEPRECATED_NICHE_TEMPLATES` | `false` | Hide deprecated templates in API; default shows with `deprecated: true` |
| `CRON_ENABLE_BIRTHDAY` | `false` | Birthday cron |
| `CRON_ENABLE_AB_TEST_LEGACY` | `false` | Hourly `abTestCron` (duplicates campaign AB logic) |

Config module: `config/ecommerceOnlyPolicy.js`

## Cron inventory

See `docs/CRON_SCHEDULE.md`. Split deploy:

- API: `RUN_CRONS=false` (`scripts/start-api-dev.sh`)
- Workers: `RUN_CRONS=true` (`scripts/start-crons-only.sh`)

## Frontend ↔ backend

| Item | Status |
|------|--------|
| Sidebar paths | All registered in `Dashboard.jsx` |
| `/live-chat` | Redirects → `/conversations` |
| `/loyalty-hub`, `/reputation-hub`, `/warranty-hub` | Redirect → `/audience-hub?tab=*` |
| Hub + legacy URLs | Both work (`/sequences`, `/marketing-hub`, etc.) |
| `MetaMessagesWorkspace.jsx` | Unused entry — kept |

## Duplicate-send risks (documented, not removed)

1. Abandoned cart cron + active recovery sequence — monitor `hasActiveSequence`
2. Master webhook + per-client webhook — use one Meta callback URL per WABA
3. `abTestCron` vs `campaignSchedulerCron` — legacy AB cron off by default

## Manual ops

```bash
# Cancel stray appointment sequences in Mongo
node scripts/cancel-legacy-sequences.js
```

## Phase 3 (future, no file deletes)

- Dedupe window for same phone + template within N minutes
- `GET /api/health` → `deprecatedRoutes`, cron flags
- Align `docsManifest.js` growth routes to `/audience-hub?tab=`
- Optional: `ENABLE_LEGACY_FLOW_CLIENTCODES` for flow-endpoint only
