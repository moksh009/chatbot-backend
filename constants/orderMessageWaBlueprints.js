'use strict';

/**
 * WhatsApp utility blueprints for Order messages (shipment + NDR).
 * Names must match automationSlotCatalog + commerceAutomationService mappings.
 */
const ORDER_MESSAGE_WA_BLUEPRINTS = {
  order_in_transit: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 📦 Your order {{2}} is on the way.\n\n' +
          'Track your package live here:\n{{3}}',
        example: { body_text: [['Priya', '#1042', 'https://track.example.com/AWB12345']] },
      },
    ],
  },
  order_out_for_delivery: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 🚚 Your order {{2}} is out for delivery and should reach you today.\n\n' +
          'Please keep your phone reachable for the delivery agent.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  order_delivered_update: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! ✅ Your order {{2}} has been delivered.\n\n' +
          'We hope you love it — reply here if anything is not right and we will sort it out.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  delivery_attempt_failed: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, the courier tried to deliver your order {{2}} today but could not complete the delivery.\n\n' +
          'Please reply with a good time to deliver, or share an alternate phone number / address so we can re-attempt it.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  rto_ndr_rescue: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, we could not complete delivery for order *{{2}}*.\n\n' +
          'Please reply in this chat with a *10-digit mobile number* or your *full address and PIN code* so we can try again.\n\n' +
          'Reference: {{3}}',
        example: { body_text: [['Priya', '#1042', '5678901234']] },
      },
    ],
  },
};

function normalizeTemplateKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

function getOrderMessageBlueprint(nameOrKey) {
  const key = normalizeTemplateKey(nameOrKey);
  if (!key) return null;
  if (ORDER_MESSAGE_WA_BLUEPRINTS[key]) {
    return { name: key, ...ORDER_MESSAGE_WA_BLUEPRINTS[key] };
  }
  return null;
}

function blueprintToWorkspaceTemplate(nameOrKey) {
  const bp = getOrderMessageBlueprint(nameOrKey);
  if (!bp) return null;
  const bodyComp = (bp.components || []).find((c) => String(c.type).toUpperCase() === 'BODY');
  return {
    name: bp.name,
    category: bp.category || 'UTILITY',
    language: bp.language || 'en',
    components: bp.components || [],
    body: bodyComp?.text || '',
    source: 'order_message_blueprint',
  };
}

module.exports = {
  ORDER_MESSAGE_WA_BLUEPRINTS,
  getOrderMessageBlueprint,
  blueprintToWorkspaceTemplate,
  normalizeTemplateKey,
};
