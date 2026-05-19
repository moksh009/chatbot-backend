# Archived scripts

One-time migrations and client-specific ops live here. They are **not** run by the server or CI.

## When to use

- **migrations/** — historical DB/schema migrations (already applied in production). Run only if you know you need to replay on a fresh clone.
- **apex-ops/** — Apex / Delitech flow catalog tooling. Active setup script stays at `scripts/setupApexOwnerSupportFlow.js`.

## signoff/

HTTP sign-off helpers used by `verifyPhase4Checklist.js` and `verifyPhase6Checklist.js` (Phase 4–6 live chat / orders).

## verify-checklists/

Plan B–G and performance phase 3–11 static checklists. Run via `node scripts/verifyAllPhases.js` or directly from that folder (see [`verify-checklists/README.md`](./verify-checklists/README.md)).

## Active scripts (repo root `scripts/`)

See [`../README.md`](../README.md). Highlights:

- `runSystemAudit.js` — Plan A → `docs/SYSTEM_AUDIT_REPORT.md`
- `verifyAllPhases.js` — all archived checklists
- `verifyPerfHotpaths.js` — HTTP timing on hot dashboard routes
- `verifyPhase4Checklist.js`, `verifyPhase6Checklist.js` — phase orchestrators
- `probeBackendModules.js` — CI (`npm run integration-probe`)
- `start-api-dev.sh`, `start-crons-only.sh` — split API vs crons

Do **not** move start scripts or CI smokes here without updating `package.json` and docs.
