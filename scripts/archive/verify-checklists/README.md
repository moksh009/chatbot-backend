# Archived performance / master-plan checklists

Static and HTTP sign-off scripts from Plans B–G and performance phases 3–11. They are **not** loaded by the API or CI.

## Run all

```bash
cd chatbot-backend-main
node scripts/verifyAllPhases.js
```

## Run one

```bash
node scripts/archive/verify-checklists/verifyPlanGChecklist.js
node scripts/archive/verify-checklists/verifyPlanGChecklist.js --run-qa
```

## Still at `scripts/` (orchestrators)

| Script | Role |
|--------|------|
| `verifyAllPhases.js` | Runs every checklist in this folder |
| `verifyPerfHotpaths.js` | HTTP timing on hot routes (needs API) |
| `verifyPhase4Checklist.js` | Phase 4 — live chat + signoff HTTP |
| `verifyPhase6Checklist.js` | Phase 6 — orders |
| `verifyLiveChat4A.js` | Phase 4A bench |
| `verifyIndexes.js` | Mongo index guard |
| `runSystemAudit.js` | Repo inventory → `docs/SYSTEM_AUDIT_REPORT.md` |
