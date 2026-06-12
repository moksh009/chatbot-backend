const os = require('os');
const { Worker } = require('bullmq');
const FollowUpSequence = require('../models/FollowUpSequence');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const { sendEnvelope } = require('../utils/messaging/sendEnvelope');
const { intentFromTemplateCategory } = require('../utils/messaging/envelopeHelpers');
const { transitionSequenceStep } = require('../utils/messaging/transitions/sequenceStepTransition');
const { acquire, release } = require('../utils/messaging/concurrency/tenantConcurrencyGate');
const { startHeartbeat, stopHeartbeat } = require('../utils/messaging/concurrency/heartbeat');
const { classifyEnvelopeOutcome } = require('../utils/messaging/dispatch/dispatchOutcomeHandler');
const { enqueueSequenceStepJob } = require('../utils/messaging/queues/sequenceDispatchQueue');
const { getConnection } = require('../utils/messaging/queues/queueConnection');
const log = require('../utils/core/logger')('SequenceDispatchWorker');
const { emitToClient } = require('../utils/core/socket');

async function emitSequenceProgress(clientId, sequenceId) {
  try {
    const fresh = await FollowUpSequence.findById(sequenceId).select('status steps').lean();
    if (!fresh) return;
    const steps = fresh.steps || [];
    const sent = steps.filter((s) => s.status === 'sent').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const pending = steps.filter((s) =>
      ['pending', 'queued', 'processing', 'retrying'].includes(s.status)
    ).length;
    emitToClient(clientId, 'sequence:progress', {
      sequenceId: String(sequenceId),
      status: fresh.status,
      counts: { sent, failed, pending, total: steps.length },
    });
  } catch {
    /* optional realtime */
  }
}

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.PHASE3_SEQUENCE_CONCURRENCY || 100);

async function processSequenceDispatchJob(job) {
  const { sequenceId, stepIdx, clientId, channel = 'whatsapp' } = job.data;
  const seq = await FollowUpSequence.findById(sequenceId);
  if (!seq || seq.status !== 'active') return;
  const step = seq.steps?.[stepIdx];
  if (!step) return;

  const fromStatus = step.status === 'pending' ? 'pending' : step.status;
  if (!['queued', 'pending', 'retrying'].includes(fromStatus)) return;

  const client = await Client.findOne({ clientId }).lean();
  if (!client) return;

  const gate = await acquire({ client, clientId, channel });
  if (!gate.acquired) {
    await enqueueSequenceStepJob(job.data, { delay: (gate.retryAfter || 2) * 1000 });
    return;
  }

  let hbKey;
  try {
    const toProcessing = fromStatus === 'retrying' ? 'retrying' : fromStatus;
    await transitionSequenceStep(sequenceId, stepIdx, toProcessing, 'processing', {
      lockedBy: WORKER_ID,
      lockedAt: new Date(),
      attempts: (step.attempts || 0) + 1,
      lastAttemptAt: new Date(),
    });

    hbKey = startHeartbeat({ workerId: WORKER_ID, type: 'sequence_step', recordId: sequenceId, stepIdx });

    const lead = await AdLead.findById(seq.leadId).lean();
    let payload;
    let intent = 'marketing';
    if (step.templateName) {
      intent = intentFromTemplateCategory(step.templateCategory);
      payload = { templateName: step.templateName, templateLanguage: 'en', components: [] };
    } else if (step.type === 'email') {
      intent = 'marketing';
      payload = {
        subject: step.subject || 'Follow up',
        html: step.content || '',
      };
    } else {
      payload = { text: step.content || '' };
    }

    const result = await sendEnvelope({
      clientId,
      channel: step.type === 'email' ? 'email' : 'whatsapp',
      intent,
      contactId: lead?._id,
      contact: lead ? undefined : { phone: seq.phone },
      payload,
      idempotency: { key: `seq-step:${sequenceId}:${stepIdx}` },
      context: { source: 'workers/sequenceDispatchWorker', sequenceId: String(sequenceId) },
    });

    const outcome = classifyEnvelopeOutcome(result, (step.attempts || 0) + 1);
    if (outcome.action === 'sent') {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'sent', {
        sentAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      });
    } else if (outcome.action === 'retry') {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'retrying', {
        nextAttemptAt: new Date(Date.now() + outcome.delaySec * 1000),
        failureReason: outcome.reason,
      });
      await enqueueSequenceStepJob(job.data, { delay: outcome.delaySec * 1000 });
    } else {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: outcome.reason || 'failed',
        errorLog: outcome.reason,
      });
    }
  } catch (err) {
    log.warn(`Sequence job ${sequenceId}:${stepIdx}: ${err.message}`);
  } finally {
    if (hbKey) stopHeartbeat(hbKey);
    await release({ clientId, channel });
    await emitSequenceProgress(clientId, sequenceId);
  }
}

function startSequenceDispatchWorker() {
  const connection = getConnection();
  if (!connection) {
    log.warn('Redis unavailable — sequence dispatch worker disabled');
    return null;
  }
  const worker = new Worker('sequence-dispatch', processSequenceDispatchJob, {
    connection,
    concurrency: CONCURRENCY,
  });
  log.info(`Sequence dispatch worker started (concurrency=${CONCURRENCY})`);
  return worker;
}

module.exports = { startSequenceDispatchWorker };
