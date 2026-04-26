"use strict";

/**
 * Redis-backed rate limiter for Instagram comment replies.
 * Per-client per-post limit of 10 comment replies per hour.
 * Prevents Instagram from shadowbanning the client's account.
 */

const log = require('./logger')('IGRateLimiter');

const COMMENT_REPLY_LIMIT = 10;
const COMMENT_REPLY_WINDOW_SECONDS = 3600; // 1 hour

/**
 * Check if a comment reply can be sent for this client+post combination.
 * @param {string} clientId - The client identifier
 * @param {string} mediaId - The Instagram post/media ID
 * @returns {Promise<boolean>} true if within limit, false if exceeded
 */
async function canSendCommentReply(clientId, mediaId) {
  const redis = global.redisClient;
  if (!redis) {
    // If Redis is not available, fall through (log warning but allow)
    log.warn('[Rate Limiter] Redis unavailable — comment reply rate limit not enforced');
    return true;
  }

  const key = `ig_reply_limit:${clientId}:${mediaId}`;

  try {
    const current = await redis.get(key);
    const count = parseInt(current || '0', 10);

    if (count >= COMMENT_REPLY_LIMIT) {
      log.warn(`[Rate Limiter] Comment reply limit reached for client=${clientId} post=${mediaId} (${count}/${COMMENT_REPLY_LIMIT})`);
      return false;
    }

    return true;
  } catch (err) {
    log.error('[Rate Limiter] Error checking comment reply limit:', err.message);
    return true; // Fail open — allow the reply if we can't check
  }
}

/**
 * Increment the comment reply counter for this client+post combination.
 * Called after a successful comment reply is sent.
 * @param {string} clientId 
 * @param {string} mediaId 
 */
async function incrementCommentReplyCount(clientId, mediaId) {
  const redis = global.redisClient;
  if (!redis) return;

  const key = `ig_reply_limit:${clientId}:${mediaId}`;

  try {
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, COMMENT_REPLY_WINDOW_SECONDS);
    await pipeline.exec();
  } catch (err) {
    log.error('[Rate Limiter] Error incrementing comment reply count:', err.message);
  }
}

module.exports = {
  canSendCommentReply,
  incrementCommentReplyCount,
  COMMENT_REPLY_LIMIT,
  COMMENT_REPLY_WINDOW_SECONDS
};
