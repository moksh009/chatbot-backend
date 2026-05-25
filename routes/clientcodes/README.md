# Client code modules (`routes/clientcodes/`)

E-commerce platform — only **active** flow-endpoint handlers remain.

## Active wiring

| File | Used by | Purpose |
|------|---------|---------|
| `choice_salon_holi.js` | `dynamicClientRouter.js` → `POST /api/client/:id/webhook/flow-endpoint` | WhatsApp Flow callbacks when `businessType` is `choice_salon` / `choice_salon_new` |
| `topedgeai.js` | Same flow-endpoint | Agency demo flow + weekly cron nudge |

## WhatsApp inbound (all tenants)

`POST /api/client/:clientId/webhook` uses **`engines/genericEcommerce.js`** → `dualBrainEngine`.

## Removed (Phase 1 purge)

Legacy monolithic client files (`choice_salon.js`, `salon.js`, `delitech_smarthomes.js`) were deleted. Admin `POST /flow/convert-legacy/:clientId` returns **410 Gone**.

| File | Notes |
|------|--------|
| `turf.js` | Removed (legacy turf booking) |
