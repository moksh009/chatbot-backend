# Backend scripts index

## Daily dev

| Script | Purpose |
|--------|---------|
| `start-api-dev.sh` | API only — **use for dashboard/UI work** (`RUN_CRONS=false`) |
| `start-crons-only.sh` | Crons/workers only — no HTTP |

## Verification (one command)

| Script | What it runs |
|--------|----------------|
| `verifyAllPhases.js` | All checklists in [`archive/verify-checklists/`](./archive/verify-checklists/) |
| `verifyPerfHotpaths.js` | HTTP timing on bootstrap, catalog, templates, etc. (needs API) |

Individual Plan B–G and phase 5–11 checklists live under **`archive/verify-checklists/`** (see that folder’s README).

## Phase 4 / 6 orchestrators (stay at repo root)

| Script | Notes |
|--------|--------|
| `verifyPhase4Checklist.js` | Live chat + archived signoff HTTP |
| `verifyPhase6Checklist.js` | Orders sign-off |
| `verifyLiveChat4A.js` | Phase 4A conversation list bench |
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
| `auditUnusedFiles.js` | Orphan file scan (dev only) |
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
| [`archive/signoff/`](./archive/signoff/) | HTTP sign-off for phase 4 / 6 |
| [`archive/verify-checklists/`](./archive/verify-checklists/) | Plan B–G + phase 3–11 static checklists |

Shared helpers: `_lib/signoffEnv.js`.

## CI (`package.json`)

```bash
npm run integration-probe
npm run flow-regression
npm run qa:ci
```
