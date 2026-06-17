'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInboundButtonMessage,
  buildLastOutboundTemplateMetadata,
  resolveTemplateButtonAction,
} = require('../../utils/messaging/templateButtonResolver');

test('normalizeInboundButtonMessage copies button.text to text.body', () => {
  const msg = { type: 'button', button: { text: 'Track order' } };
  normalizeInboundButtonMessage(msg);
  assert.equal(msg.text.body, 'Track order');
});

test('buildLastOutboundTemplateMetadata shapes routing blob', () => {
  const meta = buildLastOutboundTemplateMetadata({
    templateName: 'order_shipped',
    messageId: 'wamid.123',
    buttons: [{ id: 'track', label: 'Track order' }],
  });
  assert.equal(meta.lastOutboundTemplate.templateName, 'order_shipped');
  assert.equal(meta.lastOutboundTemplate.wamid, 'wamid.123');
  assert.equal(meta.lastOutboundTemplate.buttons.length, 1);
});

test('resolveTemplateButtonAction returns null without conversation context', async () => {
  const action = await resolveTemplateButtonAction({
    client: { clientId: 't1' },
    convo: null,
    parsedMessage: { interactive: { button_reply: { id: 'track' } } },
  });
  assert.equal(action, null);
});
