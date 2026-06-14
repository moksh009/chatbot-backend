'use strict';

const AdLead = require('../../models/AdLead');
const Client = require('../../models/Client');
const { getCartRecoveryDelays } = require('./cartRecoveryConfigService');
const { shouldSuppressCartSend } = require('./cartRecoverySuppression');
const { hasPendingMarketingSequenceSend } = require('./cartSequenceSendDedup');
const { pickAbTestTemplate, resolveAbTestTemplatesForSlot } = require('./cartRecoveryAbTest');
const { markCartRecoverySent } = require('./cartRecoveryManualSendDedup');

async function resolveNextStep(lead) {
  const current = Number(lead.recoveryStep || 0);
  if (current >= 3) return null;
  return Math.min(3, current <= 0 ? 1 : current + 1);
}

/**
 * Merchant-initiated cart recovery send (bulk "send now" / manual nudge).
 */
async function sendCartRecoveryNow({ clientId, leadId }) {
  const client = await Client.findOne({ clientId })
    .select('clientId nicheData wizardFeatures commerceAutomations cartRecoveryConfig shopDomain')
    .lean();
  const lead = await AdLead.findOne({ _id: leadId, clientId });
  if (!client || !lead) {
    const err = new Error('Lead not found');
    err.code = 'lead_not_found';
    throw err;
  }

  if (lead.suppressRecovery || lead.isOrderPlaced || ['purchased', 'recovered'].includes(lead.cartStatus)) {
    const err = new Error('Lead is not eligible for recovery sends');
    err.code = 'not_eligible';
    throw err;
  }

  if (await hasPendingMarketingSequenceSend(clientId, lead._id)) {
    const err = new Error('Lead has a pending marketing sequence send');
    err.code = 'sequence_active';
    throw err;
  }

  const { config } = getCartRecoveryDelays(client);
  const suppress = await shouldSuppressCartSend(client, lead, config);
  if (suppress.suppress) {
    const err = new Error(`Send blocked: ${suppress.reason}`);
    err.code = suppress.reason || 'suppressed';
    throw err;
  }

  const stepNum = await resolveNextStep(lead);
  if (!stepNum) {
    const err = new Error('Recovery sequence already completed for this lead');
    err.code = 'recovery_complete';
    throw err;
  }

  const slot = stepNum === 1 ? 'followup_1' : stepNum === 2 ? 'followup_2' : 'followup_3';
  const cartRules = (client.commerceAutomations || []).filter((a) => a.meta?.category === 'abandoned_cart');
  const cartRule = cartRules.find((x) => x.meta?.systemSlot === slot) || null;
  if (!cartRule?.isActive) {
    const err = new Error(`Cart recovery rule ${slot} is not active`);
    err.code = 'rule_inactive';
    throw err;
  }

  const { primary, variantB } = resolveAbTestTemplatesForSlot(cartRule, `cart_recovery_${stepNum}`);
  const { templateName } = pickAbTestTemplate({
    clientId,
    leadId: String(lead._id),
    stepNum,
    templateA: primary,
    templateB: variantB,
    abTestEnabled: config.abTestEnabled,
  });

  const { sendRichNudge } = require('../../cron/abandonedCartScheduler');
  const outcome = await sendRichNudge(client, lead, '', {
    stepNum,
    templateName,
    cartRule,
  });

  if (!outcome?.sent) {
    const err = new Error(outcome?.detail || outcome?.reason || 'Send failed');
    err.code = outcome?.reason || 'send_failed';
    throw err;
  }

  const dedupeKey = lead.phoneNumber || lead.email || String(lead._id);
  await markCartRecoverySent(clientId, dedupeKey, stepNum);

  await AdLead.findByIdAndUpdate(lead._id, {
    recoveryStep: Math.max(Number(lead.recoveryStep || 0), stepNum),
    recoveryStartedAt: lead.recoveryStartedAt || new Date(),
    $push: {
      activityLog: {
        action: 'automation_nudge',
        details: `cart_step_${stepNum}_manual`,
        timestamp: new Date(),
      },
    },
  });

  return { success: true, stepNum, templateName, channel: outcome.channel };
}

module.exports = { sendCartRecoveryNow, resolveNextStep };
