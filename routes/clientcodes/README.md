# Client code modules (`routes/clientcodes/`)

These files are **kept for backward compatibility** — nothing here is deleted.

## Active wiring

| File | Used by | Purpose |
|------|---------|---------|
| `choice_salon_holi.js` | `dynamicClientRouter.js` → `POST /api/client/:id/webhook/flow-endpoint` | WhatsApp Flow callbacks when `businessType` is `choice_salon` / `choice_salon_new` |
| `topedgeai.js` | Same flow-endpoint | Agency demo flow + weekly cron nudge |
| `delitech_smarthomes.js` | `routes/admin.js` super-admin codegen | Client-specific code export only |

## WhatsApp inbound (all tenants)

`POST /api/client/:clientId/webhook` always uses **`engines/genericEcommerce.js`** → `dualBrainEngine`.  
Salon/turf handlers in this folder are **not** used for standard inbound messages.

## Deprecated / unmounted (preserved on disk)

| File | Notes |
|------|--------|
| `salon.js` | Legacy salon booking + consent |
| `choice_salon.js` | Superseded by `choice_salon_holi` for flows |
| `turf.js` | Was `/api/client/0001` — commented out in `index.js` |

## Env

- `ENABLE_LEGACY_FLOW_CLIENTCODES` — not implemented yet; flow-endpoint remains enabled by default.
