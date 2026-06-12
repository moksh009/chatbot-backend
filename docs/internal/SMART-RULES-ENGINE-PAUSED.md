# Smart Message Rules — paused (internal)

**Status:** Hidden in dashboard · API gated · inbound evaluation off  
**Last updated:** June 2026  
**Env flag:** `SMART_RULES_ENGINE_ENABLED` (default: `false`)

---

## What this feature is

**Smart message rules** (Automation Hub → “Smart message rules”, legacy route `/rules`) let merchants define keyword/condition triggers that run ordered actions before Flow Builder:

- Send text / template
- Add tag, pause bot, assign agent
- Optional passthrough to Flow Builder (`continueToFlowAfterActions`)

Data lives on `Client.automationRules` (array). UI: `RulesEngine.jsx`. API: `/api/rules/*`. Matcher: `utils/core/rulesEngine.js` via `services/keywordResolver.js`.

**Related but separate:** Automation Hub → “Who gets the chat” (`RoutingEngine`, `/routing`) uses routing rules — not gated by this flag.

---

## Why it is paused

V1 launch scope: reduce surface area and avoid smart-rules edge cases interfering with Flow Builder + keyword triggers. Code stays in repo; merchants do not see or hit live evaluation.

---

## What is disabled when `SMART_RULES_ENGINE_ENABLED=false`

| Layer | Behavior |
|-------|----------|
| `routes/rules.js` | All endpoints return `503` + `SMART_RULES_DISABLED` |
| `keywordResolver.findMatchingTrigger` | Skips `behaviorRules` / `automationRules` matching |
| `dualBrainEngine` PHASE 22 | No behavior-rule match → block skipped (keyword triggers + flows unchanged) |

**Not disabled:** `KeywordTrigger` collection (Settings keyword triggers), Flow Builder, order-message rules, commerce automations.

---

## Frontend visibility

- Sidebar “Rules” nav: `navHidden: true` (merchants); super-admin still sees link for QA.
- `AutomationHub.jsx`: “Smart message rules” tab filtered when `featureRollout.smartRulesEngine` is false.
- Legacy `/rules` route remains mounted; direct URL shows empty/blocked UI for merchants.

---

## How to re-enable (future work)

1. Set env on API service: `SMART_RULES_ENGINE_ENABLED=true`
2. Dashboard picks up the flag automatically via `GET /workspace/:clientId/connection-status` → `featureRollout.smartRulesEngine` (no frontend file edit required; optional local override in `featureRollout.js` for offline dev)
3. Sidebar `/automation-hub` is always visible — routing tab works when smart rules are off
4. QA checklist:
   - Create rule → save → toggle active
   - `/api/rules/test` with sample message
   - Inbound WhatsApp message matches rule action (send_message, pause_bot)
   - Rule with `continueToFlowAfterActions: true` still enters flow after actions
   - Confirm keyword triggers still work when rule does not match

---

## Key files

| Area | Path |
|------|------|
| Feature flag | `utils/core/featureFlags.js` |
| REST API | `routes/rules.js` |
| Matcher | `utils/core/rulesEngine.js` |
| Inbound hook | `services/keywordResolver.js`, `utils/commerce/dualBrainEngine.js` (~PHASE 22) |
| Schema | `models/Client.js` → `automationRules`, `behaviorRules` |
| Dashboard UI | `pages/RulesEngine.jsx`, `pages/AutomationHub.jsx` |
| Client preview | `utils/smartRuleMatch.js` |

---

## API contract (when enabled)

- `GET /api/rules/:clientId` — list rules
- `PUT /api/rules/:clientId` — replace rules array
- `PATCH /api/rules/:clientId/:ruleId/toggle` — toggle `isActive`
- `DELETE /api/rules/:clientId/:ruleId` — delete rule
- `POST /api/rules/test` — `{ clientId, message, simulateFirstMessage? }`

When disabled, all return:

```json
{
  "success": false,
  "code": "SMART_RULES_DISABLED",
  "message": "Smart message rules are temporarily disabled. See docs/internal/SMART-RULES-ENGINE-PAUSED.md"
}
```
