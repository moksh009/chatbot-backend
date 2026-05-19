# Archived scripts

One-time migrations and client-specific ops live here. They are **not** run by the server or CI.

## When to use

- **migrations/** — historical DB/schema migrations (already applied in production). Run only if you know you need to replay on a fresh clone.
- **apex-ops/** — Apex / Delitech flow catalog tooling. Active setup script stays at `scripts/setupApexOwnerSupportFlow.js`.

## Active scripts (repo root `scripts/`)

See [`../README.md`](../README.md). Highlights:

- `runSystemAudit.js` — inventory → `docs/SYSTEM_AUDIT_REPORT.md`
- `verifyPerfHotpaths.js` — HTTP timing on hot dashboard routes
- `probeBackendModules.js` — CI (`npm run integration-probe`)
- `start-api-dev.sh`, `start-crons-only.sh` — split API vs crons

Do **not** move start scripts or CI smokes here without updating `package.json` and docs.
