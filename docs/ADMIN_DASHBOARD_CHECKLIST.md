# Admin Dashboard — Master Checklist

Super Admin UI: `/admin/clients` (`SuperAdmin.jsx`).  
Backend: `/api/admin/*` (`routes/admin.js`).

**Legend:** ✅ Done · ⚠️ Partial · 📋 Planned

---

## A. Security (who can change what)

| # | Item | Status |
|---|------|--------|
| A1 | Only `SUPER_ADMIN` JWT can call admin routes | ✅ `protect` + `isSuperAdmin` |
| A2 | Entitlement API audited (`AuditLog` + `SecurityAudit`) | ✅ `POST /clients/:id/entitlements` |
| A3 | Confirm dialog before grant/revoke/suspend | ✅ Admin UI |
| A4 | Tenant isolation unchanged — admin edits **one** `clientId` | ✅ |
| A5 | No master-tester cross-tenant in production | ✅ See `SECURITY_CHECKLIST.md` |
| A6 | Rate limit / IP allowlist for admin | 📋 |

---

## B. Client roster (Overview tab)

| # | Item | Status |
|---|------|--------|
| B1 | List all active tenants | ✅ |
| B2 | Search by name / `clientId` | ✅ |
| B3 | Pagination (>100 clients) | ⚠️ API supports; UI limit 100 |
| B4 | Access status badge (VIP / Paid / Trial / Suspended) | ✅ |
| B5 | Plan quick-assign + Apply | ✅ |
| B6 | +14d trial, VIP grant, Reset wizard, Open workspace | ✅ |
| B7 | Stats: total, channels, trials, VIP count | ✅ |
| B8 | Export roster CSV | 📋 |

---

## C. Entitlements & billing (per client)

| # | Item | Status |
|---|------|--------|
| C1 | Lifetime VIP (`isLifetimeAdmin`) | ✅ UI + PUT + one-click grant |
| C2 | Paid offline (`isPaidAccount`, Paytm) | ✅ |
| C3 | Payment source + internal note | ✅ |
| C4 | Trial toggle + end date | ✅ |
| C5 | Suspend / unsuspend (`suspendedAt`) | ✅ |
| C6 | One-click VIP (same as `grantLifetimeAccess.js`) | ✅ `POST .../entitlements` |
| C7 | Revoke VIP | ✅ |
| C8 | Grant login user `isLifetimeAdmin` | ✅ `grantUserLifetime` on grant |
| C9 | Subscription row sync on grant | ✅ via `entitlements.js` |
| C10 | Razorpay subscription management in admin | 📋 |

**Docs:** [ENTITLEMENTS.md](./ENTITLEMENTS.md)

---

## D. Provision / Edit wizard (6 steps)

| # | Step | Fields | Save on PUT | Status |
|---|------|--------|-------------|--------|
| D1 | Identity | name, clientId, niche, plan, trial, admin email, **entitlements panel** | ✅ | ✅ |
| D2 | Meta | WhatsApp IDs, tokens | ✅ | ✅ |
| D3 | Store | Shopify / manual | ⚠️ partial | ⚠️ |
| D4 | AI | Gemini key, system prompt | ✅ (added) | ✅ |
| D5 | Payments | gateways, Razorpay, etc. | ✅ | ✅ |
| D6 | Review | submit | — | ✅ |
| D7 | Edit loads **full** client via `GET /clients/:id` | ✅ | ✅ |

---

## E. Per-client operations (row actions)

| # | Action | API | Status |
|---|--------|-----|--------|
| E1 | Edit configuration | `PUT /admin/clients/:id` | ✅ |
| E2 | Reset password | `PUT .../reset-password` | ✅ |
| E3 | Open workspace (impersonate view) | `selectedClientId` | ✅ |
| E4 | Bot Flow tab | FlowBuilder admin mode | ✅ |
| E5 | Soft delete | `DELETE /admin/clients/:id` | ✅ |
| E6 | Hard delete + data purge | 📋 | |
| E7 | Test WhatsApp / Shopify / Email | admin test routes | ⚠️ separate UI |

---

## F. Support & flows

| # | Item | Status |
|---|------|--------|
| F1 | Support inbox (reply, takeover, release) | ✅ |
| F2 | Flow publish for tenant | ✅ Bot Flow tab |
| F3 | Template / flow sync buttons | 📋 in overview |
| F4 | Audit log viewer in admin | 📋 `GET /audit-logs` exists |

---

## G. What happens when admin saves

1. **`PUT /admin/clients/:id`** — updates Mongo `Client` (+ billing subfields).
2. **`clearClientCache(clientId)`** — WhatsApp/bootstrap caches refresh.
3. **`AuditLog`** — `ADMIN_CLIENT_UPDATE` entry.
4. User’s next **`/auth/bootstrap`** — reads new `trialActive`, `isLifetimeAdmin`, etc.
5. **`computeAccessPayload`** — `dashboardLocked` / `hasPaidAccess` for that tenant only.

---

## H. Paytm / offline client workflow (operations)

1. Customer pays outside Razorpay.
2. Super Admin → **VIP grant** (roster or Edit → Entitlements).
3. Optional note: `Paytm Mar 2026 — ₹5000`.
4. Client dashboard unlocks immediately for **their** `clientId` only.
5. On churn → **Revoke VIP** or **Suspend**.

CLI equivalent: `node scripts/grantLifetimeAccess.js <clientId> --note "..."`

---

## I. Files reference

| File | Purpose |
|------|---------|
| `routes/admin.js` | Admin API |
| `utils/entitlements.js` | Grant/revoke logic |
| `scripts/grantLifetimeAccess.js` | CLI |
| `utils/accessFlags.js` | Dashboard gates |
| `SuperAdmin.jsx` | Admin UI |
| `AdminEntitlementsPanel.jsx` | Access controls |
| `adminAccessStatus.js` | Badge helpers |

---

*Update this checklist when adding admin features.*
