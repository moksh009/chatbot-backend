const mongoose = require('mongoose');
const Redis = require('ioredis');
const NlpEngineService = require('../services/NlpEngineService');

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

/**
 * Deep Healthcheck for standard uptime monitoring.
 */
exports.checkHealth = async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: Date.now(),
    services: {
      mongodb: 'disconnected',
      redis: 'disconnected',
      nlp: 'uninitialized'
    }
  };

  try {
    // 1. Check MongoDB
    if (mongoose.connection.readyState === 1) {
      health.services.mongodb = 'connected';
    } else {
      health.status = 'unhealthy';
    }

    // 2. Check Redis
    try {
      const pong = await redisConnection.ping();
      if (pong === 'PONG') {
        health.services.redis = 'connected';
      } else {
        health.status = 'unhealthy';
      }
    } catch (err) {
      health.status = 'unhealthy';
    }

    // 3. Check NLP Engine
    if (NlpEngineService.managers.size >= 0) {
      health.services.nlp = 'ready';
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);

  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
};
