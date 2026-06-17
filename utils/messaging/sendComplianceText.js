'use strict';

const { dispatchBotEnvelope } = require('./botEnvelopeDispatch');
const log = require('../core/logger')('ComplianceText');

/**
 * Send a regulatory/compliance reply (STOP confirmation, START welcome)
 * that must deliver even when the contact is on the suppression list.
 */
async function sendComplianceText(client, phone, text, opts = {}) {
  if (!client?.clientId || !phone || !String(text || '').trim()) {
    return { sent: false, reason: 'missing_params' };
  }
  try {
    const env = await dispatchBotEnvelope({
      client,
      phone,
      channel: 'whatsapp',
      intent: 'utility',
      payload: { text: String(text).trim() },
      opts: {
        complianceExempt: true,
        source: opts.source || 'compliance_text',
        conversationId: opts.conversationId || null,
      },
    });
    return {
      sent: Boolean(env?.sent),
      messageId: env?.messageId || null,
      handled: env?.handled,
    };
  } catch (err) {
    log.warn(`[sendComplianceText] failed for ${phone}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendComplianceText };
