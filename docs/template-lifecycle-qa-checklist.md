# Template Lifecycle QA Checklist

## API checks
- `GET /api/auto-templates/readiness`
- `POST /api/auto-templates/migrate-legacy`
- `GET /api/auto-templates/status`
- `GET /api/auto-templates/drafts`
- `POST /api/auto-templates/start`
- `POST /api/auto-templates/retry/:templateId`

## New user scenarios
- Missing WhatsApp connection blocks submission.
- Start generation creates required prebuilt templates.
- Product templates generate from active Shopify products.
- Readiness percent updates as approvals arrive.

## Failure scenarios
- Meta token expired surfaces reconnect warning.
- Rejected template shows reason and allows edit/retry.
- Generation failure allows retry and status recovers.
- Pending templates prevent unsafe batch stacking.

## UI checks
- Drafts tab shows grouped sections:
  - Required prebuilt templates
  - Product templates
  - Needs action
  - Other templates
- Template Manager filters and badges reflect canonical statuses.
- Draft edit cancel closes correctly without reopening.
- Embedded template actions enforce plan/connection gates.
