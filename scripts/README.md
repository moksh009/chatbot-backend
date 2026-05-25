# Backend scripts index

## Daily dev

| Script | Purpose |
|--------|---------|
| `start-api-dev.sh` | API only — **use for dashboard/UI work** (`RUN_CRONS=false`) |
| `start-crons-only.sh` | Crons/workers only — no HTTP |

## Smoke / diagnostics

| Script | Purpose |
|--------|---------|
| `verifyPerfHotpaths.js` | HTTP timing on bootstrap, catalog, templates, etc. (needs API + `.env`) |
| `verifyLiveChat4A.js` | Live Chat conversation list bench |
| `verifyIndexes.js` | Critical Mongo indexes |

## Maintenance & CI

| Script | Purpose |
|--------|---------|
| `runSystemAudit.js` | Inventory → `docs/SYSTEM_AUDIT_REPORT.md` |
| `backfillDailyStatRollup.js` | Backfill `DailyStat` rollups (`--all --days=90`) |
| `benchmarkMongoPool.js` | Pool contention diagnostics |
| `probeBackendModules.js` | CI module load (`npm run integration-probe`) |
| `flowRegressionSmoke.js` | Flow regression (`npm run flow-regression`) |
| `templateEligibilitySmokePass.js` | Template eligibility smoke |
| `flowPreflightNodeGuardsSmoke.js` | Flow preflight guards |
| `auditUnusedFiles.js` | Recursive orphan scan via import graph (~250ms; scans `utils/{meta,shopify,flow,commerce,core}/`) |
| `auditClientSchema.js` | Client schema audit |

## One-time / manual

| Script | Purpose |
|--------|---------|
| `setupApexOwnerSupportFlow.js` | Apex tenant flow bootstrap |
| `seedSuperAdmin.js` | Initial super-admin seed |
| `seedNicheDefaults.js` | Niche default seed data |
| `phase9Migration.js` / `phase9MigrationLogic.js` | Legacy phase-9 migration (manual) |

## Archive

| Folder | Contents |
|--------|----------|
| [`archive/migrations/`](./archive/migrations/) | Historical DB migrations |
| [`archive/apex-ops/`](./archive/apex-ops/) | Apex / Delitech flow tooling |

Shared helpers: `_lib/signoffEnv.js` (used by smoke scripts if needed).

## CI (`package.json`)

```bash
npm run integration-probe
npm run flow-regression
npm run qa:ci
```
