"use strict";

const { Worker, Queue } = require('bullmq');
const Redis = require('ioredis');
const log = require('../utils/logger')('IGAutoWorker');
const { registerQueues } = require('../utils/igWebhookProcessor');

const isInternalRenderRedis = (process.env.REDIS_URL || '').includes('red-');
const isRunningOnRender = !!process.env.RENDER;

let redisConnection = null;
let commentDmQueue = null;
let commentReplyQueue = null;
let followGateQueue = null;
let storyDmQueue = null;

if (isInternalRenderRedis && !isRunningOnRender) {
  log.warn('[IGAutoWorker] ⚠️ Render-internal Redis detected locally. IG Automation workers are DISABLED.');
  log.info('[IGAutoWorker] Webhook processor will use inline fallback for job execution.');
} else if (process.env.REDIS_URL) {
  redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      if (times > 3) {
        log.error('[IGAutoWorker] Redis connection failed persistently. IG workers disabled.');
        return null;
      }
      return Math.min(times * 100, 3000);
    }
  });

  redisConnection.on('error', (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      log.warn('[IGAutoWorker] ⚠️ Redis unreachable. IG Automation workers are DISABLED.');
    }
  });

  // Initialize queues
  const queueOpts = { connection: redisConnection };
  commentDmQueue = new Queue('ig-comment-dm', queueOpts);
  commentReplyQueue = new Queue('ig-comment-reply', queueOpts);
  followGateQueue = new Queue('ig-follow-gate-check', queueOpts);
  storyDmQueue = new Queue('ig-story-dm', queueOpts);

  // Register queues with the webhook processor for enqueue operations
  registerQueues({ commentDmQueue, commentReplyQueue, followGateQueue, storyDmQueue });

  const workerOpts = {
    connection: redisConnection,
    concurrency: 5
  };

  // --- WORKERS ---

  const commentDmWorker = new Worker('ig-comment-dm', async (job) => {
    const { sendOpeningDM, handleViewContentPostback } = require('../controllers/igAutomation/messageDispatcher');
    const { automationId, commenterIgsid, clientId, action } = job.data;
    
    if (action === 'VIEW_CONTENT') {
      await handleViewContentPostback(automationId, commenterIgsid, clientId);
    } else {
      await sendOpeningDM(automationId, commenterIgsid, clientId);
    }
  }, workerOpts);

  const commentReplyWorker = new Worker('ig-comment-reply', async (job) => {
    const { canSendCommentReply } = require('../utils/igRateLimiter');
    const { automationId, commentId, clientId, mediaId } = job.data;

    // Pre-check rate limit at worker level — skip job early if blown
    const canReply = await canSendCommentReply(clientId, mediaId || 'unknown');
    if (!canReply) {
      log.warn(`[ig-comment-reply] Job ${job.id} skipped — rate limit reached for client=${clientId} post=${mediaId}`);
      return; // Job completes successfully (not a failure — intentional skip)
    }

    const { sendCommentReply } = require('../controllers/igAutomation/messageDispatcher');
    await sendCommentReply(automationId, commentId, clientId, mediaId);
  }, workerOpts);

  const followGateWorker = new Worker('ig-follow-gate-check', async (job) => {
    const { checkFollowStatus } = require('../controllers/igAutomation/messageDispatcher');
    const { automationId, igsid, clientId } = job.data;
    await checkFollowStatus(automationId, igsid, clientId);
  }, workerOpts);

  const storyDmWorker = new Worker('ig-story-dm', async (job) => {
    const { sendStoryDM } = require('../controllers/igAutomation/messageDispatcher');
    const { automationId, igsid, clientId } = job.data;
    await sendStoryDM(automationId, igsid, clientId);
  }, workerOpts);

  // Log worker lifecycle events
  [
    { worker: commentDmWorker, name: 'ig-comment-dm' },
    { worker: commentReplyWorker, name: 'ig-comment-reply' },
    { worker: followGateWorker, name: 'ig-follow-gate-check' },
    { worker: storyDmWorker, name: 'ig-story-dm' }
  ].forEach(({ worker, name }) => {
    worker.on('completed', (job) => {
      log.info(`[${name}] Job ${job.id} completed`);
    });
    worker.on('failed', (job, err) => {
      log.error(`[${name}] Job ${job.id} failed: ${err.message}`, {
        jobData: JSON.stringify(job.data).substring(0, 500),
        stack: err.stack
      });
    });
    worker.on('stalled', (jobId) => {
      log.warn(`[${name}] Job ${jobId} stalled — will be retried automatically`);
    });
  });

  log.info('[IGAutoWorker] ✅ All 4 IG Automation workers initialized');
} else {
  log.warn('[IGAutoWorker] No REDIS_URL configured. IG Automation workers are DISABLED.');
  log.info('[IGAutoWorker] Webhook processor will use inline fallback for job execution.');
}

module.exports = {
  commentDmQueue,
  commentReplyQueue,
  followGateQueue,
  storyDmQueue
};
