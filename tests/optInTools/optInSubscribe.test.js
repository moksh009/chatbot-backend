'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const OptInTool = require('../../models/OptInTool');
const { subscribe, capturePhone } = require('../../services/optInSubscribeService');

const CLIENT = 'optin_sub_tenant';
const EMBED_KEY = 'c'.repeat(48);

describe('optInSubscribeService', () => {
  let toolId;

  before(async () => {
    await startMemoryMongo();
    await Client.create({
      clientId: CLIENT,
      businessName: 'Test Brand',
      growthEmbedPublicKey: EMBED_KEY,
      growthEmbedEnabled: true,
      shopifyConnected: false,
      whatsappConnected: false,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Welcome popup',
      type: 'popup',
      status: 'live',
      design: {
        discount: { mode: 'manual', manualCode: 'WELCOME10' },
      },
      sendWhatsAppWelcome: false,
    });
    toolId = String(tool._id);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('rejects subscribe without consent', async () => {
    const res = await subscribe({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: false,
      toolId,
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 400);
  });

  it('creates AdLead with channelConsent.whatsapp on subscribe', async () => {
    await clearCollections(['AdLead']);
    const res = await subscribe({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: true,
      toolId,
      visitorId: 'v_test_visitor_1',
      pageUrl: 'https://shop.test/products',
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, true);
    assert.equal(res.couponCode, 'WELCOME10');
    const lead = await AdLead.findOne({ clientId: CLIENT, phoneNumber: '+919876543210' }).lean();
    assert.ok(lead);
    assert.equal(lead.optInSource, 'website_popup');
    assert.equal(lead.channelConsent.whatsapp.status, 'opted_in');
    assert.equal(lead.capturedData.visitorId, 'v_test_visitor_1');
  });

  it('blocks re-opt-in for opted_out leads', async () => {
    await AdLead.updateOne(
      { clientId: CLIENT, phoneNumber: '+919876543210' },
      {
        $set: {
          optStatus: 'opted_out',
          'channelConsent.whatsapp.status': 'opted_out',
        },
      }
    );
    const res = await subscribe({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: true,
      toolId,
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, false);
    assert.equal(res.status, 403);
  });

  it('capture-phone requires consent', async () => {
    const res = await capturePhone({
      embedKey: EMBED_KEY,
      phone: '9123456789',
      consent: false,
      toolId,
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, false);
  });
});
