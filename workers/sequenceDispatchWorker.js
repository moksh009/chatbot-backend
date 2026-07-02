const os = require('os');
const { Worker } = require('bullmq');
const FollowUpSequence = require('../models/FollowUpSequence');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const { sendEnvelope } = require('../utils/messaging/sendEnvelope');
const { intentFromTemplateCategory } = require('../utils/messaging/envelopeHelpers');
const { transitionSequenceStep, tryTransitionSequenceStep, readSequenceStepStatus } = require('../utils/messaging/transitions/sequenceStepTransition');
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
const { buildJourneySequenceWhatsAppPayload, findOrderDocForSequence, orderDocToSendPayload } = require('../services/journeyBuilder/journeySequenceWhatsApp');
const { assertSequenceContextForStep, stepNeedsContextResolution, markSequenceContextLifecycle } = require('../services/journeyBuilder/sequenceContextService');
const { buildSendContext } = require('../services/templateVariableResolver');
const MetaTemplate = require('../models/MetaTemplate');
const { enqueueDueStepsForSequence } = require('../utils/messaging/sequenceStepEnqueue');
const { journeyLog, journeyLogWarn, journeyLogError } = require('../utils/journeyBuilder/journeyPipelineLog');
const log = require('../utils/core/logger')('SequenceDispatchWorker');
const { logDispatchEvent } = require('../utils/messaging/dispatchEventLog');
const { emitToClient } = require('../utils/core/socket');
const { isStepSent, isStepFailed } = require('../services/journeyBuilder/journeyStatsService');

async function emitSequenceProgress(clientId, sequenceId) {
  try {
    const fresh = await FollowUpSequence.findById(sequenceId).select('status steps').lean();
    if (!fresh) return;
    const steps = fresh.steps || [];
    // Use shared helpers — same mutual-exclusivity rule as stats API
    const sent = steps.filter(isStepSent).length;
    const failed = steps.filter(isStepFailed).length;
    const skipped = steps.filter((s) => s.status === 'skipped').length;
    const pending = steps.filter((s) =>
      ['pending', 'queued', 'processing', 'retrying'].includes(s.status)
    ).length;
    const delivered = steps.filter((s) => !!s.deliveredAt).length;
    const read = steps.filter((s) => !!s.readAt).length;
    emitToClient(clientId, 'sequence:progress', {
      sequenceId: String(sequenceId),
      status: fresh.status,
      counts: { sent, failed, skipped, pending, delivered, read, total: steps.length },
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
  return buildJourneySequenceWhatsAppPayload({ client, clientId, step, lead, seq });
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
  await markSequenceContextLifecycle(sequenceId, 'completed');

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

async function markStepSkipped(sequenceId, stepIdx, fromStatus, reason, meta = {}) {
  const from = ['queued', 'retrying', 'processing'].includes(fromStatus) ? fromStatus : 'queued';
  const result = await tryTransitionSequenceStep(sequenceId, stepIdx, from, 'skipped', {
    failureReason: reason,
    skipReason: reason,
    lockedBy: null,
    lockedAt: null,
  });
  if (!result.ok) {
    journeyLog('dispatch', 'skip transition conflict — step already moved', {
      sequenceId: String(sequenceId),
      stepIdx,
      fromStatus: from,
      reason,
      ...meta,
    });
    return false;
  }
  journeyLog('dispatch', 'step skipped', {
    sequenceId: String(sequenceId),
    stepIdx,
    reason,
    ...meta,
  });
  return true;
}

async function claimStepForProcessing(sequenceId, stepIdx, step) {
  const fromStatus = step.status;
  if (!['queued', 'retrying'].includes(fromStatus)) {
    return { ok: false, reason: 'not_claimable', fromStatus };
  }
  return tryTransitionSequenceStep(sequenceId, stepIdx, fromStatus, 'processing', {
    lockedBy: WORKER_ID,
    lockedAt: new Date(),
    attempts: (step.attempts || 0) + 1,
    lastAttemptAt: new Date(),
  });
}

async function finalizeStepAndContinue(sequenceId, clientId) {
  await maybeFinalizeSequence(sequenceId, clientId);
  await enqueueDueStepsForSequence(sequenceId).catch((e) => {
    journeyLogWarn('enqueue', 'post-step enqueue failed', {
      sequenceId: String(sequenceId),
      clientId,
      error: e.message,
    });
  });
  await emitSequenceProgress(clientId, sequenceId);
}

async function processSequenceDispatchJob(job) {
  const { sequenceId, stepIdx, clientId } = job.data;
  const dispatchMeta = {
    clientId,
    sequenceId: String(sequenceId),
    stepIdx,
    jobId: job.id,
  };

  const seq = await FollowUpSequence.findById(sequenceId);
  if (!seq || seq.status !== 'active') {
    journeyLogWarn('dispatch', 'sequence missing or not active', dispatchMeta);
    return;
  }
  const step = seq.steps?.[stepIdx];
  if (!step) {
    journeyLogWarn('dispatch', 'step not found', dispatchMeta);
    return;
  }

  const stepType = String(step?.type || 'whatsapp').toLowerCase();
  if (!['queued', 'retrying'].includes(step.status)) {
    journeyLog('dispatch', 'step not claimable — another worker finished or scheduler pending', {
      ...dispatchMeta,
      stepStatus: step.status,
      stepType,
    });
    return;
  }

  journeyLog('dispatch', 'processing step', {
    ...dispatchMeta,
    stepType,
    stepStatus: step.status,
    templateName: step.templateName || null,
    sendAt: step.sendAt || null,
  });

  const lead = await AdLead.findById(seq.leadId).lean();
  const phone = normalizePhone(lead, seq);
  const email = normalizeEmail(lead, seq);

  const { evaluateSequenceStepCondition } = require('../utils/messaging/evaluateSequenceStepCondition');
  const conditionResult = await evaluateSequenceStepCondition({
    clientId,
    phone,
    step,
    sequence: seq,
  });
  if (!conditionResult.proceed) {
    const reason = conditionResult.reason || 'condition_not_met';
    if (reason === 'cod_prepaid_outcome_pending' || conditionResult.defer) {
      journeyLog('condition', 'step deferred — COD prepaid outcome pending', {
        ...dispatchMeta,
        reason,
        stepType,
      });
      await enqueueSequenceStepJob(
        { ...job.data, channel: step.channel || stepType },
        { delay: 60_000 }
      );
      return;
    }
    journeyLog('condition', 'step skipped by rule', { ...dispatchMeta, reason, stepType });
    await markStepSkipped(sequenceId, stepIdx, step.status, reason, dispatchMeta);
    await finalizeStepAndContinue(sequenceId, clientId);
    return;
  }

  const stepContextCheck = stepNeedsContextResolution(step)
    ? assertSequenceContextForStep(seq, step)
    : { ok: true };
  if (!stepContextCheck.ok) {
    journeyLogWarn('dispatch', 'step skipped — missing enrollment context', {
      ...dispatchMeta,
      reason: stepContextCheck.reason,
      missing: stepContextCheck.missing,
    });
    await markStepSkipped(sequenceId, stepIdx, step.status, stepContextCheck.reason, dispatchMeta);
    await finalizeStepAndContinue(sequenceId, clientId);
    return;
  }

  if (stepType === 'cod_prepaid') {
    const credSelect = WHATSAPP_CREDENTIAL_SELECT;
    const client = await Client.findOne({ clientId }).select(credSelect).lean();
    if (!client) {
      journeyLogWarn('dispatch', 'client not found for cod_prepaid', dispatchMeta);
      return;
    }

    const gate = await acquire({ client, clientId, channel: 'whatsapp' });
    if (!gate.acquired) {
      await enqueueSequenceStepJob({ ...job.data, channel: 'whatsapp' }, { delay: (gate.retryAfter || 2) * 1000 });
      return;
    }

    let hbKey;
    try {
      const claimed = await claimStepForProcessing(sequenceId, stepIdx, step);
      if (!claimed.ok) return;

      hbKey = startHeartbeat({ workerId: WORKER_ID, type: 'sequence_step', recordId: sequenceId, stepIdx });

      const { executeCodToPrepaidStep } = require('../services/journeyBuilder/codToPrepaid/codToPrepaidExecutor');
      const result = await executeCodToPrepaidStep({ client, clientId, step, seq, lead });

      if (result.ok) {
        await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'sent', {
          sentAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          channel: 'whatsapp',
        });
        journeyLog('send', 'cod_prepaid step completed', {
          ...dispatchMeta,
          outcome: result.outcome,
          conversionId: result.conversionId,
        });
      } else {
        await markStepSkipped(sequenceId, stepIdx, step.status, result.reason || 'cod_prepaid_failed', dispatchMeta);
        journeyLogWarn('send', 'cod_prepaid step failed', {
          ...dispatchMeta,
          reason: result.reason,
        });
      }
      await finalizeStepAndContinue(sequenceId, clientId);
    } catch (codErr) {
      journeyLogError('send', 'cod_prepaid step error', { ...dispatchMeta, error: codErr.message });
      const failResult = await tryTransitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: codErr.message,
        lockedBy: null,
        lockedAt: null,
      });
      if (failResult.ok) await finalizeStepAndContinue(sequenceId, clientId);
    } finally {
      if (hbKey) stopHeartbeat(hbKey);
      await release({ clientId, channel: 'whatsapp' });
    }
    return;
  }

  if (stepType === 'flow_handoff') {
    if (phone.length < 10) {
      await markStepSkipped(sequenceId, stepIdx, step.status, 'no_phone', dispatchMeta);
      await finalizeStepAndContinue(sequenceId, clientId);
      return;
    }

    const targetFlowId = String(step.targetFlowId || '').trim();
    if (!targetFlowId) {
      await markStepSkipped(sequenceId, stepIdx, step.status, 'no_target_flow', dispatchMeta);
      await finalizeStepAndContinue(sequenceId, clientId);
      return;
    }

    const client = await Client.findOne({ clientId }).select(WHATSAPP_CREDENTIAL_SELECT).lean();
    if (!client) {
      journeyLogWarn('dispatch', 'client not found for flow handoff', dispatchMeta);
      return;
    }

    const gate = await acquire({ client, clientId, channel: 'whatsapp' });
    if (!gate.acquired) {
      await enqueueSequenceStepJob({ ...job.data, channel: 'whatsapp' }, { delay: (gate.retryAfter || 2) * 1000 });
      return;
    }

    let hbKey;
    try {
      const claimed = await claimStepForProcessing(sequenceId, stepIdx, step);
      if (!claimed.ok) {
        journeyLog('dispatch', 'flow handoff claim lost to concurrent worker', {
          ...dispatchMeta,
          reason: claimed.reason || claimed.message,
        });
        return;
      }
      hbKey = startHeartbeat({ workerId: WORKER_ID, type: 'sequence_step', recordId: sequenceId, stepIdx });

      const { executeJourneyFlowHandoff } = require('../services/journeyBuilder/journeyFlowHandoff');
      await executeJourneyFlowHandoff({
        clientId,
        phone: lead?.phoneNumber || seq.phone || phone,
        targetFlowId,
        sequenceId,
      });

      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'sent', {
        sentAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        channel: 'whatsapp',
      });
      journeyLog('send', 'flow handoff completed', { ...dispatchMeta, targetFlowId });
      logDispatchEvent('SequenceDispatch', 'sequence_flow_handoff', {
        clientId,
        sequenceId: String(sequenceId),
        stepIdx,
        targetFlowId,
        outcome: 'sent',
      });
      await finalizeStepAndContinue(sequenceId, clientId);
    } catch (handoffErr) {
      journeyLogError('send', 'flow handoff failed', { ...dispatchMeta, error: handoffErr.message });
      const failResult = await tryTransitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: handoffErr.message,
        lockedBy: null,
        lockedAt: null,
      });
      if (failResult.ok) await finalizeStepAndContinue(sequenceId, clientId);
    } finally {
      if (hbKey) stopHeartbeat(hbKey);
      await release({ clientId, channel: 'whatsapp' });
    }
    return;
  }

  const stepChannel = resolveStepChannel(step);

  if (stepChannel === 'email' && (!email || !email.includes('@'))) {
    journeyLogWarn('dispatch', 'skipped — lead has no email', { ...dispatchMeta, email: email || null });
    await markStepSkipped(sequenceId, stepIdx, step.status, 'no_email', dispatchMeta);
    await finalizeStepAndContinue(sequenceId, clientId);
    return;
  }

  if (stepChannel === 'whatsapp' && phone.length < 10) {
    journeyLogWarn('dispatch', 'skipped — lead has no valid phone', { ...dispatchMeta, phoneTail: phone.slice(-4) || null });
    await markStepSkipped(sequenceId, stepIdx, step.status, 'no_phone', dispatchMeta);
    await finalizeStepAndContinue(sequenceId, clientId);
    return;
  }

  const credSelect =
    stepChannel === 'email' ? EMAIL_CREDENTIAL_SELECT : WHATSAPP_CREDENTIAL_SELECT;
  const client = await Client.findOne({ clientId }).select(credSelect).lean();
  if (!client) {
    journeyLogWarn('dispatch', 'client not found', dispatchMeta);
    return;
  }

  const gate = await acquire({ client, clientId, channel: stepChannel });
  if (!gate.acquired) {
    await enqueueSequenceStepJob({ ...job.data, channel: stepChannel }, { delay: (gate.retryAfter || 2) * 1000 });
    return;
  }

  let hbKey;
  let reachedProcessing = false;
  try {
    const claimed = await claimStepForProcessing(sequenceId, stepIdx, step);
    if (!claimed.ok) {
      journeyLog('dispatch', 'send claim lost to concurrent worker', {
        ...dispatchMeta,
        reason: claimed.reason || claimed.message,
      });
      return;
    }
    reachedProcessing = true;

    hbKey = startHeartbeat({ workerId: WORKER_ID, type: 'sequence_step', recordId: sequenceId, stepIdx });

    let payload;
    let intent = 'marketing';
    if (stepChannel === 'email') {
      intent = 'marketing';

      let orderFlatContext = {};
      try {
        const phoneForOrder = lead?.phoneNumber || seq?.phone || '';
        const orderDoc = await findOrderDocForSequence(clientId, seq, phoneForOrder);
        const orderPayload = orderDocToSendPayload(orderDoc);
        orderFlatContext = await buildSendContext({
          client,
          phone: phoneForOrder,
          lead,
          order: orderPayload,
          cart: lead?.cartSnapshot || lead?.capturedData?.cart || null,
          sequenceContext: seq?.sequenceContext || null,
        });
      } catch (orderErr) {
        log.warn(`[SequenceDispatch] email context load ${sequenceId}:${stepIdx}: ${orderErr.message}`);
      }

      const merged = mergeEmailForLead(
        step.subject || 'Follow up',
        step.content || '',
        lead || { name: seq.name, email, phoneNumber: seq.phone },
        client,
        orderFlatContext,
        { emailTokenMappings: step.emailTokenMappings }
      );
      payload = {
        subject: merged.subject,
        html: merged.html,
      };
    } else if (step.templateName) {
      // Derive intent from stored category first; fall back to a MetaTemplate DB lookup
      // so that UTILITY/AUTHENTICATION templates are not incorrectly sent with marketing intent.
      let templateCategory = step.templateCategory;
      if (!templateCategory) {
        try {
          const tplDoc = await MetaTemplate.findOne(
            { clientId, name: step.templateName, submissionStatus: 'approved' },
            { category: 1 }
          ).lean();
          if (tplDoc?.category) templateCategory = tplDoc.category;
        } catch (_) { /* non-fatal — fall through to marketing default */ }
      }
      intent = intentFromTemplateCategory(templateCategory);
      try {
        payload = await buildSequenceWhatsAppPayload({
          client,
          clientId,
          step,
          lead,
          seq,
        });
      } catch (buildErr) {
        const reason =
          buildErr.code === 'template_variables_missing'
            ? 'template_variables_missing'
            : buildErr.code === 'template_header_image_missing'
              ? 'template_header_image_missing'
              : String(buildErr.code || '').startsWith('missing_')
                ? buildErr.code
                : (buildErr.message || 'template_build_failed');
        journeyLogError('send', 'whatsapp payload build failed', {
          ...dispatchMeta,
          reason,
        });
        if (String(reason).startsWith('missing_')) {
          await markStepSkipped(sequenceId, stepIdx, step.status, reason, dispatchMeta);
          await finalizeStepAndContinue(sequenceId, clientId);
          return;
        }
        await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
          failureReason: reason,
          errorLog: reason,
        });
        await finalizeStepAndContinue(sequenceId, clientId, stepIdx);
        return;
      }
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
      const sentAt = new Date();
      const sentPatch = {
        sentAt,
        lockedBy: null,
        lockedAt: null,
        channel: stepChannel,
      };
      if (result?.messageId) sentPatch.messageId = String(result.messageId);
      if (result?.envelopeId) sentPatch.envelopeId = result.envelopeId;
      // For email, SMTP accept = proxy delivered baseline (real opens backfill via tracking pixel)
      if (stepChannel === 'email') sentPatch.deliveredAt = sentAt;

      try {
        await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'sent', sentPatch);
      } catch (transErr) {
        if (transErr.code === 'transition_conflict') {
          // Message was delivered but the step state moved under us (race).
          // Force-write sentAt + status so analytics don't show zero and email
          // step 2 still gets enqueued via finalizeStepAndContinue below.
          const forceSet = { [`steps.${stepIdx}.status`]: 'sent' };
          for (const [k, v] of Object.entries(sentPatch)) {
            forceSet[`steps.${stepIdx}.${k}`] = v;
          }
          await FollowUpSequence.findOneAndUpdate(
            {
              _id: sequenceId,
              [`steps.${stepIdx}.status`]: { $nin: ['cancelled', 'failed', 'skipped'] },
            },
            { $set: forceSet }
          );
          journeyLog('send', `${stepChannel} step sent (force-write after transition conflict)`, {
            ...dispatchMeta,
            channel: stepChannel,
            messageId: result?.messageId || null,
          });
        } else {
          throw transErr;
        }
      }

      journeyLog('send', `${stepChannel} step sent`, {
        ...dispatchMeta,
        channel: stepChannel,
        messageId: result?.messageId || null,
        templateName: step.templateName || null,
      });

      if (seq.sourceFlowId && stepChannel === 'whatsapp' && result?.messageId) {
        try {
          const TemplateSendLog = require('../models/TemplateSendLog');
          await TemplateSendLog.create({
            clientId,
            templateName: step.templateName || '',
            contextType: 'journey_sequence',
            failureCode: 'sent',
            channel: 'whatsapp',
            recipientPhone: lead?.phoneNumber || seq.phone || '',
            messageId: String(result.messageId),
            status: 'sent',
            contextData: {
              sourceFlowId: seq.sourceFlowId,
              sequenceId: String(sequenceId),
              stepIndex: stepIdx,
              blueprintId: seq.sourceFlowId,
            },
          });
        } catch (logErr) {
          log.warn(`Journey TemplateSendLog ${sequenceId}:${stepIdx}: ${logErr.message}`);
        }
      }
      logDispatchEvent('SequenceDispatch', 'sequence_step_sent', {
        clientId,
        sequenceId: String(sequenceId),
        stepIdx,
        channel: stepChannel,
        outcome: 'sent',
        messageId: result?.messageId || null,
      });
      if (stepChannel === 'whatsapp') {
        try {
          const { normalizePhone } = require('../utils/core/helpers');
          const { persistAutomationOutbound } = require('../utils/messaging/persistAutomationOutbound');
          const sendPhone = normalizePhone(lead?.phoneNumber || seq.phone || phone);
          const tplName = step?.templateName || step?.template || '';
          if (sendPhone) {
            await persistAutomationOutbound({
              clientId,
              phone: sendPhone,
              templateName: tplName,
              bodyPreview: `[Sequence · ${seq.name || 'step'}] ${tplName ? `Template: ${tplName}` : ''}`.trim(),
              messageId: result?.messageId || '',
              metadata: {
                source: 'follow_up_sequence',
                sequence_id: String(sequenceId),
                sequence_step: stepIdx,
              },
            });
          }
        } catch (persistErr) {
          log.warn(`Sequence inbox persist ${sequenceId}:${stepIdx}: ${persistErr.message}`);
        }

        if (seq.playbookKey && seq.playbookKey.includes('cart-recovery') && lead?._id) {
          try {
            const stepNum = stepIdx + 1;
            await AdLead.findByIdAndUpdate(lead._id, {
              $max: { recoveryStep: stepNum },
              $push: { activityLog: { action: 'automation_nudge', details: `cart_step_${stepNum}_journey`, timestamp: new Date() } },
            });
          } catch (_cartStepErr) {
            log.warn(`Journey cart step track ${sequenceId}:${stepIdx}: ${_cartStepErr.message}`);
          }
        }
      }
      await finalizeStepAndContinue(sequenceId, clientId);
    } else if (outcome.action === 'skipped') {
      await markStepSkipped(sequenceId, stepIdx, 'processing', outcome.reason || 'skipped', dispatchMeta);
      await finalizeStepAndContinue(sequenceId, clientId);
    } else if (outcome.action === 'retry') {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'retrying', {
        nextAttemptAt: new Date(Date.now() + outcome.delaySec * 1000),
        failureReason: outcome.reason,
      });
      journeyLogWarn('send', 'step scheduled for retry', {
        ...dispatchMeta,
        channel: stepChannel,
        reason: outcome.reason,
        delaySec: outcome.delaySec,
      });
      await enqueueSequenceStepJob(
        { ...job.data, channel: stepChannel },
        { delay: outcome.delaySec * 1000 }
      );
      await emitSequenceProgress(clientId, sequenceId);
    } else {
      await transitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: outcome.reason || 'failed',
        errorLog: outcome.reason,
      });
      journeyLogError('send', 'step failed', {
        ...dispatchMeta,
        channel: stepChannel,
        reason: outcome.reason || 'failed',
      });
      await finalizeStepAndContinue(sequenceId, clientId);
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
    if (err.code === 'transition_conflict') {
      journeyLog('dispatch', 'concurrent worker won step — exiting safely', dispatchMeta);
      return;
    }
    journeyLogError('dispatch', 'unexpected dispatch error', {
      ...dispatchMeta,
      error: err.message,
      reachedProcessing,
    });
    if (reachedProcessing) {
      const failResult = await tryTransitionSequenceStep(sequenceId, stepIdx, 'processing', 'failed', {
        failureReason: err.message || 'dispatch_error',
        errorLog: err.message,
      });
      if (failResult.ok) await finalizeStepAndContinue(sequenceId, clientId);
    } else {
      const current = await readSequenceStepStatus(sequenceId, stepIdx);
      journeyLogWarn('dispatch', 'error before claim — step left for scheduler', {
        ...dispatchMeta,
        stepStatus: current.stepStatus,
      });
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
