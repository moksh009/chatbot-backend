# Entitlements — full access without online payment

**Important:** This controls **billing / trial gates** only. **Tenant security isolation** is separate — Delitech cannot see Apex data even with lifetime access.

## Three ways to unlock the dashboard

| Method | Best for | What it does |
|--------|----------|----------------|
| **`Client.isLifetimeAdmin = true`** | Delitech, Apex, DFY VIP | Unlimited access, no trial lock (recommended) |
| **`billing.isPaidAccount = true`** | Paytm / bank transfer clients | Treated as paid without Razorpay webhook |
| **Long `trialEndsAt`** | Short extensions | Trial window only; weaker than lifetime |

Logic lives in `utils/accessFlags.js` → `computeAccessPayload()`.

## Recommended: VIP / offline Paytm clients

Run once per tenant (production Mongo required):

```bash
cd chatbot-backend-main
node scripts/grantLifetimeAccess.js delitech_smarthomes --note "DFY VIP — no Razorpay"
node scripts/grantLifetimeAccess.js <apex_clientId> --note "Apex Light — Paytm direct"
```

Optional: also flag the login user:

```bash
node scripts/grantLifetimeAccess.js delitech_smarthomes --grant-user
```

## Paytm / direct payment workflow (operations)

1. Customer pays you on Paytm (outside the app).
2. You record payment in your sheet (amount, month, `clientId`).
3. Run `grantLifetimeAccess.js` (or Super Admin sets flags — see below).
4. Client keeps using the dashboard; Razorpay subscription is **not** required.

To **pause** a churned offline client:

```bash
node scripts/grantLifetimeAccess.js <clientId> --revoke
```

Or set `suspendedAt` in Super Admin.

## Super Admin (UI) — `/admin/clients`

**Edit Client → Workspace access panel:**

- **Lifetime VIP** / **Paid account (Paytm)** toggles — save with Update Tenant
- **One-click VIP grant** — same as CLI script (subscription + 2099 trial)
- **Revoke VIP** / **Suspend** / **Unsuspend**
- **Payment source** + **Internal note** for offline billing

**Overview roster:** Access badge, **VIP grant** quick action, search.

See [ADMIN_DASHBOARD_CHECKLIST.md](./ADMIN_DASHBOARD_CHECKLIST.md).

## Security vs payment bypass

| Topic | Lifetime / paid flag | Master tester email |
|-------|----------------------|---------------------|
| Unlock dashboard | ✅ | ❌ (not for billing) |
| Cross-tenant API access | ❌ Never | ❌ Off in production |
| See another workspace data | ❌ | ❌ |

Do **not** use `ALLOW_MASTER_TESTER_BYPASS` for customers — use `grantLifetimeAccess` per `clientId`.

## Find a tenant `clientId`

- MongoDB: `clients` collection → field `clientId`
- Dashboard URL / bootstrap after login
- Examples: `delitech_smarthomes`, `shubhampatelsbusiness_1cfb2b` (Apex)
