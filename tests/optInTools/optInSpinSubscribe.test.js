'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const OptInTool = require('../../models/OptInTool');
const { subscribe } = require('../../services/optInSubscribeService');

const CLIENT = 'optin_spin_tenant';
const EMBED_KEY = 'e'.repeat(48);

const PRIZES = [
  { label: '10% off', couponMode: 'unique', probability: 50, discountValue: 10, autoCreateOnShopify: false },
  { label: 'Lose', couponMode: 'lose', probability: 50 },
];

describe('optIn spin subscribe', () => {
  before(async () => {
    await startMemoryMongo();
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('subscribe stores spinWheelCode and prize on AdLead', async () => {
    await clearCollections(['Client', 'OptInTool', 'AdLead']);
    await Client.create({
      clientId: CLIENT,
      businessName: 'Spin Brand',
      growthEmbedPublicKey: EMBED_KEY,
      growthEmbedEnabled: true,
      sendWhatsAppWelcome: false,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Spin wheel',
      type: 'spin_wheel',
      status: 'live',
      prizes: PRIZES,
      sendWhatsAppWelcome: false,
    });

    const res = await subscribe({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: true,
      toolId: String(tool._id),
      req: { headers: {}, ip: '127.0.0.1' },
    });

    assert.equal(res.success, true);
    assert.ok(res.prize);
    assert.equal(typeof res.prize.isLose, 'boolean');

    const lead = await AdLead.findOne({ clientId: CLIENT }).lean();
    assert.equal(lead.optInSource, 'spin_wheel');
    assert.equal(lead.channelConsent.whatsapp.status, 'opted_in');
    if (!res.prize.isLose) {
      assert.ok(lead.spinWheelCode);
      assert.equal(lead.spinWheelCode, res.couponCode);
    }
  });
});
