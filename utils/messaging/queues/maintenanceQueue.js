const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'dispatch-maintenance';
let queue;

function getMaintenanceQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: { removeOnComplete: 20, removeOnFail: 50 },
    });
  }
  return queue;
}

async function ensureMaintenanceRepeatable() {
  const q = getMaintenanceQueue();
  if (!q) return false;
  await q.add(
    'tick',
    {},
    {
      repeat: { every: 60000 },
      jobId: 'dispatch-maintenance-tick',
    }
  );
  return true;
}

module.exports = { QUEUE_NAME, getMaintenanceQueue, ensureMaintenanceRepeatable };
