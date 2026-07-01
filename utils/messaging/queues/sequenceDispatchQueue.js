const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');
const { sequenceStepJobId } = require('./jobIdUtils');

const QUEUE_NAME = 'sequence-dispatch';
let queue;

function getSequenceDispatchQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }
  return queue;
}

async function enqueueSequenceStepJob(payload, opts = {}) {
  const q = getSequenceDispatchQueue();
  if (!q) throw new Error('sequence_dispatch_queue_unavailable');
  const jobId = sequenceStepJobId(payload.sequenceId, payload.stepIdx);
  try {
    return await q.add('dispatch', payload, {
      jobId,
      delay: opts.delay || 0,
    });
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('already exists') || err?.name === 'JobIdAlreadyExistsError') {
      return null;
    }
    throw err;
  }
}

module.exports = {
  QUEUE_NAME,
  getSequenceDispatchQueue,
  enqueueSequenceStepJob,
};
