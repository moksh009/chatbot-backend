'use strict';

const TemplateSendLog = require('../../models/TemplateSendLog');

/**
 * Write TemplateSendLog for cron cart recovery sends (BUG-005).
 */
async function logCartRecoveryTemplateSend({
  client,
  lead,
  stepNum = 1,
  templateName = '',
  cartRule = null,
  outcome = {},
  channel = 'whatsapp',
}) {
  if (!client?.clientId) return;
  const sent = outcome?.sent === true;
  const automationSlotId = cartRule?.id || `sys_cart_followup_${stepNum}`;
  try {
    await TemplateSendLog.create({
      clientId: client.clientId,
      templateName: templateName || '',
      automationSlotId,
      contextType: 'abandoned_cart',
      failureCode: sent ? 'sent' : 'send_error',
      channel: outcome?.channel || channel || 'whatsapp',
      recipientPhone: lead?.phoneNumber || '',
      recipientEmail: lead?.email || '',
      contextData: {
        step: stepNum,
        source: 'cron/abandonedCartScheduler',
        checkoutToken: lead?.checkoutToken || lead?.cartSnapshot?.checkoutToken || '',
        reason: sent ? null : outcome?.reason || null,
      },
      status: sent ? 'sent' : 'failed',
      errorMessage: sent ? null : outcome?.detail || outcome?.reason || null,
    });
  } catch (_) {
    /* non-fatal */
  }
}

module.exports = { logCartRecoveryTemplateSend };
