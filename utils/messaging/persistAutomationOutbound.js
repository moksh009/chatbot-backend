'use strict';

const Conversation = require('../../models/Conversation');
const { createMessage } = require('../core/createMessage');
const { normalizePhone } = require('../core/helpers');
const log = require('../core/logger')('PersistAutomationOutbound');

/**
 * Persist an automation / template outbound to Message + socket so Live Chat shows it.
 * Ensures a Conversation exists (upsert) so inbox threads are never orphaned.
 */
async function persistAutomationOutbound({
  clientId,
  phone,
  templateName = '',
  bodyPreview = '',
  messageId = '',
  channel = 'whatsapp',
  metadata = {},
}) {
  const phoneNorm = normalizePhone(phone);
  if (!clientId || !phoneNorm) {
    log.debug('skip persist — missing tenant or phone', {
      clientId: clientId || null,
      hasPhone: Boolean(phone),
    });
    return null;
  }

  try {
    const convo = await Conversation.findOneAndUpdate(
      { clientId, phone: phoneNorm },
      {
        $setOnInsert: {
          phone: phoneNorm,
          clientId,
          botPaused: false,
          status: 'BOT_ACTIVE',
        },
        $set: {
          lastInteraction: new Date(),
          ...(metadata.lastOutboundTemplate
            ? { 'metadata.lastOutboundTemplate': metadata.lastOutboundTemplate }
            : {}),
        },
      },
      { upsert: true, new: true }
    )
      .select('_id')
      .lean();

    const content =
      String(bodyPreview || '').trim() ||
      `[Template: ${templateName || 'automation'}]`;

    const savedMessage = await createMessage({
      clientId,
      conversationId: convo?._id || null,
      phone: phoneNorm,
      from: 'BOT',
      to: phoneNorm,
      direction: 'outbound',
      type: channel === 'email' ? 'email' : 'template',
      body: content,
      messageId: messageId || '',
      channel,
      metadata: {
        source: metadata.source || 'automation',
        templateName: templateName || metadata.templateName || undefined,
        ...metadata,
        automation_rule_id:
          metadata.automation_rule_id || metadata.automationSlotId || undefined,
        contextType:
          metadata.contextType ||
          (metadata.cart_step != null ? 'abandoned_cart' : undefined),
      },
    });

    const io = global.io;
    if (io && clientId) {
      io.to(`client_${clientId}`).emit('new_message', savedMessage);
      if (convo?._id) {
        const updatedConvo = await Conversation.findById(convo._id)
          .populate('assignedTo', 'name')
          .lean();
        if (updatedConvo) {
          io.to(`client_${clientId}`).emit('conversation_update', {
            ...updatedConvo,
            lastMessage: content.substring(0, 100),
            lastMessageAt: new Date(),
          });
        }
      }
    }

    log.info('automation outbound persisted to inbox', {
      clientId,
      conversationId: convo?._id ? String(convo._id) : null,
      templateName: templateName || null,
      channel,
      messageId: messageId || null,
      automationSource: metadata?.source || metadata?.automation_rule_id || null,
    });

    return savedMessage;
  } catch (err) {
    log.warn('persistAutomationOutbound failed', {
      clientId,
      phone: phoneNorm,
      templateName: templateName || null,
      error: err.message,
    });
    return null;
  }
}

module.exports = { persistAutomationOutbound };
