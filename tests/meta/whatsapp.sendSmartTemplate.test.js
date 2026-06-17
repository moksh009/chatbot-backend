'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WhatsApp = require('../../utils/meta/whatsapp');

test('sendSmartTemplate throws when URL button params are missing', async () => {
  const client = {
    clientId: 'c1',
    syncedMetaTemplates: [
      {
        name: 'promo_with_url',
        components: [
          { type: 'BODY', text: 'Hi {{1}}' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] },
        ],
      },
    ],
  };

  await assert.rejects(
    () => WhatsApp.sendSmartTemplate(client, '919999999999', 'promo_with_url', ['Moksh']),
    /requires 1 URL button parameter\(s\), but only 0 provided/i
  );
});

test('sendSmartTemplate maps URL button params into template components', async () => {
  const client = {
    clientId: 'c1',
    syncedMetaTemplates: [
      {
        name: 'promo_with_url',
        components: [
          { type: 'BODY', text: 'Hi {{1}}' },
          { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] },
        ],
      },
    ],
  };

  const originalSendTemplate = WhatsApp.sendTemplate;
  try {
    let sentComponents = null;
    WhatsApp.sendTemplate = async (_client, _phone, _name, _lang, components) => {
      sentComponents = components;
      return { messages: [{ id: 'wamid.mock' }] };
    };

    const res = await WhatsApp.sendSmartTemplate(
      client,
      '919999999999',
      'promo_with_url',
      ['Moksh', 'promo-123']
    );

    assert.equal(res.messages[0].id, 'wamid.mock');
    const urlButton = sentComponents.find((c) => c.type === 'button' && c.sub_type === 'url');
    assert.ok(urlButton, 'expected URL button component to be generated');
    assert.equal(urlButton.parameters[0].text, 'promo-123');
  } finally {
    WhatsApp.sendTemplate = originalSendTemplate;
  }
});
