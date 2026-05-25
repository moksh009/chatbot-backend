'use strict';

const { fireWebhookEvent, WEBHOOK_EVENTS } = require('../../utils/core/webhookDelivery');

/** Phase 8 public API event names → internal webhook events */
const EVENT_ALIASES = {
  'lead.created': 'lead.created',
  'lead.updated': 'lead.updated',
  'lead.opted_out': 'lead.opted_out',
  'message.received': 'conversation.started',
  'message.sent': 'campaign.sent',
  'conversation.started': 'conversation.started',
  'conversation.botPaused': 'conversation.escalated',
  'conversation.assigned': 'conversation.assigned',
  'campaign.started': 'campaign.sent',
  'campaign.completed': 'campaign.sent',
  'campaign.cancelled': 'campaign.sent',
  'sequence.enrolled': 'flow.completed',
  'sequence.completed': 'flow.completed',
  'order.placed': 'order.created',
  'flow.published': 'flow.completed',
};

function emitWebhookEvent(event, payload, clientId) {
  const mapped = EVENT_ALIASES[event] || event;
  if (!WEBHOOK_EVENTS[mapped] && !WEBHOOK_EVENTS[event]) {
    console.warn('[outboundDispatcher] Unknown event:', event);
  }
  return fireWebhookEvent(clientId, mapped, payload);
}

module.exports = { emitWebhookEvent, EVENT_ALIASES };
