'use strict';

const { getAppRedis } = require('../core/redisFactory');

const debounceTimers = new Map();
const DEBOUNCE_MS = 2000;

function scheduleWinningProductsCacheInvalidation(clientId) {
  if (!clientId) return;
  const key = String(clientId);
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(
    key,
    setTimeout(async () => {
      debounceTimers.delete(key);
      const redis = getAppRedis();
      if (!redis) return;
      try {
        for (const days of [7, 30, 90]) {
          await redis.del(`winning_products:${clientId}:${days}`);
        }
      } catch {
        /* ignore */
      }
    }, DEBOUNCE_MS)
  );
}

function emitPixelActivity(clientId, payload = {}) {
  if (!clientId) return;
  scheduleWinningProductsCacheInvalidation(clientId);
  if (!global.io) return;
  global.io.to(`client_${clientId}`).emit('pixel:activity', {
    clientId,
    eventName: payload.eventName || null,
    derived: Boolean(payload.derived),
    at: new Date().toISOString(),
  });
}

module.exports = {
  emitPixelActivity,
  scheduleWinningProductsCacheInvalidation,
};
