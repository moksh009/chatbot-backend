const mongoose = require('mongoose');
const NlpEngineService = require('../services/NlpEngineService');
const { summarize, verifyMetricsSecret } = require('../middleware/requestMetrics');
const { allStatuses } = require('../utils/circuitBreaker');
const { alertDegraded } = require('../utils/alerting');

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
    const mongoState = mongoose.connection.readyState;
    healthStatus.services.mongodb = mongoState === 1 ? 'connected' : 'disconnected';
    if (mongoState !== 1) healthStatus.status = 'unhealthy';

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
      healthStatus.status = 'unhealthy';
    }

    const nlpStatus = NlpEngineService.getEngineStatus();
    healthStatus.services.nlp = nlpStatus.activeClients > 0 ? 'ready' : 'uninitialized';
    healthStatus.services.nlpDetails = nlpStatus;

    healthStatus.metrics = summarize();
    healthStatus.circuits = allStatuses();
    healthStatus.process = {
      RUN_API: process.env.RUN_API !== 'false',
      RUN_CRONS: process.env.RUN_CRONS !== 'false',
      RUN_WORKERS: process.env.RUN_WORKERS !== 'false',
      CRON_USE_COORDINATOR: process.env.CRON_USE_COORDINATOR !== 'false',
    };
    try {
      const { getMongoCronBudgetStats } = require('../utils/mongoCronBudget');
      healthStatus.mongoCronBudget = getMongoCronBudgetStats();
    } catch (_) {}
    try {
      const { getMongoPoolStats } = require('../utils/mongoPoolStats');
      healthStatus.mongoPool = getMongoPoolStats();
    } catch (_) {}

    const warnings = [];
    if (healthStatus.process.RUN_API && healthStatus.process.RUN_CRONS) {
      warnings.push(
        'RUN_API and RUN_CRONS are both enabled — use split deploy (start-api-dev.sh + start-crons-only.sh) for local dev'
      );
    }
    const waitQ = healthStatus.mongoPool?.waitQueueSize;
    if (typeof waitQ === 'number' && waitQ > 0) {
      warnings.push(`mongo_pool_wait_queue=${waitQ}`);
      if (healthStatus.status === 'healthy') healthStatus.status = 'degraded';
    }
    const cronQ = healthStatus.mongoCronBudget?.queued;
    if (typeof cronQ === 'number' && cronQ > 0) {
      warnings.push(`cron_mongo_budget_queued=${cronQ}`);
      if (healthStatus.status === 'healthy') healthStatus.status = 'degraded';
    }
    if (warnings.length) healthStatus.warnings = warnings;

    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;

    if (healthStatus.status !== 'healthy') {
      await alertDegraded('health_check_unhealthy', {
        services: healthStatus.services,
        statusCode
      });
    }

    res.status(statusCode).json(healthStatus);
  } catch (error) {
    console.error('[HealthCheck] Critical Failure:', error);
    await alertDegraded('health_check_exception', { message: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Internal monitoring failure',
      error: error.message
    });
  }
};

/**
 * GET /api/metrics/summary — lightweight SLO view (protect with METRICS_SECRET in production).
 */
exports.metricsSummary = async (req, res) => {
  if (!verifyMetricsSecret(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    ok: true,
    ...summarize(),
    circuits: allStatuses()
  });
};
