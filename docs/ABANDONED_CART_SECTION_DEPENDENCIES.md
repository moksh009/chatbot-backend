# Audience → Abandoned carts — dependency map

The **list UI** (`CartLeads.jsx`) was rebuilt. The **abandoned cart product feature** (cron, flows, Shopify webhooks) is unchanged.

## What was removed (UI only)

- Old `CartLeads` table (bulk select, “high intent” filter, manual “Send recovery”, email/sequence bulk bar)
- Dependency on `GET /api/leads/high-intent` for this screen

## What was kept (backend & other surfaces)

| Area | Path / symbol | Role |
|------|----------------|------|
| Abandoned cart cron | `cron/abandonedCartScheduler.js` | Sends 3-step WA recovery from `nicheData` delays |
| Flow engine | `utils/dualBrainEngine.js` (`abandoned_cart` node) | Flow Builder cart recovery |
| Shopify checkout webhook | `routes/shopifyWebhook.js` (`handleCheckout`) | Sets `cartSnapshot`, `cartStatus: abandoned` |
| Shopify pixel | `routes/shopifyPixel.js` | Pixel abandon / checkout events |
| Generic ecommerce | `routes/engines/genericEcommerce.js` | Cart snapshot, recovery on purchase |
| Lead model | `models/AdLead.js` | `cartStatus`, `cartAbandonedAt`, `recoveryStep`, `activityLog` |
| Manual recovery API | `POST /api/leads/:leadId/send-recovery` | Still used from Lead details / other tools |
| High-intent API | `GET /api/leads/high-intent` | **Orders → Signals**, campaigns, not this tab |
| Sequences / templates | `data/sequenceTemplates.js`, playbooks | Marketing automations |
| Bot settings | `BotSettings.jsx` niche `abandonedMsg*` | Message copy for cron |
| Wizard / features | `enableAbandonedCart`, `wizardMapper` | Onboarding toggles |
| Analytics | `analytics.js`, `DailyStat`, dashboard charts | `abandonedCartSent`, recovery stats |
| Store economics | `routes/storeEconomics.js` | Cart recovery KPIs |
| RTO / insights | `RTOAnalytics.jsx` | `abandoned-checkouts-summary` (Shopify API) |
| Campaigns | `routes/campaigns.js` | Segments with `cartStatus: abandoned` |
| Config link | `systemTemplateCatalog.js` | Links to `/cart-leads` (still valid route) |

## New API (this section only)

- `GET /api/abandoned-carts/workspace?preset=30d`  
- `GET /api/abandoned-carts/workspace?from=YYYY-MM-DD&to=YYYY-MM-DD`  

Reads **AdLead** + latest **Order** by phone. Does not replace cron or webhooks.

## Other sections that read similar data (not deleted)

| Section | Uses | Depends on CartLeads UI? |
|---------|------|---------------------------|
| **Orders → Signals** | `cartLeads` from leads API | No |
| **Analytics → Recovery** | `realtime.abandonedCarts` | No |
| **Ecommerce dashboard** | `abandonedCartSent` in timeline | No |
| **Marketing / Sequences** | Abandoned cart playbooks | No |
| **Flow Builder** | `abandoned_cart` trigger node | No |
| **Live Chat** | Template category labels | No |
| **Settings** | Preview / niche messages | No |

**Conclusion:** No other feature required the old Audience list component. Safe to replace UI only.

## Metrics definitions (workspace API)

| Metric | Logic |
|--------|--------|
| Total abandoned carts | Abandon events in date range (`cartAbandonedAt` / interaction window) with cart activity |
| Active abandoned | Not recovered (`cartStatus` not recovered/purchased, `isOrderPlaced` false) |
| Recoverable revenue | Sum cart value of active rows |
| Recovered carts | `recovered` / `purchased` / `isOrderPlaced` in range |
| Revenue recovered | Sum cart value of recovered |
| Recovered via WhatsApp | Recovered + `recoveryStep > 0` or `activityLog` cart_step_* |
| Revenue via WhatsApp | Sum cart value of WA-recovered |
| Avg abandoned value | Total value ÷ total abandons |

WhatsApp follow-up timing uses `nicheData.abandonedDelay1/2/3` (same as cron).
