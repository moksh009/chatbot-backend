"use strict";

/**
 * Auto Template Queue Definitions & Redis Connection
 * Shared by autoTemplateWorker.js and routes/autoTemplates.js
 */
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const log = require('../utils/logger')('AutoTemplateQueues');

const isInternalRenderRedis = (process.env.REDIS_URL || '').includes('red-');
const isRunningOnRender = !!process.env.RENDER;

let redisConnection = null;
let generationQueue = null;
let submissionSchedulerQueue = null;
let batchSubmitterQueue = null;
let statusPollerQueue = null;

if (isInternalRenderRedis && !isRunningOnRender) {
  log.warn('[AutoTemplate] Render-internal Redis detected locally. Auto Template queues DISABLED.');
} else if (process.env.REDIS_URL) {
  redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      if (times > 3) {
        log.error('[AutoTemplate] Redis connection failed persistently. Queues disabled.');
        return null;
      }
      return Math.min(times * 100, 3000);
    }
  });

  redisConnection.on('error', (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      log.warn('[AutoTemplate] Redis unreachable. Queues DISABLED.');
    }
  });

  const queueOpts = { connection: redisConnection };
  generationQueue = new Queue('template-generation', queueOpts);
  submissionSchedulerQueue = new Queue('template-submission-scheduler', queueOpts);
  batchSubmitterQueue = new Queue('template-batch-submitter', queueOpts);
  statusPollerQueue = new Queue('template-status-poller', queueOpts);

  log.info('[AutoTemplate] All 4 queues initialized.');
} else {
  log.warn('[AutoTemplate] No REDIS_URL configured. Auto Template queues DISABLED.');
}

/**
 * Reschedule the submission scheduler for a client with a delay.
 * Removes any existing scheduled job first to prevent duplicates.
 */
async function rescheduleSubmissionCheck(clientId, delayMinutes) {
  if (!submissionSchedulerQueue) return;
  const jobId = `submission-scheduler-${clientId}`;
  try {
    const existingJob = await submissionSchedulerQueue.getJob(jobId);
    if (existingJob) await existingJob.remove();
  } catch (e) { /* job may not exist */ }

  await submissionSchedulerQueue.add(
    'check',
    { clientId },
    {
      delay: delayMinutes * 60 * 1000,
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60000 }
    }
  );
}

/**
 * Register the hourly status poller repeatable job (idempotent).
 */
async function registerStatusPoller() {
  if (!statusPollerQueue) return;
  try {
    const existingRepeatables = await statusPollerQueue.getRepeatableJobs();
    const alreadyExists = existingRepeatables.some(j => j.id === 'global-status-poll');
    if (!alreadyExists) {
      await statusPollerQueue.add(
        'poll',
        { type: 'poll_all_pending' },
        {
          repeat: { pattern: '0 * * * *' },
          jobId: 'global-status-poll',
          removeOnComplete: true
        }
      );
      log.info('[AutoTemplate] Hourly status poller registered.');
    }
  } catch (err) {
    log.error('[AutoTemplate] Failed to register status poller:', err.message);
  }
}

module.exports = {
  redisConnection,
  generationQueue,
  submissionSchedulerQueue,
  batchSubmitterQueue,
  statusPollerQueue,
  rescheduleSubmissionCheck,
  registerStatusPoller
};
