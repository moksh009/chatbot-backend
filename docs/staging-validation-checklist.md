# Staging Validation Checklist (`delitech_smarthomes`)

## Preconditions
- Latest backend deployed with updated `wizard`, `dualBrainEngine`, `flowGenerator`, and `triggerEngine`.
- Frontend deployed with updated `OnboardingWizard` sync fallback chain.
- WhatsApp credentials set for `delitech_smarthomes` (`wabaId`, token, phoneNumberId).
- Shopify credentials valid and readable.

## A. Runtime Reliability (must pass)
- Send `hi` on WhatsApp.
  - Expect response under 5s.
  - Expect welcome + interactive menu (list or buttons) to render.
- Click each main menu item:
  - `Products`
  - `Track Order`
  - `Returns`
  - `Warranty`
  - `Loyalty`
  - `Support`
  - `FAQ`
  - Each click must traverse to the correct branch (no fallback misroute).
- Send quick repeated messages (`hi`, `menu`, `hi`) within 10s.
  - No long lock stalls (~30s).
  - No session deadlock behavior.

## B. Template Pipeline (must pass)
- In wizard Template step, click `Refresh Status`.
  - No console spam.
  - Works with canonical sync route or fallback mode.
- Submit automation templates.
  - Duplicate submission should not hard-fail; should reconcile state.
- Submit product templates.
  - Duplicate submission should not hard-fail; should reconcile state.
- After Meta status change, run status sync again.
  - Approved templates should appear as approved.
  - Pending list should shrink.

## C. Form -> Flow Quality (must pass)
- Complete wizard launch.
- Open generated flow and verify:
  - Entry trigger and welcome nodes are connected.
  - Main menu node has valid IDs matching outgoing edges.
  - Product nodes include Buy/Agent/Menu routing.
  - Order branch includes status/cancel/refund nodes and edges.
  - Warranty, loyalty, support, FAQ, cart recovery, COD branch exist.
- Publish flow and test from WhatsApp end user side.

## D. Commerce Event Trigger Validation (must pass)
- Trigger Shopify events in staging:
  - order create -> `order_placed` flow path.
  - checkout update/create -> `abandoned_cart` path.
  - order fulfilled -> `order_fulfilled` path.
- Ensure flow start node executes and follow-up node chain runs.

## E. Smoke Metrics (observability checks)
- Track over 20 sample interactions:
  - p50 first response < 2s
  - p95 first response < 5s
  - interactive send success > 95%
  - incorrect edge route count = 0
  - template sync failures = 0 (or fallback route success logged)

## Go/No-Go
- Go only if all sections A-D pass and E thresholds are met.
- No-Go if any menu click misroutes, interactive payload fails to render, or template sync remains broken.
