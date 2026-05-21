# Enterprise Security Checklist — TopEdge Chatbot SaaS

Multi-tenant WhatsApp commerce platform. Use this as the **source of truth** for security reviews, onboarding new engineers, and production deploy gates.

**Legend:** ✅ Implemented in codebase · ⚠️ Partial / env-dependent · 📋 Planned / manual process

---

## 1. Tenant isolation (critical — one hacked account must not affect others)

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 1.1 | Every DB query scoped by `clientId` for non–super-admin | ⚠️ | Most routes use `req.user.clientId`; audit high-risk routes periodically |
| 1.2 | `tenantClientId()` — regular users cannot override tenant via query/body | ✅ | `utils/queryHelpers.js` |
| 1.3 | `assertTenantAccess` / `denyUnlessTenant` on `:clientId` routes | ✅ | Onboarding, flow publish, admin publish, leads import |
| 1.4 | `requireTenantMatch` on protected `/api/client/:clientId/*` routes | ✅ | `dynamicClientRouter` `secure` middleware chain |
| 1.5 | `verifyClientAccess` unified with tenant gate | ✅ | Settings, Shopify catalog |
| 1.6 | Block `body.clientId` / `query.clientId` spoofing after JWT auth | ✅ | Inside `protect` middleware |
| 1.7 | Frontend blocks cross-workspace API calls for non–super-admin | ✅ | `src/api/axios.js` request interceptor |
| 1.8 | Super-admin impersonation only via explicit `selectedClientId` + JWT role | ✅ | Dashboard AuthContext |
| 1.9 | Master tester cross-tenant bypass **disabled in production** by default | ✅ | `ALLOW_MASTER_TESTER_BYPASS=true` to re-enable |
| 1.10 | Separate MongoDB databases per tier (enterprise option) | 📋 | Single DB with logical isolation today |

---

## 2. Authentication & session

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 2.1 | JWT signed with strong `JWT_SECRET` (≥32 chars in prod) | ✅ | `requireJwtSecret()` on startup |
| 2.2 | JWT includes `clientId` + `role` in payload | ✅ | |
| 2.3 | Shorter token TTL (default **7d**, was 30d) | ✅ | `JWT_EXPIRES_IN` env |
| 2.4 | Auth brute-force rate limit (20 / 15 min) | ✅ | `authLimiter` |
| 2.5 | OTP rate limit (3 / hour per email) | ✅ | `routes/auth.js` |
| 2.6 | bcrypt password hashing | ✅ | |
| 2.7 | Strong password policy on change/register | ✅ | `passwordPolicy.js` |
| 2.8 | Failed login audit events | ✅ | `AUTH_LOGIN_FAILED` |
| 2.9 | MFA / TOTP for dashboard | 📋 | Recommended for super-admin |
| 2.10 | Refresh token rotation | 📋 | Single JWT today |
| 2.11 | Session revocation on password change | 📋 | |

---

## 3. API & network security

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 3.1 | Helmet security headers | ✅ | `index.js` |
| 3.2 | `express-mongo-sanitize` (NoSQL injection) | ✅ | |
| 3.3 | JSON body size limit (5mb) | ✅ | |
| 3.4 | General API rate limit per IP | ✅ | `API_RATE_LIMIT_MAX` |
| 3.5 | AI endpoint rate limit | ✅ | `aiLimiter` |
| 3.6 | Bulk/campaign rate limit | ✅ | `bulkLimiter` |
| 3.7 | Strict CORS when `ALLOWED_ORIGINS` or `CORS_STRICT=true` | ✅ | Set dashboard URL(s) in `ALLOWED_ORIGINS` on Render |
| 3.8 | Widget/embed CORS on customer domains | ⚠️ | Set `CORS_ALLOW_ALL=true` only if widgets break |
| 3.9 | HTTPS only in production | 📋 | Enforce at Render/CDN |
| 3.10 | HSTS at CDN | 📋 | |
| 3.11 | IP allowlist for super-admin | 📋 | |

---

## 4. Webhooks & third-party integrity

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 4.1 | Meta WhatsApp HMAC (`x-hub-signature-256`) | ✅ | `MetaAuthMiddleware` |
| 4.2 | Meta signature bypass **off in production** | ✅ | Needs `ALLOW_META_SIGNATURE_BYPASS=true` + non-strict |
| 4.3 | IG webhook raw body for HMAC | ✅ | Mounted before `express.json()` |
| 4.4 | Per-tenant webhook URLs `/api/client/:clientId/webhook` | ✅ | Tenant slug in path |
| 4.5 | Webhook verify token per client | ✅ | `dynamicClientRouter` |
| 4.6 | Inbound message deduplication | ✅ | `webhookDedup` |
| 4.7 | Shopify webhook HMAC verification | ⚠️ | Verify in `shopifyWebhook` routes |
| 4.8 | Razorpay webhook signature | ⚠️ | Verify in payment routes |

---

## 5. Secrets & data protection

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 5.1 | Credentials encrypted at rest on `Client` | ✅ | Application-level encryption |
| 5.2 | No secrets in git / `.env` in `.gitignore` | 📋 | Rotate if ever committed |
| 5.3 | Render/env inject secrets only | 📋 | Ops process |
| 5.4 | PII access audit (`logAction`) | ✅ | Leads export paths |
| 5.5 | Security audit log stream | ✅ | `[SecurityAudit]` logger |
| 5.6 | Optional Mongo audit persistence (90d TTL) | ✅ | `SECURITY_AUDIT_PERSIST=true` |
| 5.7 | Field-level encryption for tokens | ⚠️ | Client model encryption |
| 5.8 | KMS / Vault for encryption keys | 📋 | |

---

## 6. Application security (OWASP-aligned)

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 6.1 | IDOR prevention on tenant resources | ✅ | Layers in §1 |
| 6.2 | Input sanitization middleware | ✅ | `sanitizeMiddleware` on auth |
| 6.3 | Role-based access (`authorize`, `SUPER_ADMIN`) | ✅ | |
| 6.4 | CSRF protection for cookie-based auth | N/A | Bearer JWT in header |
| 6.5 | XSS — React escaping + CSP at CDN | ⚠️ | CSP disabled in Helmet for SPA |
| 6.6 | SSRF guards on outbound fetch | 📋 | Review AI/media fetchers |
| 6.7 | Dependency scanning (`npm audit`) | 📋 | CI weekly |
| 6.8 | SAST in CI | 📋 | |
| 6.9 | Penetration test before major launch | 📋 | |

---

## 7. Infrastructure & operations

| # | Control | Status | Notes |
|---|---------|--------|-------|
| 7.1 | `trust proxy` for accurate rate limits behind Render | ✅ | |
| 7.2 | Graceful shutdown (SIGTERM) | ✅ | |
| 7.3 | Health + metrics endpoints | ✅ | Protect metrics with `METRICS_SECRET` |
| 7.4 | Separate API / worker / cron processes | ✅ | `RUN_API`, `RUN_CRONS`, `RUN_WORKERS` |
| 7.5 | Mongo connection pool limits | ✅ | `.env.example` |
| 7.6 | Backups + restore drill | 📋 | MongoDB Atlas |
| 7.7 | Incident response runbook | 📋 | |
| 7.8 | WAF / DDoS at edge | 📋 | Cloudflare / Render |

---

## 8. Production environment variables

```bash
# Required
JWT_SECRET=<64+ random chars>
MONGODB_URI=...

# Security (recommended production)
NODE_ENV=production
CORS_STRICT=true
ALLOWED_ORIGINS=https://your-dashboard.com,https://app.topedge.ai
JWT_EXPIRES_IN=7d
SECURITY_AUDIT_PERSIST=true

# Do NOT enable in production unless explicitly needed
# ALLOW_MASTER_TESTER_BYPASS=true
# ALLOW_META_SIGNATURE_BYPASS=true
# CORS_ALLOW_ALL=true
```

---

## 9. Deploy verification (run after every security release)

1. Log in as **Tenant A** — confirm API calls with Tenant B `clientId` return **403**.
2. Log in as **Tenant B** — confirm flows, campaigns, settings only show B data.
3. Super-admin — confirm workspace switch works and audit logs show `targetClientId`.
4. Production — confirm `delitech2708@gmail.com` **cannot** access other tenants without `ALLOW_MASTER_TESTER_BYPASS`.
5. CORS — dashboard loads; widget domains still work (adjust `ALLOWED_ORIGINS` / `CORS_ALLOW_ALL`).
6. Webhook — send test Meta payload; unsigned requests rejected in production.
7. Review Render logs for `[SecurityAudit] TENANT_ACCESS_DENIED` spikes.

---

## 10. File reference (security code)

| File | Purpose |
|------|---------|
| `middleware/auth.js` | JWT, tenant match, body spoof block |
| `middleware/tenantSecurity.js` | Param/body tenant helpers |
| `middleware/securityAudit.js` | Structured audit logging |
| `middleware/productionSecurity.js` | Prod bypass gates |
| `middleware/enterpriseLimits.js` | API rate limits |
| `utils/queryHelpers.js` | `tenantClientId`, `assertTenantAccess` |
| `models/SecurityAuditLog.js` | Optional persisted audits |
| `docs/SECURITY_CHECKLIST.md` | This document |

---

## 11. Billing bypass (not security bypass)

VIP / Paytm / offline clients: see [ENTITLEMENTS.md](./ENTITLEMENTS.md) and `scripts/grantLifetimeAccess.js`.  
This unlocks **payment gates only** — tenant isolation rules in §1 still apply.

---

*Last updated: security hardening pass — multi-tenant isolation + audit + production CORS.*
