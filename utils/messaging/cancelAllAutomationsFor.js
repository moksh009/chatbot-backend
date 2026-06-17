const mongoose = require('mongoose');
const FollowUpSequence = require('../../models/FollowUpSequence');
const CampaignMessage = require('../../models/CampaignMessage');
const ScheduledMessage = require('../../models/ScheduledMessage');
const { getAppRedis, getQueueRedis } = require('../core/redisFactory');
const { writeAuditLog } = require('./writeAuditLog');
const { emitToClient } = require('../core/socket');
const log = require('../core/logger')('CancelAutomations');
const { nlpProcessJobId } = require('./queues/jobIdUtils');

function phoneVariants(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  if (!raw) return [];
  const set = new Set([raw, `+${raw}`]);
  if (raw.length === 10) set.add(`91${raw}`);
  if (raw.startsWith('91') && raw.length > 10) set.add(raw.slice(2));
  return [...set];
}

const CART_RECOVERY_TYPES = ['abandoned_cart', 'custom'];

const VALID_REASONS = new Set([
  'order_placed',
  'stop_keyword',
  'erasure_request',
  'agent_block',
  'unsubscribe_link',
]);

function normalizeCancelReason(reason) {
  const r = String(reason || 'stop_keyword');
  return VALID_REASONS.has(r) ? r : 'stop_keyword';
}

/** Map opt-out / compliance sources to cancelAllAutomationsFor reason enum. */
function mapOptOutSourceToCancelReason(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'whatsapp_block' || s === 'whatsapp_block_meta') return 'agent_block';
  if (s === 'admin_manual' || s === 'dashboard' || s === 'agent_manual') return 'agent_block';
  if (s === 'unsubscribe_link' || s === 'email_unsubscribe') return 'unsubscribe_link';
  if (s === 'erasure_request' || s === 'gdpr_erasure') return 'erasure_request';
  if (s === 'order_placed') return 'order_placed';
  if (VALID_REASONS.has(s)) return s;
  return 'stop_keyword';
}

function sequenceTypeFilter(reason) {
  if (reason === 'order_placed') return { type: { $in: CART_RECOVERY_TYPES } };
  return {};
}

async function skipPendingSequenceSteps({ clientId, leadId, phone, reason }, session = null) {
  const variants = phone ? phoneVariants(phone) : [];
  const opts = session ? { session } : {};
  const filter = { clientId, status: 'cancelled', 'steps.status': 'pending' };
  if (leadId) filter.leadId = leadId;
  else if (variants.length) filter.phone = { $in: variants };
  else return 0;

  const res = await FollowUpSequence.updateMany(
    filter,
    {
      $set: {
        'steps.$[s].status': 'skipped',
        'steps.$[s].errorLog': `cancelled:${reason}`,
      },
    },
    { arrayFilters: [{ 's.status': 'pending' }], ...opts }
  );
  return res.modifiedCount || 0;
}

async function applyMongoCancellations(
  { clientId, leadId = null, phone = null, reason = 'order_placed', channels = 'all' },
  session = null
) {
  const cancelReason = normalizeCancelReason(reason);
  const variants = phone ? phoneVariants(phone) : [];
  const channelList = channels === 'all' ? ['whatsapp', 'email', 'instagram'] : channels;
  const opts = session ? { session } : {};

  const seqFilter = { clientId, status: 'active', ...sequenceTypeFilter(cancelReason) };
  if (leadId) seqFilter.leadId = leadId;
  else if (variants.length) seqFilter.phone = { $in: variants };

  if (cancelReason === 'order_placed') {
    const recoverFilter = { ...seqFilter, 'steps.status': 'sent' };
    await FollowUpSequence.updateMany(
      recoverFilter,
      {
        $set: {
          'meta.recovered': true,
          'meta.recoveredAt': new Date(),
          'meta.recoveredReason': 'order_placed',
        },
      },
      opts
    );
  }

  const seqRes = await FollowUpSequence.updateMany(
    seqFilter,
    {
      $set: {
        status: 'cancelled',
        cancelledReason: cancelReason,
        cancelledAt: new Date(),
      },
    },
    opts
  );

  await skipPendingSequenceSteps({ clientId, leadId, phone, reason: cancelReason }, session);

  let campaignCancelled = 0;
  let scheduledCancelled = 0;

  if (variants.length) {
    const cmRes = await CampaignMessage.updateMany(
      {
        clientId,
        phone: { $in: variants },
        status: { $in: ['queued'] },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledReason: cancelReason,
          cancelledAt: new Date(),
        },
        $unset: { failedAt: 1, errorMessage: 1 },
      },
      opts
    );
    campaignCancelled = cmRes.modifiedCount || 0;

    const smRes = await ScheduledMessage.updateMany(
      {
        clientId,
        phone: { $in: variants },
        status: 'pending',
        ...(channelList.length < 3 ? { channel: { $in: channelList } } : {}),
      },
      { $set: { status: 'cancelled' } },
      opts
    );
    scheduledCancelled = smRes.modifiedCount || 0;
  }

  return {
    sequences: seqRes.modifiedCount || 0,
    campaignMessages: campaignCancelled,
    scheduledMessages: scheduledCancelled,
  };
}

function phoneInJobData(data, variant) {
  if (!data || typeof data !== 'object') return false;
  const fields = [data.phone, data.phoneNumber, data.customerPhone, data.to, data.recipientPhone];
  return fields.some((f) => {
    const d = String(f || '').replace(/\D/g, '');
    return d && (d === variant || d.endsWith(variant) || variant.endsWith(d));
  });
}

async function drainRedisKeysForContact(clientId, phone) {
  const variants = phoneVariants(phone);
  const redis = getAppRedis();
  let redisKeys = 0;
  if (!redis || !variants.length) return redisKeys;

  const pipe = redis.pipeline();
  for (const p of variants) {
    pipe.del(`cart_recovery:${clientId}:${p}:step1`);
    pipe.del(`cart_recovery:${clientId}:${p}:step2`);
    pipe.del(`cart_recovery:${clientId}:${p}:step3`);
    pipe.del(`nlp_buffer:${clientId}:${p}`);
  }
  try {
    const results = await pipe.exec();
    redisKeys += (results || []).filter((r) => r && r[1]).length;
  } catch (e) {
    log.warn(`Redis pipeline cleanup failed: ${e.message}`);
  }

  for (const p of variants) {
    const patterns = [
      `cart_recovery:${clientId}:${p}:*`,
      `chat_buffer:${clientId}:${p}`,
    ];
    for (const pattern of patterns) {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = next;
          if (keys.length) {
            await redis.del(...keys);
            redisKeys += keys.length;
          }
        } while (cursor !== '0');
      } catch (e) {
        log.warn(`Redis scan failed for ${pattern}: ${e.message}`);
      }
    }
  }

  return redisKeys;
}

async function drainBullMqForContact(clientId, phone) {
  const variants = phoneVariants(phone);
  const summary = { bullmqJobs: 0, nlpJobs: 0 };
  if (!clientId || !variants.length) return summary;

  const queueRedis = getQueueRedis();
  if (!queueRedis || queueRedis.status !== 'ready') return summary;

  try {
    const { Queue } = require('bullmq');
    const nlpQueue = new Queue('nlp-queue', { connection: queueRedis });
    for (const v of variants) {
      const jobId = nlpProcessJobId(clientId, v);
      try {
        const job = await nlpQueue.getJob(jobId);
        if (job) {
          await job.remove();
          summary.nlpJobs += 1;
        }
      } catch {
        /* ignore */
      }
    }
    await nlpQueue.close();
  } catch (e) {
    log.warn(`NLP queue drain failed: ${e.message}`);
  }

  try {
    const { Queue } = require('bullmq');
    const queue = new Queue('enterprise-tasks', { connection: queueRedis });
    const states = ['delayed', 'waiting', 'paused', 'prioritized'];
    let start = 0;
    const batch = 200;
    while (true) {
      const jobs = await queue.getJobs(states, start, start + batch - 1);
      if (!jobs.length) break;
      for (const job of jobs) {
        if (variants.some((v) => phoneInJobData(job.data, v))) {
          await job.remove();
          summary.bullmqJobs += 1;
        }
      }
      if (jobs.length < batch) break;
      start += batch;
    }
    await queue.close();
  } catch (e) {
    log.warn(`BullMQ drain failed: ${e.message}`);
  }

  return summary;
}

async function clearMessageBuffers(clientId, phone) {
  const variants = phoneVariants(phone);
  try {
    const MessageBufferService = require('../../services/MessageBufferService');
    for (const v of variants) {
      await MessageBufferService.clearBuffer(clientId, v);
    }
  } catch {
    /* optional */
  }
}

async function finishCancelSideEffects(
  { clientId, leadId, phone, reason, channels, actor },
  cancelled
) {
  const channelList = channels === 'all' ? ['whatsapp', 'email', 'instagram'] : channels;
  const redisKeys = phone ? await drainRedisKeysForContact(clientId, phone) : 0;
  const bull = phone ? await drainBullMqForContact(clientId, phone) : { bullmqJobs: 0, nlpJobs: 0 };
  if (phone) await clearMessageBuffers(clientId, phone);

  const cancelReason = normalizeCancelReason(reason);

  await writeAuditLog({
    clientId,
    action_type: cancelReason === 'unsubscribe_link' ? 'unsubscribe' : 'compliance_block',
    target_resource: leadId ? String(leadId) : phone || '',
    actor,
    payload: { reason: cancelReason, ...cancelled, channels: channelList, redisKeys, ...bull },
  }).catch(() => {});

  emitToClient(clientId, 'lead_automations_cancelled', {
    leadId: leadId ? String(leadId) : null,
    phone,
    reason: cancelReason,
    ...cancelled,
    redisKeys,
    ...bull,
  });

  return { redisKeys, ...bull };
}

async function cancelAllAutomationsFor(params) {
  const started = Date.now();
  const session = await mongoose.startSession();
  let cancelled = { sequences: 0, campaignMessages: 0, scheduledMessages: 0 };

  try {
    await session.withTransaction(async () => {
      cancelled = await applyMongoCancellations(params, session);
    });
  } catch (err) {
    log.warn(`Transaction cancel failed, falling back: ${err.message}`);
    cancelled = await applyMongoCancellations(params, null);
  } finally {
    session.endSession();
  }

  const sideEffects = await finishCancelSideEffects(params, cancelled);

  const ms = Date.now() - started;
  if (ms > 50) log.warn(`cancelAllAutomationsFor slow: ${ms}ms`);

  return {
    cancelled: {
      ...cancelled,
      redisKeys: sideEffects.redisKeys || 0,
      bullJobs: sideEffects.bullmqJobs || 0,
      nlpJobs: sideEffects.nlpJobs || 0,
    },
    durationMs: ms,
  };
}

module.exports = {
  cancelAllAutomationsFor,
  applyMongoCancellations,
  finishCancelSideEffects,
  phoneVariants,
  CART_RECOVERY_TYPES,
  normalizeCancelReason,
  mapOptOutSourceToCancelReason,
  VALID_REASONS,
};
