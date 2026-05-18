"use strict";

const log = require("./logger")("WebhookDedup");
const { getAppRedis } = require("./redisFactory");

const DEDUP_TTL_SEC = Number(process.env.WEBHOOK_DEDUP_TTL_SEC || 120);

/**
 * Atomic inbound dedup — call ONCE per webhook path (e.g. dynamicClientRouter only).
 * Do not call again in genericEcommerce; the Redis key is set on first claim.
 * @returns {Promise<boolean>} true if duplicate (should skip processing)
 */
async function isDuplicateInbound(messageId, clientId, phone = "unknown") {
  if (!messageId || !clientId) return false;

  const redis = getAppRedis();
  if (redis && redis.status === "ready") {
    const key = `dedup:${clientId}:${messageId}`;
    try {
      const result = await redis.set(key, "1", "EX", DEDUP_TTL_SEC, "NX");
      return result === null;
    } catch (err) {
      log.warn("[WebhookDedup] Redis SET NX failed:", err.message);
    }
  }

  const InboundDeduplication = require("../models/InboundDeduplication");
  try {
    await InboundDeduplication.create({ messageId, clientId, phone: phone || "unknown" });
    return false;
  } catch (err) {
    if (err.code === 11000) return true;
    throw err;
  }
}

module.exports = { isDuplicateInbound, DEDUP_TTL_SEC };
