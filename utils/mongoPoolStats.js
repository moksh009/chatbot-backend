const mongoose = require('mongoose');

/**
 * Best-effort MongoDB driver pool snapshot for /api/health (Phase 5 observability).
 */
function getMongoPoolStats() {
  const configuredMax = Math.min(
    50,
    Math.max(5, parseInt(process.env.MONGODB_MAX_POOL_SIZE || '25', 10) || 25)
  );
  const waitQueueTimeoutMS = Math.min(
    30000,
    Math.max(5000, parseInt(process.env.MONGODB_WAIT_QUEUE_TIMEOUT_MS || '12000', 10) || 12000)
  );

  const base = {
    readyState: mongoose.connection.readyState,
    configuredMaxPoolSize: configuredMax,
    waitQueueTimeoutMS,
  };

  try {
    const client = mongoose.connection.getClient?.() || mongoose.connection.client;
    if (!client) return base;

    const topology = client.topology;
    const pool =
      topology?.s?.pool ||
      topology?.s?.servers?.values?.()?.next?.()?.value?.s?.pool;

    if (pool) {
      return {
        ...base,
        totalConnectionCount: pool.totalConnectionCount,
        availableConnectionCount: pool.availableConnectionCount,
        waitQueueSize: pool.waitQueueSize,
        checkedOutConnections: pool.checkedOutConnections,
      };
    }
  } catch (_) {
    /* driver internals vary by version */
  }

  return base;
}

module.exports = { getMongoPoolStats };
