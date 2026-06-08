# Website Chat Widget (Settings) — coming soon (internal)

**Status:** Settings UI locked · PUT API gated  
**Last updated:** June 2026  
**Env flag:** `WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED` (default: `false`)

---

## What this feature is

Settings → **Chat widget** lets merchants configure the embeddable site widget:

- WhatsApp redirect vs guided Flow Builder mode
- Theme, launcher, greeting, position, auto-open
- Embed snippet + preview

Data: `Client.websiteChatWidget` (merged via `utils/core/websiteWidgetDefaults.js`).  
UI: `pages/settings/WebsiteChatWidgetSettings.jsx`.  
API: `GET/PUT /api/settings/:clientId/website-chat-widget`.

Public embed / lead capture may still use existing saved config via `routes/support.js` and `routes/publicGrowth.js` — this flag only gates **merchant editing** in Settings.

---

## Why it is paused

V1 focus: WhatsApp Cloud API + dashboard automations. Website widget polish and guided-flow embed need another QA pass before self-serve.

---

## What is disabled when `WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED=false`

| Layer | Behavior |
|-------|----------|
| Settings UI | “Coming soon” locked panel (no save / embed copy actions) |
| `PUT /api/settings/:clientId/website-chat-widget` | `503` + `WEBSITE_WIDGET_SETTINGS_DISABLED` |
| `GET .../website-chat-widget` | Still works (bootstrap / read-only) |

---

## How to re-enable

1. API env: `WEBSITE_CHAT_WIDGET_SETTINGS_ENABLED=true`
2. Frontend `src/config/featureRollout.js` → `websiteChatWidgetSettings: true`
3. QA: save config, copy embed, preview modes, guided flowId binding, opt-in lead creation

---

## Key files

| Area | Path |
|------|------|
| Feature flag | `utils/core/featureFlags.js` |
| Settings API | `routes/settings.js` |
| Defaults / merge | `utils/core/websiteWidgetDefaults.js` |
| Settings UI | `pages/settings/WebsiteChatWidgetSettings.jsx` |
| Preview component | `components/settings/WebsiteChatWidgetPreview.jsx` |
| Public embed | `routes/support.js`, `routes/publicGrowth.js` |
| Bootstrap bundle | `routes/admin.js` → `websiteWidgetBundle` on auth bootstrap |
