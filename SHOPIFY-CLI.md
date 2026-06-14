# Shopify CLI (extensions deploy)

All Shopify app files live in **`shopify/`** inside this backend repo (committed to GitHub).

```
chatbot-backend-main/shopify/
├── shopify.app.toml       ← app config for Partners
├── package.json           ← npm run shopify:deploy
├── extensions/            ← CLI deploy target (edit via shopify-extensions/)
├── shopify-extensions/    ← source of truth for extension code
└── DEPLOY.md              ← full deploy guide
```

## Deploy (from backend repo root)

```bash
cd chatbot-backend-main
npm run shopify:login
npm run shopify:sync-extensions   # optional — copy source → extensions/
npm run shopify:deploy
npm run shopify:info
```

Or from the shopify folder directly:

```bash
cd chatbot-backend-main/shopify
npm install
npm run shopify:login
npm run shopify:deploy
```

## Release on Partners

After deploy shows **"created but not released"**:

1. Open the version in [Shopify Partners](https://partners.shopify.com)
2. Approve **network access** for checkout UI extensions (`api.topedgeai.com`)
3. Click **Release**

Production API server does **not** need these files — they publish to Shopify Partners only.
