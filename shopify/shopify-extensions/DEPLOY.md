# Deploy TopEdge Shopify extensions (multi-tenant)

## Architecture (how every merchant gets their own pixel)

| Layer | Runs on | How it is installed | Per-merchant ID |
|-------|---------|---------------------|-----------------|
| Theme script | Storefront + `/cart` | Auto-injected into `theme.liquid` via Admin API | `clientId` in script URL |
| App web pixel extension | Shopify Checkout + storefront | Auto-registered via `webPixelCreate` GraphQL | `settings.clientId` + `settings.apiBaseUrl` |

**Merchants never paste code in Customer events** in the normal flow. One-click install in TopEdge dashboard registers both layers for **that store only**.

The manual checkout snippet in the dashboard is a **fallback only** when `webPixelCreate` fails (e.g. extensions not deployed yet).

---

## One-time setup (TopEdge team)

### 1. Install Shopify CLI (no global install required)

From monorepo root:

```bash
cd "/Users/patelmoksh/LocalProjects/chatbot final/chatbot-backend-main"
npm install
```

Use `npx shopify` (or npm scripts below). Do **not** need `shopify` on PATH.

From **backend repo root**:

```bash
cd chatbot-backend-main
npm run shopify:login
npm run shopify:sync-extensions   # optional
npm run shopify:deploy
```

### 2. Log in to Partners

```bash
npm run shopify:login
```

Opens browser — log in with your Shopify Partners account that owns app **TopEdge Ai** (`client_id` in `shopify.app.toml`).

### 3. Deploy extensions (once per release)

```bash
npm run shopify:deploy
```

Publishes:
- `shopify-extensions/topedge-web-pixel` — checkout + storefront events
- `shopify-extensions/topedge-checkout-consent` — WhatsApp opt-in block
- `shopify-extensions/topedge-checkout-capture` — live cart capture UI

### 4. Approve network access (Checkout UI extensions)

After deploy, Shopify may require **network access approval** for checkout UI extensions in Partner Dashboard:

1. Partners → **TopEdge Ai** → **Extensions**
2. Open **topedge-checkout-capture** and **topedge-checkout-consent**
3. Approve **network access** (required to call `api.topedgeai.com`)

The **web pixel extension** (`topedge-web-pixel`) does not need this — it is what registers checkout events for all merchants via `webPixelCreate`.

### 5. Set production backend env

On `api.topedgeai.com`:

```bash
SHOPIFY_CHECKOUT_EXTENSION_DEPLOYED=true
BACKEND_URL=https://api.topedgeai.com
```

Ensure `SHOPIFY_SCOPES` includes: `read_pixels,write_pixels,read_customer_events,read_themes,write_themes`

### 5. Partner Dashboard checklist

- App **TopEdge Ai** → API access → scopes include pixel scopes above
- Request **Protected Customer Data** if checkout phone fields return null
- App installed on merchant stores (OAuth from TopEdge dashboard)

---

## Per-merchant activation (self-serve)

1. Merchant connects Shopify in **TopEdge → Settings → Connections**
2. **Commerce Hub → Website tracking → One-click install**
3. Backend automatically:
   - Injects theme script with **their** `clientId`
   - Calls `webPixelCreate` with `{ clientId, apiBaseUrl }` for **their** shop
4. Optional: Checkout Editor → add **TopEdge WhatsApp opt-in** block

---

## Verify deploy worked

```bash
npm run shopify:info
```

After merchant install, dashboard should show:
- Theme script ✓ (verified in theme.liquid)
- Checkout pixel ✓ (app web pixel registered)
- Network on checkout: `POST https://api.topedgeai.com/api/shopify-pixel/pixel/{clientId}/event`

---

## "New version created, but not released" — what it means

Your deploy **built successfully** (topedge-ai-10). Shopify holds the version until you complete:

1. **Partners** → [TopEdge Ai app](https://partners.shopify.com) → **Versions**
2. Open the pending version (e.g. `topedge-ai-10`)
3. For **topedge-checkout-capture** and **topedge-checkout-consent**:
   - Click **Request network access** (or approve if prompted)
   - Allow calls to `https://api.topedgeai.com`
4. Click **Release** on the version

Until released:
- **Web pixel** may not propagate to merchant checkouts
- **Real-time typing capture** (checkout UI extension) will not run

After release + merchant one-click install, checkout fires API calls **while typing** (300ms debounce) via the UI extension — no Continue button required.

| Capture layer | When it fires |
|---------------|---------------|
| Theme script | Storefront/cart — real-time on input |
| Web pixel | Checkout — on step submit (Continue) |
| Checkout UI extension | Checkout — **real-time while typing** email/phone |

---

## Third-party checkouts (Gokwik, Razorpay Magic, Shiprocket)

Native checkout extensions **do not run** on replaced checkouts. Use **Audience → Third-party checkout** webhooks instead.
