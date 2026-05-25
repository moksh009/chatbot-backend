const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'campaign-dispatch';
let queue;

function getCampaignDispatchQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 1000,
        attempts: 1,
      },
    });
  }
  return queue;
}

async function enqueueCampaignMessageJob(payload, opts = {}) {
  const q = getCampaignDispatchQueue();
  if (!q) throw new Error('campaign_dispatch_queue_unavailable');
  const jobId = `cm:${payload.campaignMessageId}`;
  return q.add('dispatch', payload, {
    jobId,
    delay: opts.delay || 0,
    priority: opts.priority,
  });
}

async function bulkEnqueueCampaignJobs(jobs, opts = {}) {
  const q = getCampaignDispatchQueue();
  if (!q) throw new Error('campaign_dispatch_queue_unavailable');
  const chunk = 500;
  let added = 0;
  for (let i = 0; i < jobs.length; i += chunk) {
    const slice = jobs.slice(i, i + chunk);
    await q.addBulk(
      slice.map((payload) => ({
        name: 'dispatch',
        data: payload,
        opts: {
          jobId: `cm:${payload.campaignMessageId}`,
          delay: payload.delayMs ?? opts.delay ?? 0,
        },
      }))
    );
    added += slice.length;
  }
  return added;
}

async function removeWaitingJobsForCampaign(campaignId) {
  const q = getCampaignDispatchQueue();
  if (!q) return 0;
  let removed = 0;
  const states = ['delayed', 'waiting', 'paused'];
  for (const state of states) {
    const jobs = await q.getJobs(state, 0, 500);
    for (const job of jobs) {
      if (String(job.data?.campaignId) === String(campaignId)) {
        await job.remove();
        removed += 1;
      }
    }
  }
  return removed;
}

module.exports = {
  QUEUE_NAME,
  getCampaignDispatchQueue,
  enqueueCampaignMessageJob,
  bulkEnqueueCampaignJobs,
  removeWaitingJobsForCampaign,
};
