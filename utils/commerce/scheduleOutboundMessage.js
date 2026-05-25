/**
 * Normalizes outbound scheduling into ScheduledMessage schema.
 * Accepts legacy writer shapes (scheduledFor, type, templateName, variables).
 */
const ScheduledMessage = require('../../models/ScheduledMessage');
const log = require('../core/logger')('ScheduleOutbound');

function buildTemplateComponents(variables = [], headerImage = '') {
  const params = (variables || []).map((text) => ({
    type: 'text',
    text: String(text ?? ''),
  }));
  const components = [];
  if (headerImage) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: headerImage } }],
    });
  }
  if (params.length) {
    components.push({ type: 'body', parameters: params });
  }
  return components;
}

/**
 * @param {object} input
 * @param {string} input.clientId
 * @param {string} input.phone
 * @param {'whatsapp'|'instagram'|'email'} [input.channel]
 * @param {'text'|'template'|'interactive'|'image'} [input.messageType]
 * @param {Date|string|number} input.sendAt - or legacy scheduledFor
 * @param {string} input.sourceType
 * @param {string} input.sourceId
 * @param {string} [input.templateName] - legacy flat field
 * @param {string[]} [input.variables] - legacy body vars for templates
 * @param {string} [input.headerImage]
 * @param {string} [input.languageCode]
 * @param {object} [input.content] - when already schema-shaped
 * @param {object} [input.cancelIf]
 * @param {object} [input.metadata] - stored inside content._meta for traceability
 */
async function scheduleOutboundMessage(input = {}) {
  const clientId = input.clientId;
  const phone = input.phone;
  if (!clientId || !phone) {
    throw new Error('scheduleOutboundMessage: clientId and phone are required');
  }

  const sendAt = input.sendAt || input.scheduledFor;
  if (!sendAt) {
    throw new Error('scheduleOutboundMessage: sendAt (or scheduledFor) is required');
  }

  const channel = input.channel || 'whatsapp';
  let messageType = input.messageType || input.type || 'text';
  if (messageType === 'whatsapp_text') messageType = 'text';
  if (input.templateName && messageType !== 'interactive') {
    messageType = 'template';
  }

  let content = input.content;
  if (!content || typeof content !== 'object') {
    if (messageType === 'template') {
      content = {
        templateName: input.templateName,
        languageCode: input.languageCode || input.language || 'en_US',
        components: buildTemplateComponents(input.variables, input.headerImage),
      };
    } else if (messageType === 'interactive') {
      content = input.content || { type: 'interactive' };
    } else {
      content = {
        text: typeof input.content === 'string' ? input.content : input.text || '',
      };
    }
  }

  if (input.metadata && typeof content === 'object') {
    content = { ...content, _meta: input.metadata };
  }

  const sourceType = input.sourceType || inferSourceType(input.metadata);
  const sourceId =
    input.sourceId ||
    input.metadata?.automationId ||
    input.metadata?.sku ||
    `sched_${Date.now()}`;

  const doc = {
    clientId,
    phone,
    channel,
    messageType,
    content,
    sendAt: new Date(sendAt),
    status: input.status || 'pending',
    sourceType,
    sourceId,
    cancelIf: input.cancelIf || null,
  };

  const created = await ScheduledMessage.create(doc);
  return created;
}

function inferSourceType(metadata = {}) {
  const src = String(metadata.source || '');
  if (src.includes('commerce')) return 'commerce_automation';
  if (src.includes('sku')) return 'sku_trigger';
  if (src.includes('upsell')) return 'cart_recovery';
  return 'follow_up';
}

module.exports = {
  scheduleOutboundMessage,
  buildTemplateComponents,
};
