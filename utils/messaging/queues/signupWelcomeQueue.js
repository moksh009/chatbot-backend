const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'signup-welcome';
let queue;

function getSignupWelcomeQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }
  return queue;
}

async function enqueueSignupWelcomeJob(payload) {
  const q = getSignupWelcomeQueue();
  if (!q) throw new Error('signup_welcome_queue_unavailable');
  const userId = String(payload?.userId || '');
  if (!userId) throw new Error('signup_welcome_user_id_required');
  return q.add('welcome-email', payload, {
    jobId: `signup-welcome:${userId}`,
  });
}

module.exports = {
  QUEUE_NAME,
  getSignupWelcomeQueue,
  enqueueSignupWelcomeJob,
};
