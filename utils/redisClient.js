const Redis = require('ioredis');
const log = require('./logger')('RedisClient');

let redisClient = null;

if (process.env.REDIS_URL || process.env.NODE_ENV !== 'production') {
    // Attempt to connect to Redis
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        retryStrategy: (times) => {
            if (times > 3) {
                log.warn('[Redis] Max retries reached, giving up.');
                return null;
            }
            return Math.min(times * 50, 2000);
        }
    });

    redisClient.on('error', (err) => {
        log.warn('[Redis] Connection error:', err.message);
    });

    redisClient.on('connect', () => {
        log.info('[Redis] Connected successfully.');
    });
}

module.exports = redisClient;
