'use strict';

const Conversation = require('../../models/Conversation');
const log = require('../core/logger')('TemplateButtonResolver');

/**
 * Normalize Meta `type: button` payloads so keyword/graph routers see button text.
 */
function normalizeInboundButtonMessage(parsedMessage = {}) {
  if (!parsedMessage || typeof parsedMessage !== 'object') return parsedMessage;

  if (parsedMessage.type === 'button' && parsedMessage.button?.text) {
    if (!parsedMessage.text) parsedMessage.text = {};
    if (!parsedMessage.text.body) {
      parsedMessage.text.body = String(parsedMessage.button.text).trim();
    }
  }

  const replyTitle =
    parsedMessage.interactive?.button_reply?.title ||
    parsedMessage.interactive?.list_reply?.title ||
    '';
  if (replyTitle && (!parsedMessage.text?.body || !String(parsedMessage.text.body).trim())) {
    if (!parsedMessage.text) parsedMessage.text = {};
    parsedMessage.text.body = String(replyTitle).trim();
  }

  return parsedMessage;
}

function extractInboundButtonId(parsedMessage = {}) {
  return (
    parsedMessage.interactive?.button_reply?.id ||
    parsedMessage.interactive?.list_reply?.id ||
    parsedMessage.button?.payload ||
    parsedMessage.buttonReplyId ||
    ''
  );
}

function extractInboundButtonLabel(parsedMessage = {}) {
  return (
    parsedMessage.interactive?.button_reply?.title ||
    parsedMessage.interactive?.list_reply?.title ||
    parsedMessage.button?.text ||
    parsedMessage.text?.body ||
    ''
  );
}

/**
 * Build metadata blob stored on Conversation when automations send templates with buttons.
 */
function buildLastOutboundTemplateMetadata({
  templateName = '',
  messageId = '',
  buttons = [],
  action = null,
  automationSlotId = null,
}) {
  return {
    lastOutboundTemplate: {
      templateName: templateName || undefined,
      wamid: messageId || undefined,
      sentAt: new Date().toISOString(),
      buttons: Array.isArray(buttons) ? buttons : [],
      action: action || undefined,
      automationSlotId: automationSlotId || undefined,
    },
  };
}

/**
 * Match inbound quick-reply against last outbound template context on the conversation.
 */
async function resolveTemplateButtonAction({ client, convo, parsedMessage }) {
  if (!convo?._id) return null;

  const contextWamid = parsedMessage?.context?.id || parsedMessage?.context?.message_id || '';
  const buttonId = String(extractInboundButtonId(parsedMessage) || '').trim();
  const buttonLabel = String(extractInboundButtonLabel(parsedMessage) || '').trim().toLowerCase();

  const fresh = await Conversation.findById(convo._id).select('metadata').lean();
  const lastOutbound = fresh?.metadata?.lastOutboundTemplate;
  if (!lastOutbound) return null;

  if (contextWamid && lastOutbound.wamid && contextWamid !== lastOutbound.wamid) {
    return null;
  }

  const buttons = Array.isArray(lastOutbound.buttons) ? lastOutbound.buttons : [];
  let matched = null;

  if (buttonId) {
    matched = buttons.find(
      (b) =>
        String(b.id || b.payload || '').toLowerCase() === buttonId.toLowerCase() ||
        String(b.label || b.title || '').toLowerCase() === buttonId.toLowerCase()
    );
  }
  if (!matched && buttonLabel) {
    matched = buttons.find(
      (b) => String(b.label || b.title || '').toLowerCase() === buttonLabel
    );
  }

  const action = matched?.action || lastOutbound.action;
  if (!action) return null;

  log.info('template button action resolved', {
    clientId: client?.clientId,
    templateName: lastOutbound.templateName,
    buttonId: buttonId || buttonLabel,
    actionType: action.type,
  });

  return action;
}

module.exports = {
  normalizeInboundButtonMessage,
  extractInboundButtonId,
  extractInboundButtonLabel,
  buildLastOutboundTemplateMetadata,
  resolveTemplateButtonAction,
};
