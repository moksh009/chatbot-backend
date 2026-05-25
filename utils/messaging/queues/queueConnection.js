const { getQueueRedis } = require('../../core/redisFactory');

function getConnection() {
  return getQueueRedis();
}

module.exports = { getConnection };
