# Runbook: Redis, MongoDB, and queues

## Redis down or flaky

**Symptoms:** `/api/health` reports `redis` not connected; Socket.IO may fall back to single-node; BullMQ workers idle; IG automation inline fallback logs.

**Checks:**

1. Confirm `REDIS_URL` on the server matches your provider (Render internal URLs only work from Render).
2. From the app host, verify TCP reachability to Redis.
3. Restart the web/worker process after Redis recovery.

**Mitigations:** WhatsApp NLP path can bypass the message buffer when Redis is unavailable (direct NLP). IG automation runs jobs inline when workers cannot connect.

## MongoDB connection failures

**Symptoms:** `/api/health` shows MongoDB disconnected; API returns 5xx.

**Checks:**

1. `MONGODB_URI` correct and IP allowlist includes the app host.
2. Raise **`MONGODB_MAX_POOL_SIZE`** only after observing pool wait times in Atlas/host metrics (avoid guessing).

## Queue backlog

**Symptoms:** Campaign or enterprise tasks delayed; BullMQ jobs pile up.

**Checks:**

1. Worker process running (`TaskWorker`, `NlpWorker`, `igAutomationWorker`, `autoTemplateWorker`).
2. Redis memory and eviction policy.
3. Circuit breaker **`whatsapp_graph`** — if **open**, Meta Graph may be failing; fix upstream before scaling workers.
