# 🚀 TopEdge AI: Comprehensive User Guide & Developer Manual

Welcome to the **TopEdge AI Production Ecosystem**. This guide covers the architecture, operational workflows, and administration of the platform, specifically tailored for the **Delitech Smart Homes** migration and production-hardened backend.

---

## 1. Core Architecture: The "Dual Brain" Engine

Our engine operates on a hybrid logic system that provides both reliability (visual flows) and intelligence (Gemini AI).

### Visual Flow Builder (Priority 1)
- **Node-Based Traversal**: The system follows defined paths (edges) based on user interaction (buttons/keywords).
- **Dynamic Variable Injection**: Every message is hydrated with real-time data using the `variableInjector` utility.
  - `{{name}}`: Customer's first name.
  - `{{buy_url_5mp}}`: UTM-tracked, lead-specific checkout link for the 5MP Doorbell.
  - `{{order_id}}`: Latest order number for the customer.
- **Node Actions**: Special nodes trigger side-effects like:
  - `ESCALATE_HUMAN`: Pauses the bot and alerts the dashboard.
  - `SEND_PURCHASE_LINK`: Delivers a personalized checkout link.
  - `CHECK_ORDER_STATUS`: Fetches real-time status from Shopify.

### Gemini AI Fallback (Priority 2)
- If no node or keyword matches, the **Gemini 1.5 Flash** model takes over.
- **Context-Aware**: The AI is fed the client's `nicheData` (products, FAQs, tone) to answer questions naturally.
- **Bargaining Logic**: If a user hesitates on price, the AI is authorized to offer a specific discount code (e.g., `OFF10`).

---

## 2. Production Hardening & Security

### AES-256 Token Encryption
- **At-Rest Protection**: All sensitive tokens (`shopifyAccessToken`, `whatsappToken`) are encrypted using AES-256-CBC before being saved to the database.
- **Self-Healing Auth**: If a 401 Unauthorized is detected, the `withShopifyRetry` wrapper automatically:
  1. Rotates credentials via Refresh Token.
  2. Falls back to Client Credentials if needed.
  3. Retries the operation up to 3 times before alerting the admin.

### Webhook Reliability
- **Immediate Acknowledgment**: Webhook handlers respond with `200 OK` as the first operation to prevent Meta/Shopify timeouts.
- **Persistent Nudges**: COD-to-Prepaid and Abandoned Cart nudges are now **database-driven**. Unlike transient `setTimeout` timers, these nudges survive server restarts and are executed by a persistent background worker.

---

## 3. Meta Template Studio

Manage your WhatsApp marketing directly from the dashboard with pro-grade analytics.

### Creation & Sync
- **Live Sync**: Click "Sync" to pull real-time template status (Approved/Pending/Rejected) from Meta.
- **AI Copywriter**: Use the integrated Gemini tool to generate high-converting message copies based on your goals.

### Performance Analytics
- **Read & Delivery Rates**: Real-time tracking of message status.
- **ROI Attribution**: Automatic calculation of revenue generated specifically from WhatsApp template campaigns.

---

## 4. Delitech Smart Homes Migration

The Delitech bot has been fully migrated from hardcoded logic to the visual Flow Builder.

### Key Flows
- **The product Tree**: 5MP vs 3MP vs 2MP comparison logic is now visual.
- **FAQ Support**: Installation guides and battery life questions are handled via a dedicated Support sub-flow.
- **Human Takeover**: Requests for "agent" or "help" trigger a high-priority alert on the dashboard with a direct `wa.me` chat link.

---

## 5. Developer Quick-Start

### Running the Migration
If you need to re-migrate or update the Delitech flow:
```bash
node scripts/migrateDelitechToFlow.js
```

### Encryption Key
Ensure `ENCRYPTION_KEY` is set in your `.env`. If missing, the system defaults to a secure internal key but will log a warning.

### Monitoring
Check `utils/logger.js` outputs for:
- `[ShopifyRotation]`: Auth events.
- `[DualBrain]`: Conversational logic events.
- `[SelfHealing]`: Automated recovery attempts.

---

> [!IMPORTANT]
> **Production Recommendation**: Regularly monitor the "Attention Required" tab in the Live Chat dashboard. While the AI is powerful, high-ticket sales often require a human touch to close.

> [!TIP]
> **Pro Tip**: Use the `LEAD_ID` variable in your Meta buttons to enable deep-link tracking. The system will automatically replace it with the lead's unique database ID.
