# Master system plan — audit, cleanup, speed (post Phases 0–11)

Work **one plan at a time**. Say **continue** to start the next plan after sign-off.

| Plan | Focus | Status |
|------|--------|--------|
| **A** | Inventory, log cleanup, script consolidation, audit report | **Done** |
| **B** | Backend API audit — cache/dedupe on every hot GET | **Done** |
| **C** | Cron & Mongo — coordinator, budgets, dev vs prod split | **Done** |
| **D** | WhatsApp chatbot — inbound path &lt;3s (greeting, queue, AI budget) | **Done** |
| **E** | Frontend — dead imports, hub guards, shared React Query | **Done** |
| **F** | Repo hygiene — archive one-offs, trim `dist/`, docs index | **Done** |
| **G** | Production sign-off — split deploy, health, load smoke | **Done** |

---

## Golden rules (never break)

1. Phases 0–11: `clientCache`, `apiCache`, bootstrap cache, dashboard summary, DailyStat rollup, hub tab guards, split deploy (`start-api-dev.sh`).
2. **Local dev:** `./scripts/start-api-dev.sh` — not full `node index.js` with crons unless testing crons.
3. **Never delete** without grep + archive first; migrations stay in `scripts/archive/`.

---

## Plan A — Inventory & cleanup

- [x] `node scripts/runSystemAudit.js` → `docs/SYSTEM_AUDIT_REPORT.md`
- [x] Remove committed `*.log` artifacts from repo
- [x] `scripts/verifyAllPhases.js` — single entry for phase checklists
- [x] Move one-off Delitech fix scripts → `scripts/archive/apex-ops/`
- [x] Move signoff HTTP scripts → `scripts/archive/signoff/` (verifyPhase4/6 updated)

**Sign-off:** `node scripts/runSystemAudit.js` prints 0 critical issues; no `perf_*.log` in git status.

---

## Plan B — Backend API cache audit

- [x] `GET /templates/list` — `apiCache(60)`, `getCachedClient`, perf timer
- [x] `GET /knowledge`, `/knowledge/pending` — `apiCache`, `getCachedClient`, skip heavy `ensureClientForUser` on read
- [x] `GET /segments`, `/segments/:id/leads` — `apiCache`, parallel count+find, cap 200 leads
- [x] Fixed archived signoff scripts (`scripts/_lib/signoffEnv.js`) — `.env` + model paths
- [x] Extended `verifyPerfHotpaths.js` for templates, segments, knowledge

**Sign-off:** `node scripts/verifyPerfHotpaths.js` — all endpoints green; `node scripts/verifyAllPhases.js` — phase 5/6/8 signoff pass.

---

## Plan C — Cron & Mongo

- [x] `docs/CRON_SCHEDULE.md` — full schedule + env reference
- [x] `GET /api/health` — `process`, `mongoPool`, `mongoCronBudget`, split-deploy warnings
- [x] Boot warning when `RUN_API` + `RUN_CRONS` on same process (non-prod)
- [x] `start-api-dev.sh` / `start-crons-only.sh` hardened
- [x] `.env.example` — `CRON_USE_COORDINATOR`, pool, bootstrap cache TTL
- [x] `scripts/verifyPlanCChecklist.js`

**Sign-off:** `node scripts/archive/verify-checklists/verifyPlanCChecklist.js` with API from `./scripts/start-api-dev.sh`

---

## Plan D — Chatbot speed

- [x] `INBOUND_QUEUE_FIRST_FLUSH_MS=0` (default in `.env.example` + `start-api-dev.sh`)
- [x] `message_saved_early` + socket emit before AI
- [x] Greeting fast path + `markRead` + instant fallback (`skipTranslation` / `skipConvoLookup`)
- [x] `getCachedClientForWhatsAppInbound` on webhook path (excludes `knowledgeBase`)
- [x] `getCachedClientForWhatsAppSend` on Live Chat send path
- [x] Flow graph from `flowGraphCache` via `loadPublishedFlowByRef`
- [x] `AI_CALL_TIMEOUT_MS` + `geminiBreaker` + `DUAL_BRAIN_BUDGET_MS` env
- [x] `scripts/verifyPlanDChecklist.js`

**Sign-off:** `node scripts/archive/verify-checklists/verifyPlanDChecklist.js` then WhatsApp "hi" &lt;3s with `./scripts/start-api-dev.sh` and `PERF_LOGGING=true`.

---

## Plan E — Frontend

- [x] `useTemplatesQuery` — TemplateManager, FlowBuilder (`flow`), Campaign (`campaign`), Settings notifications
- [x] FlowBuilder: removed 5s deferred `/templates/list`; pending poll uses `refetch()` + shared cache
- [x] CampaignManager: templates from React Query; `useHubTabActive` gates dashboard/deps fetch
- [x] Settings notifications: template health via shared query (no duplicate `api.get('/templates/list')`)
- [x] `dist/` in frontend `.gitignore`
- [x] `scripts/verifyPlanEChecklist.js`

**Sign-off:** `node scripts/archive/verify-checklists/verifyPlanEChecklist.js`

---

## Plan F — Archive & docs

- [x] `docs/README.md` — index (MASTER, ROADMAP, DEPLOY, CRON, audit, ops runbooks)
- [x] `scripts/README.md` — Plans A–F + phase 5–11 + CI/maintenance scripts
- [x] `scripts/archive/README.md` — points to active scripts table
- [x] `marketing-site/.gitignore` — `dist/`, `node_modules/`
- [x] `scripts/verifyPlanFChecklist.js`

**Sign-off:** `node scripts/archive/verify-checklists/verifyPlanFChecklist.js`

---

## Plan G — Production

- [x] `docs/PRODUCTION_SIGNOFF.md` — deploy, env, QA, manual smoke, rollback
- [x] Split deploy documented in `PHASE5_DEPLOY.md` + `start-api-dev.sh` / `start-crons-only.sh`
- [x] `npm run qa:ci` — backend + frontend (`package.json` in both repos)
- [x] `scripts/verifyPlanGChecklist.js` — static + optional `--run-qa` + health probe

**Sign-off:**

```bash
node scripts/archive/verify-checklists/verifyPlanGChecklist.js
node scripts/archive/verify-checklists/verifyPlanGChecklist.js --run-qa   # runs both qa:ci suites
```

---

## All plans complete (A–G)

Phases 0–11 optimizations remain the baseline. Use `./scripts/start-api-dev.sh` for local UI work.

---

## Quick commands

```bash
# Dev API only
./scripts/start-api-dev.sh

# Full audit
node scripts/runSystemAudit.js

# All phase checklists
node scripts/verifyAllPhases.js

# Perf hot paths
node scripts/verifyPerfHotpaths.js
```
