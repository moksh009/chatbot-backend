# TopEdge performance roadmap (Phases 0–11)

**Golden rule:** Never remove or weaken Phases 0–5 (client cache, dashboard summary, DailyStat rollup, apiCache, debounce/abort, split deploy, cron budget).

| Phase | Focus | Status |
|-------|--------|--------|
| **0** | Debounce, AbortController, no cancel toasts | Done |
| **1** | `clientCache`, indexes, flow cron batching | Done |
| **2** | `GET /dashboard/summary`, single `useQuery` | Done |
| **3** | `DailyStat` rollup read path + crons | Done |
| **4** | Live Chat, Orders/Flow backend timers, inbound fast path | Done |
| **4A** | Live Chat FE — React Query inbox, parallel WA+IG, abort full-context | Done |
| **5** | Split deploy, pool budget, lazy filters, billing defer, health | Done |
| **6** | **Orders** — FE budgets + BE list/states fix | **Done** |
| **7** | **Flow Builder** — bootstrap, N+1 routes, polling | Done |
| **8** | **Analytics** + **WhatsApp greeting** fast path | **Done** |
| **8B** | **Chatbot refinement** — instant hi / read receipt / fallback welcome | **Done** |
| **9** | **Hub pages** — tab-active guards, lazy tabs | **Done** |
| **10** | **Leads + Templates** — React Query, facet counts | **Done** |
| **11** | **Settings + Campaign** — cache invalidation, lazy panels | **Done** |

**Pre-release smoke:** `npm run build` in `chatbot-dashboard-frontend-main`, `node scripts/verifyPerfHotpaths.js` (API running).


---

## Phase 0 — Request hygiene (frontend)

- [x] `isRequestCanceled` + no toast on aborted requests (`api/axios.js`)
- [x] Debounced dashboard filters (`EcommerceDashboard.jsx`)
- [x] `AbortController` on dashboard summary fetch


---

## Phase 1 — Client cache & indexes

- [x] `utils/clientCache.js` + `invalidateClientCache` on writes
- [x] `scripts/verifyIndexes.js` for critical Mongo indexes
- [x] Flow cron batching (reduced per-tick `Client.findOne` load)


---

## Phase 2 — Dashboard summary API

- [x] `GET /api/dashboard/summary` — single consolidated payload
- [x] `EcommerceDashboard.jsx` — one `useQuery` for first paint


---

## Phase 3 — DailyStat rollup

- [x] `getTimelineStatsFromRollup` when range ≥ `TIMELINE_ROLLUP_MIN_DAYS`
- [x] Rollup crons + `backfillDailyStatRollup.js`


---

## Phase 4 — Live Chat backend + inbound

- [x] `apiCache(30)` + `dedupeAsync` on conversation list & full-context
- [x] `getCachedClient` on hot conversation paths
- [x] `message_saved_early` before AI; greeting fast path (see 8B)


---

## Phase 4A — Live Chat (frontend)

### Frontend (`LiveChat.jsx`, `hooks/useLiveChatInbox.js`)
- [x] `useLiveChatInboxQuery` — parallel `GET /conversations` + `GET /inbox/conversations` (Instagram)
- [x] `keepPreviousData` on inbox list (no flash on refetch)
- [x] `useLiveChatTeamQuery` / `useLiveChatFiltersQuery` — 5 min staleTime
- [x] `AbortController` on `GET /conversations/:id/full-context` when switching leads
- [x] Billing usage still deferred 8s (unchanged)
- [x] DNA / catalog / smart-replies still on-demand (unchanged)

### Backend (already in Phase 4)
- [x] `apiCache(30)` on conversation list, `dedupeAsync` on list + full-context
- [x] `getCachedClient` on full-context + smart-replies + send path


---

## Phase 5 — Production hardening

- [x] Split deploy: `start-api-dev.sh` (`RUN_CRONS=false`) vs `start-crons-only.sh`
- [x] `GET /api/health` — `mongoPool`, cron budget, split-deploy warnings
- [x] Phase 5A: lazy order filter APIs; billing usage deferred 8s on Live Chat


Split deploy: run `./scripts/start-api-dev.sh` (API, `RUN_CRONS=false`) and `./scripts/start-crons-only.sh` (workers) as separate processes in production.

---

## Phase 6 — Orders

### Frontend (`Orders.jsx`)
- [x] Lazy product/state filter APIs (Phase 5A)
- [x] Debounce search 400ms
- [x] Remove duplicate mount `fetchOrders()` (useQuery only)
- [x] Defer lead metrics until `viewMode === 'Signals'` (`AbortController` + `isRequestCanceled`)
- [x] `staleTime: 60s` on main orders query + `signal` on fetch
- [x] Lazy-load `RTOAnalytics` / `RtoProtectionSuite` for Analytics view

### Backend
- [x] `getDistinctOrderStates` — aggregation scan
- [x] `getClientOrders` — cap 150 + `dedupeAsync`
- [x] Fix `GET /analytics/lead-intelligence` (`score` → `leadScore`)


---

## Phase 7 — Flow Builder

### Frontend
- [x] Parallel settings + lite flows when `clientId` known
- [x] Template poll only when PENDING templates exist
- [x] Lazy `OnboardingWizard` (`React.lazy` + `Suspense`)
- [x] Heatmap: initial fetch; **no HTTP poll when socket connected**; 15s poll only when disconnected

### Backend
- [x] N+1 fix: `unanswered-questions` + `intelligence/suggestions` (`flowIntelligenceAggregations.js`)
- [x] `GET /api/flow/` — lite metadata only + `X-Deprecated-Endpoint` (use `/flow/flows?lite=1` + `/graph`)
- [x] `apiCache` + perf timers on `/:flowId/summary`, `/:flowId/versions`, `GET /flow-observability`


---

## Phase 8 — Analytics + WhatsApp greeting

### Frontend (`Analytics.jsx`)
- [x] `GET /analytics/overview-bundle` for first paint (no `/conversations` list for counts)
- [x] Defer heatmap, bot-health, realtime, top-leads by 1.2s

### Backend
- [x] `utils/analyticsOverviewBundle.js` — bounded insights + counts
- [x] `GET /analytics/overview-bundle` — apiCache + dedupe
- [x] `/insights` uses bounded helper + cache
- [x] `receptionist-overview` appointments window + limit
- [x] `apiCache` on flow-heatmap, bot-health, agent-performance

### Phase 8B — Chatbot refinement (WhatsApp "hi")
- [x] `message_saved_early` before AI (Phase 4 — kept)
- [x] Broader greeting match (`isGreetingLikeText`, up to 48 chars)
- [x] `whatsapp.markRead()` on inbound while flow loads
- [x] Skip duplicate `saveInboundMessage` when already persisted
- [x] Instant fallback welcome text when no greeting flow matched
- [x] `INBOUND_QUEUE_FIRST_FLUSH_MS=0` for first message (Phase 4)

**Manual sign-off:**

---

## Phase 9 — Hub pages (Audience, Meta, Intelligence, Commerce)

### Frontend
- [x] `HubPage` supports `Component` (lazy) — tabs no longer mount all at once
- [x] `useHubTabActive()` + `useHubTabActiveEffect()` hook
- [x] Lazy tabs: `MetaManagerHub`, `IntelligenceHub`, `AudienceHub`, `CommerceHub`, `MarketingHub`
- [x] Tab-active fetch guards: `Leads`, `CartLeads`, `ReputationHub`, `LoyaltyHub`, `TemplateManager`, `MetaMessagesWorkspace`, `QualityAnalytics`, `TrainingInbox`, `IntentEngineTab`
- [x] Meta Messages: debounced socket refresh (600ms); poll only when tab active + job generating


---

## Phase 10 — Leads + Template Manager

### Frontend
- [x] `Leads.jsx` → `useQuery` + `placeholderData` (60s stale)
- [x] `hooks/useTemplatesQuery.js` shared cache key
- [x] `TemplateManager` uses `useTemplatesQuery` + `syncTemplatesFromMeta`

### Backend
- [x] `utils/leadsAnalyticsFacet.js` — single `$facet` (page + total + summary)
- [x] `GET /analytics/leads` uses facet helper + perf timer
- [x] `GET /leads/high-intent` — total uses base query (not cursor page)
- [x] `apiCache(45)` on high-intent


---

## Phase 11 — Settings + Campaign

### Frontend
- [x] Lazy settings panels (`React.lazy` + `Suspense`)
- [x] `useAutomationHealth` only on integrations/features tabs
- [x] Settings refetch on `clientId` change
- [x] Campaign audience estimate debounced 450ms

### Backend
- [x] `clearClientCache` + `invalidateBootstrapCache` on `PATCH /admin/my-settings`
- [x] `clearClientCache` on `PATCH /client/:id/config` + commerce automations
- [x] `apiCache(60)` campaign overview, `apiCache(30)` audience-estimate


---

## Deploy (all phases)

Use `./scripts/start-api-dev.sh` and `./scripts/start-crons-only.sh`; see `CRON_SCHEDULE.md` for env vars.
