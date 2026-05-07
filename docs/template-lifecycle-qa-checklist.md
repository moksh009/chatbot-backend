# Template Lifecycle QA Checklist

## API checks
- `GET /api/auto-templates/readiness`
- `POST /api/auto-templates/migrate-legacy`
- `GET /api/auto-templates/status`
- `GET /api/auto-templates/drafts`
- `POST /api/auto-templates/start`
- `POST /api/auto-templates/retry/:templateId`
- `GET /api/templates/list?contextPurpose=campaign`
- `GET /api/templates/list?contextPurpose=sequence`
- `GET /api/templates/list?contextPurpose=flow`

## New user scenarios
- Missing WhatsApp connection blocks submission.
- Start generation creates required prebuilt templates.
- Product templates generate from active Shopify products.
- Readiness percent updates as approvals arrive.
- Campaign template picker only shows approved and purpose-eligible templates.
- Sequence playbook blocks launch when required WhatsApp templates are unavailable.
- Flow template node publish validation fails early on unapproved templates.

## Failure scenarios
- Meta token expired surfaces reconnect warning.
- Rejected template shows reason and allows edit/retry.
- Generation failure allows retry and status recovers.
- Pending templates prevent unsafe batch stacking.
- Quick send rejects template preflight mismatch before message queueing.
- Sequence enrollment returns per-step validation reasons for invalid templates.

## UI checks
- Drafts tab shows grouped sections:
  - Required prebuilt templates
  - Product templates
  - Needs action
  - Other templates
- Template Manager filters and badges reflect canonical statuses.
- Draft edit cancel closes correctly without reopening.
- Embedded template actions enforce plan/connection gates.
- Admin-only override clearly indicates "show all templates" risk.

## Core journey matrix
- Campaign journey: audience selection -> template selection -> variable map -> launch.
- Sequence journey: audience mode (lead/segment/imported) -> playbook -> launch.
- Flow journey: TemplateNode selection -> publish preflight -> runtime send sample.
- IG journey: connection health -> template-aware automation setup -> send sample.

## Telemetry and diagnostics
- Each template preflight failure should include:
  - `templateName`
  - `contextPurpose`
  - `missingVariables`
  - `requiredVariableCount`
- Campaign and sequence API responses should return actionable failure messages (no generic 500 copy for validation).
- Rejected template status should preserve `rejectionReason` and render it in template surfaces.
