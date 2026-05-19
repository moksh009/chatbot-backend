# System audit report

Generated: 2026-05-19T08:30:33.482Z

## Summary

| Metric | Count |
|--------|------:|
| Route files | 77 |
| Cron modules | 24 |
| `apiCache(` in routes | 44 |
| `getCachedClient` refs | 69 |
| Dedupe/cache helpers | 33 |
| Active scripts | 32 |
| Log artifacts in tree | 0 |

## Environment (dev)

- **Use:** `./scripts/start-api-dev.sh` (`RUN_CRONS=false`, `RUN_WORKERS=false`)
- **Avoid:** `PERF_LOGGING=true node index.js` for UI testing — crons compete for Mongo pool

## Cron modules

- `cron/abTestCron.js`
- `cron/abTestWinner.js`
- `cron/abandonedCartScheduler.js`
- `cron/amazonSync.js`
- `cron/autoResolutionCron.js`
- `cron/autoResumeBotCron.js`
- `cron/birthdayCron.js`
- `cron/campaignSchedulerCron.js`
- `cron/checkoutLinkRecoveryCron.js`
- `cron/codConfirmationCron.js`
- `cron/cronBootstrap.js`
- `cron/cronCoordinator.js`
- `cron/csatCron.js`
- `cron/flowResumptionCron.js`
- `cron/followUpSequenceCron.js`
- `cron/igTokenRefresher.js`
- `cron/insightsCron.js`
- `cron/leadScoringCron.js`
- `cron/loyaltyCron.js`
- `cron/productSyncCron.js`
- `cron/reviewCollection.js`
- `cron/scheduledMessageCron.js`
- `cron/statCacheCron.js`
- `cron/templateStatusSyncCron.js`

## Route files

- `routes/admin.js`
- `routes/ai.js`
- `routes/analytics.js`
- `routes/audience.js`
- `routes/auth.js`
- `routes/autoTemplates.js`
- `routes/bi.js`
- `routes/billing.js`
- `routes/botQuality.js`
- `routes/business.js`
- `routes/campaigns.js`
- `routes/catalog.js`
- `routes/checkoutShortLink.js`
- `routes/conversations.js`
- `routes/dashboard.js`
- `routes/dataDeletion.js`
- `routes/dynamicClientRouter.js`
- `routes/ecommerce.js`
- `routes/emailWebhook.js`
- `routes/flow.js`
- `routes/growth.js`
- `routes/igAutomationRoutes.js`
- `routes/inboxRoutes.js`
- `routes/insights.js`
- `routes/instagramAutomation.js`
- `routes/intelligenceDna.js`
- `routes/intentWebhooks.js`
- `routes/intents.js`
- `routes/keywords.js`
- `routes/knowledge.js`
- `routes/leads.js`
- `routes/loyalty.js`
- `routes/masterWebhook.js`
- `routes/media.js`
- `routes/metaAds.js`
- `routes/metaTemplates.js`
- `routes/metaWorkspace.js`
- `routes/notifications.js`
- `routes/oauth.js`
- `routes/onboarding.js`
- `routes/onboardingV2.js`
- `routes/orders.js`
- `routes/payment.js`
- `routes/publicGrowth.js`
- `routes/publicWarranty.js`
- `routes/qrcodes.js`
- `routes/razorpayWebhook.js`
- `routes/reseller.js`
- `routes/routingRules.js`
- `routes/rules.js`
- `routes/scoring.js`
- `routes/segments.js`
- `routes/sequences.js`
- `routes/settings.js`
- `routes/shopify.js`
- `routes/shopifyCatalog.js`
- `routes/shopifyComplianceWebhooks.js`
- `routes/shopifyHub.js`
- `routes/shopifyOAuth.js`
- `routes/shopifyPixel.js`
- `routes/shopifyWebhook.js`
- `routes/storeEconomics.js`
- `routes/support.js`
- `routes/team.js`
- `routes/templateGate.js`
- `routes/templates.js`
- `routes/tracking.js`
- `routes/training.js`
- `routes/validation.js`
- `routes/variables.js`
- `routes/warranty.js`
- `routes/webhooks.js`
- `routes/whatsapp.js`
- `routes/whatsappFlows.js`
- `routes/whitelabel.js`
- `routes/wizard.js`
- `routes/workspace.js`

## Log / noise files (remove from git, already in .gitignore)

- _(none found)_

## npm scripts (CI)

- `npm run start`
- `npm run dev`
- `npm run flow-regression`
- `npm run integration-probe`
- `npm run smoke:template-eligibility`
- `npm run smoke:flow-preflight-guards`
- `npm run dry-run:review-pipeline`
- `npm run test:catalog-menu`
- `npm run test:settings-sync`
- `npm run qa:ci`
- `npm run load-smoke:k6`

## Active scripts (top-level)

- `scripts/auditClientSchema.js`
- `scripts/auditUnusedFiles.js`
- `scripts/backfillDailyStatRollup.js`
- `scripts/benchmarkMongoPool.js`
- `scripts/flowPreflightNodeGuardsSmoke.js`
- `scripts/flowRegressionSmoke.js`
- `scripts/phase9Migration.js`
- `scripts/phase9MigrationLogic.js`
- `scripts/probeBackendModules.js`
- `scripts/reviewPipelineDryRun.js`
- `scripts/runSystemAudit.js`
- `scripts/runtimeCommerceReliabilityCheck.js`
- `scripts/seedNicheDefaults.js`
- `scripts/seedSuperAdmin.js`
- `scripts/setupApexOwnerSupportFlow.js`
- `scripts/start-api-dev.sh`
- `scripts/start-crons-only.sh`
- `scripts/supportReplyDeliverySmoke.js`
- `scripts/templateEligibilitySmokePass.js`
- `scripts/verifyAllPhases.js`
- `scripts/verifyIndexes.js`
- `scripts/verifyLiveChat4A.js`
- `scripts/verifyPerfHotpaths.js`
- `scripts/verifyPhase10Checklist.js`
- `scripts/verifyPhase11Checklist.js`
- `scripts/verifyPhase3Rollup.js`
- `scripts/verifyPhase4Checklist.js`
- `scripts/verifyPhase5Checklist.js`
- `scripts/verifyPhase6Checklist.js`
- `scripts/verifyPhase8Checklist.js`
- `scripts/verifyPhase9Checklist.js`

## Performance verify scripts

- `verifyAllPhases.js` — runs phase 5–11 checklists
- `verifyPerfHotpaths.js` — bootstrap, catalog, wa-flows timing

## Plan B gaps (manual follow-up)

Routes to review for `apiCache` + perf timers on hot GETs:
- `routes/templates.js` — list/sync
- `routes/knowledge.js` — RAG queries
- `routes/segments.js` — segment leads
- `routes/settings.js` / heavy admin GETs

## Plan D — Chatbot env

```env
INBOUND_QUEUE_DEBOUNCE_MS=300
INBOUND_QUEUE_FIRST_FLUSH_MS=0
CLIENT_CACHE_TTL_SEC=30
BOOTSTRAP_CACHE_TTL_SEC=45
```
