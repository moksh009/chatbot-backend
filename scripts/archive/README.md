# Archived scripts

One-time migrations and client-specific ops live here. They are **not** run by the server or CI.

## When to use

- **migrations/** — historical DB/schema migrations (already applied in production). Run only if you know you need to replay on a fresh clone.
- **apex-ops/** — Apex / Delitech flow catalog tooling. Active setup script stays at `scripts/setupApexOwnerSupportFlow.js`.

## Active scripts (repo root `scripts/`)

- `probeBackendModules.js` — CI module load check (`npm run integration-probe`)
- `flowRegressionSmoke.js`, `templateEligibilitySmokePass.js`, `flowPreflightNodeGuardsSmoke.js`
- `setupApexOwnerSupportFlow.js` — tenant flow bootstrap
- `seedSuperAdmin.js` — initial admin seed (manual)
