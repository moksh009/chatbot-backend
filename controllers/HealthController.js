const mongoose = require('mongoose');
const NlpEngineService = require('../services/NlpEngineService');

/**
 * HealthController
 * Performs deep monitoring of critical system dependencies.
 */
exports.checkHealth = async (req, res) => {
  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {}
  };

  try {
    // 1. Check MongoDB Connection
    const mongoState = mongoose.connection.readyState;
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    healthStatus.services.mongodb = mongoState === 1 ? 'connected' : 'disconnected';
    if (mongoState !== 1) healthStatus.status = 'unhealthy';

    // 2. Check Redis Connection (Sliding Window Engine)
    if (global.redisClient) {
      try {
        const ping = await global.redisClient.ping();
        healthStatus.services.redis = ping === 'PONG' ? 'connected' : 'degraded';
        if (ping !== 'PONG') healthStatus.status = 'unhealthy';
      } catch (err) {
        healthStatus.services.redis = 'disconnected';
        healthStatus.status = 'unhealthy';
      }
    } else {
      healthStatus.services.redis = 'not_configured';
      // If redis is required for the sliding window but missing, mark as unhealthy
      healthStatus.status = 'unhealthy';
    }

    // 3. Check NLP Engine (Brain Readiness)
    const nlpStatus = NlpEngineService.getEngineStatus();
    healthStatus.services.nlp = nlpStatus.activeClients > 0 ? 'ready' : 'uninitialized';
    healthStatus.services.nlpDetails = nlpStatus;

    // 4. Determine Response Code
    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;

    res.status(statusCode).json(healthStatus);
  } catch (error) {
    console.error('[HealthCheck] Critical Failure:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal monitoring failure',
      error: error.message
    });
  }
};
