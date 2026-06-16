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
const { mergeEmailForLead } = require('../utils/core/emailMergeFields');
const {
  WHATSAPP_CREDENTIAL_SELECT,
  EMAIL_CREDENTIAL_SELECT,
} = require('../utils/meta/clientWhatsAppCreds');
const { buildMappedBodyComponent } = require('../utils/meta/templateParams');
const log = require('../utils/core/logger')('SequenceDispatchWorker');
const { logDispatchEvent } = require('../utils/messaging/dispatchEventLog');
const { emitToClient } = require('../utils/core/socket');

async function emitSequenceProgress(clientId, sequenceId) {
  try {
    const fresh = await FollowUpSequence.findById(sequenceId).select('status steps').lean();
    if (!fresh) return;
    const steps = fresh.steps || [];
    const sent = steps.filter((s) => s.status === 'sent').length;
    const failed = steps.filter((s) => s.status === 'failed').length;
    const skipped = steps.filter((s) => s.status === 'skipped').length;
    const pending = steps.filter((s) =>
      ['pending', 'queued', 'processing', 'retrying'].includes(s.status)
    ).length;
    emitToClient(clientId, 'sequence:progress', {
      sequenceId: String(sequenceId),
      status: fresh.status,
      counts: { sent, failed, skipped, pending, total: steps.length },
    });
  } catch {
    /* optional realtime */
  }
}

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.PHASE3_SEQUENCE_CONCURRENCY || 100);

function resolveStepChannel(step) {
  return String(step?.type || 'whatsapp').toLowerCase() === 'email' ? 'email' : 'whatsapp';
}

function normalizePhone(lead, seq) {
  return String(lead?.phoneNumber || seq?.phone || '').replace(/\D/g, '');
}

function normalizeEmail(lead, seq) {
  return String(lead?.email || seq?.email || '')
    .trim()
    .toLowerCase();
}

function inferDefaultVariableMapping(templateComponents) {
  const body = (templateComponents || []).find((c) => String(c?.type || '').toUpperCase() === 'BODY');
  const matches = (body?.text || '').match(/\{\{(\d+)\}\}/g) || [];
  if (!matches.length) return {};
  const indices = [...new Set(matches.map((m) => m.match(/\d+/)[0]))].sort(
    (a, b) => Number(a) - Number(b)
  );
  const mapping = {};
  for (const idx of indices) {
    mapping[idx] = idx === '1' ? 'name' : 'customText';
  }
  return mapping;
}

async function buildSequenceWhatsAppPayload({ client, clientId, step, lead, seq }) {
  const templateName = step.templateName;
  const row = {
    name: lead?.name || seq?.name || 'Customer',
    customerName: lead?.name || seq?.name || 'Customer',
    phone: lead?.phoneNumber || seq?.phone,
    email: lead?.email || seq?.email,
    tags: lead?.tags,
    totalSpent: lead?.totalSpent,
    lastPurchaseDate: lead?.lastPurchaseDate,
    capturedData: lead?.capturedData,
  };

  let variableMapping =
    step.variableMapping && typeof step.variableMapping === 'object' ? { ...step.variableMapping } : {};

  const { resolveTemplateForSend } = require('../services/templateResolver');
  const resolved = await resolveTemplateForSend(clientId, { name: templateName });
  const tpl = resolved?.template;

  if (!Object.keys(variableMapping).length) {
    const fromTpl =
      tpl?.variableMappings?.body || tpl?.variableMapping?.body || tpl?.variableMapping;
    if (fromTpl && typeof fromTpl === 'object' && Object.keys(fromTpl).length) {
      variableMapping = { ...fromTpl };
    } else {
      variableMapping = inferDefaultVariableMapping(tpl?.components);
    }
  }

  const mappedBody = buildMappedBodyComponent({ variableMapping, row, client });
  const components = mappedBody ? [mappedBody] : [];

  return {
    templateName,
    templateLanguage: tpl?.language || step.templateLanguage || 'en',
    components,
  };
}

async function maybeFinalizeSequence(sequenceId, clientId) {
  const fresh = await FollowUpSequence.findById(sequenceId).lean();
  if (!fresh || fresh.status !== 'active') return;

  const steps = fresh.steps || [];
  const hasPending = steps.some((s) =>
    ['pending', 'queued', 'processing', 'retrying'].includes(s.status)
  );
  if (hasPending) return;

  await FollowUpSequence.findByIdAndUpdate(sequenceId, { $set: { status: 'completed' } });

  if (fresh.leadId) {
    const count = await FollowUpSequence.countDocuments({
      clientId,
      leadId: fresh.leadId,
      status: 'active',
    });
    await AdLead.findByIdAndUpdate(fresh.leadId, {
      $set: { 'metaData.hasActiveSequence': count > 0 },
    });
  }
}

async function markStepSkipped(sequenceId, stepIdx, fromStatus, reason) {
  const from = fromStatus === 'processing' ? 'processing' : fromStatus;
  await transitionSequenceStep(sequenceId, stepIdx, from, 'skipped', {
    failureReason: reason,
    skipReason: reason,
    lockedBy: null,
    lockedAt: null,
  });
}

async function processSequenceDispatchJob(job) {
  const { sequenceId, stepIdx, clientId } = job.data;
  const seq = await FollowUpSequence.findById(sequenceId);
  if (!seq || seq.status !== 'active') return;
  const step = seq.steps?.[stepIdx];
  if (!step) return;

  const stepChannel = resolveStepChannel(step);
  const fromStatus = step.status === 'pending' ? 'pending' : step.status;
  if (!['queued', 'pending', 'retrying'].includes(fromStatus)) return;

  const lead = await AdLead.findById(seq.leadId).lean();
  const phone = normalizePhone(lead, seq);
  const email = normalizeEmail(lead, seq);

  if (stepChannel === 'email' && (!email || !email.includes('@'))) {
    await transitionSequenceStep(sequenceId, stepIdx, fromStatus, 'processing', {
      lockedBy: WORKER_ID,
      lockedAt: new Date(),
      attempts: (step.attempts || 0) + 1,
      lastAttemptAt: new Date(),
    });
    await markStepSkipped(sequenceId, stepIdx, 'processing', 'no_email');
    await maybeFinalizeSequence(sequenceId, clientId);
    await emitSequenceProgress(clientId, sequenceId);
    return;
  }

  if (stepChannel === 'whatsapp' && phone.length < 10) {
    await transitionSequenceStep(sequenceId, stepIdx, fromStatus, 'processing', {
      lockedBy: WORKER_ID,
      lockedAt: new Date(),
      attempts: (step.attempts || 0) + 1,
      lastAttemptAt: new Date(),
    });
    await markStepSkipped(sequenceId, stepIdx, 'processing', 'no_phone');
    await maybeFinalizeSequence(sequenceId, clientId);
    await emitSequenceProgress(clientId, sequenceId);
    return;
  }

  const credSelect =
    stepChannel === 'email' ? EMAIL_CREDENTIAL_SELECT : WHATSAPP_CREDENTIAL_SELECT;
  const client = await Client.findOne({ clientId }).select(credSelect).lean();
  if (!client) return;

  const gate = await acquire({ client, clientId, channel: stepChannel });
  if (!gate.acquired) {
    await enqueueSequenceStepJob({ ...job.data, channel: stepChannel }, { delay: (gate.retryAfter || 2) * 1000 });
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

    let payload;
    let intent = 'marketing';
    if (stepChannel === 'email') {
      intent = 'marketing';
      const merged = mergeEmailForLead(
        step.subject || 'Follow up',
        step.content || '',
        lead || { name: seq.name, email, phoneNumber: seq.phone },
        client
      );
      payload = {
        subject: merged.subject,
        html: merged.html,
      };
    } else if (step.templateName) {
      intent = intentFromTemplateCategory(step.templateCategory);
      payload = await buildSequenceWhatsAppPayload({
        client,
        clientId,
        step,
        lead,
        seq,
      });
    } else {
      payload = { text: step.content || '' };
    }

    const envelopeInput = {
      clientId,
      channel: stepChannel,
      intent,
      contactId: lead?._id,
      payload,
      idempotency: { key: `seq-step:${sequenceId}:${stepIdx}` },
      context: {
        source: 'workers/sequenceDispatchWorker',
        sequenceId: String(sequenceId),
        sequenceName: seq.name || 'Sequence',
        stepIndex: stepIdx,
        stepType: step.type || stepChannel,
      },
    };

    if (stepChannel === 'email') {
      envelopeInput.contact = lead?._id ? undefined : { email };
    } else if (!lead?._id && phone) {
      envelopeInput.contact = { phone: lead?.phoneNumber || seq.phone };
    }

    const result = await sendEnvelope(envelopeInput);
    const outcome = classifyEnvelopeOutcome(result, (step.attempts || 0) + 1);

    if (outcome.action === 'sent') {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'sent', {
        sentAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      });
      await maybeFinalizeSequence(sequenceId, clientId);
      logDispatchEvent('SequenceDispatch', 'sequence_step_sent', {
        clientId,
        sequenceId: String(sequenceId),
        stepIdx,
        channel: stepChannel,
        outcome: 'sent',
        messageId: result?.messageId || null,
      });
    } else if (outcome.action === 'skipped') {
      await markStepSkipped(sequenceId, stepIdx, 'processing', outcome.reason || 'skipped');
      await maybeFinalizeSequence(sequenceId, clientId);
    } else if (outcome.action === 'retry') {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'retrying', {
        nextAttemptAt: new Date(Date.now() + outcome.delaySec * 1000),
        failureReason: outcome.reason,
      });
      await enqueueSequenceStepJob(
        { ...job.data, channel: stepChannel },
        { delay: outcome.delaySec * 1000 }
      );
    } else {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: outcome.reason || 'failed',
        errorLog: outcome.reason,
      });
      await maybeFinalizeSequence(sequenceId, clientId);
      logDispatchEvent('SequenceDispatch', 'sequence_step_failed', {
        clientId,
        sequenceId: String(sequenceId),
        stepIdx,
        channel: stepChannel,
        outcome: 'failed',
        reason: outcome.reason || 'failed',
      }, 'warn');
    }
  } catch (err) {
    log.warn(`Sequence job ${sequenceId}:${stepIdx}: ${err.message}`);
    try {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: err.message || 'dispatch_error',
        errorLog: err.message,
      });
      await maybeFinalizeSequence(sequenceId, clientId);
    } catch (transitionErr) {
      log.warn(`Sequence fail transition ${sequenceId}:${stepIdx}: ${transitionErr.message}`);
    }
  } finally {
    if (hbKey) stopHeartbeat(hbKey);
    await release({ clientId, channel: stepChannel });
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
