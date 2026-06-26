'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const OptInTool = require('../../models/OptInTool');
const { capturePhone } = require('../../services/optInSubscribeService');

const CLIENT = 'optin_capture_tenant';
const EMBED_KEY = 'd'.repeat(48);

describe('optIn capturePhone', () => {
  let toolId;

  before(async () => {
    await startMemoryMongo();
    await Client.create({
      clientId: CLIENT,
      businessName: 'Capture Brand',
      growthEmbedPublicKey: EMBED_KEY,
      growthEmbedEnabled: true,
      shopifyConnected: false,
      whatsappConnected: false,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Popup',
      type: 'popup',
      status: 'live',
      design: {},
      sendWhatsAppWelcome: false,
    });
    toolId = String(tool._id);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('creates partial AdLead with channelConsent on debounced capture', async () => {
    await clearCollections(['AdLead']);
    const res = await capturePhone({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: true,
      toolId,
      visitorId: 'v_capture_1',
      pageUrl: 'https://shop.test',
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, true);
    assert.equal(res.status, 'captured');
    const lead = await AdLead.findOne({ clientId: CLIENT, phoneNumber: '+919876543210' }).lean();
    assert.ok(lead);
    assert.equal(lead.channelConsent.whatsapp.status, 'opted_in');
    assert.equal(lead.capturedData.visitorId, 'v_capture_1');
    assert.equal(lead.optInHistory[0].action, 'capture_phone');
  });

  it('rejects capture without consent', async () => {
    const res = await capturePhone({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: false,
      toolId,
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, false);
  });

  it('rejects invalid phone before DB write', async () => {
    const res = await capturePhone({
      embedKey: EMBED_KEY,
      phone: '12345',
      consent: true,
      toolId,
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 400);
  });
});
