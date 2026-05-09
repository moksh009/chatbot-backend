/**
 * Legacy export — application Redis singleton for locks, caching, IG dedupe.
 * Prefer require('./redisFactory').getAppRedis() in new code.
 */
const { getAppRedis } = require('./redisFactory');

const redisClient = getAppRedis();

if (redisClient) {
  redisClient.on('connect', () => {
    global.redisClient = redisClient;
  });
  global.redisClient = redisClient;
}

module.exports = redisClient;
