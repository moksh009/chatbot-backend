# Load testing

Use [k6](https://k6.io/) for HTTP smoke and threshold checks.

```bash
# Install k6 (macOS: brew install k6)
cd chatbot-backend-main
BASE_URL=https://your-api.example.com npm run load-smoke:k6
```

The bundled script (`scripts/load/k6-smoke.js`) hits `/api/health` with a small VU count. Extend it with authenticated flows (JWT in headers) and multi-tenant scenarios as needed.

For deeper scenarios (login → campaigns → webhooks), combine k6 with backend integration scripts and Playwright E2E tests.
