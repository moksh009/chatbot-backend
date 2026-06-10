'use strict';

const Conversation = require('../../models/Conversation');
const { createMessage } = require('../core/createMessage');
const log = require('../core/logger')('PersistAutomationOutbound');

/**
 * Persist an automation / template outbound to Message + socket so Live Chat shows it.
 * Mirrors dualBrainEngine.saveOutboundMessage without importing the full engine.
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
  if (!clientId || !phone) return null;

  try {
    const convo = await Conversation.findOne({ clientId, phone })
      .select('_id')
      .lean();

    const content =
      String(bodyPreview || '').trim() ||
      `[Template: ${templateName || 'automation'}]`;

    const savedMessage = await createMessage({
      clientId,
      conversationId: convo?._id || null,
      phone,
      from: 'BOT',
      to: phone,
      direction: 'outbound',
      type: 'template',
      body: content,
      messageId: messageId || '',
      channel,
      metadata: {
        source: 'automation',
        templateName: templateName || undefined,
        ...metadata,
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
          io.to(`client_${clientId}`).emit('conversation_update', updatedConvo);
        }
      }
    }

    return savedMessage;
  } catch (err) {
    log.warn('persistAutomationOutbound failed', {
      clientId,
      phone,
      error: err.message,
    });
    return null;
  }
}

module.exports = { persistAutomationOutbound };
