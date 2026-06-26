'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const OptInTool = require('../../models/OptInTool');
const { subscribe } = require('../../services/optInSubscribeService');

const CLIENT = 'optin_spin_extra_tenant';
const EMBED_KEY = 'e'.repeat(48);

describe('optIn spin extra fields', () => {
  let toolId;

  before(async () => {
    await startMemoryMongo();
    await Client.create({
      clientId: CLIENT,
      businessName: 'Spin Brand',
      growthEmbedPublicKey: EMBED_KEY,
      growthEmbedEnabled: true,
      shopifyConnected: false,
      whatsappConnected: false,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Spin',
      type: 'spin_wheel',
      status: 'live',
      design: {
        collectName: true,
        collectEmail: true,
        collectDob: true,
      },
      prizes: [
        { label: '10% off', couponMode: 'fixed', couponCode: 'SPIN10', probability: 100 },
      ],
      sendWhatsAppWelcome: false,
    });
    toolId = String(tool._id);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('stores optional name, email, and DOB on subscribe', async () => {
    await clearCollections(['AdLead']);
    const res = await subscribe({
      embedKey: EMBED_KEY,
      phone: '9876543210',
      consent: true,
      toolId,
      name: 'Priya Sharma',
      email: 'priya@example.com',
      dateOfBirth: '1995-08-15',
      req: { headers: {}, ip: '127.0.0.1' },
    });
    assert.equal(res.success, true);
    const lead = await AdLead.findOne({ clientId: CLIENT, phoneNumber: '+919876543210' }).lean();
    assert.equal(lead.name, 'Priya Sharma');
    assert.equal(lead.email, 'priya@example.com');
    assert.equal(lead.capturedData.dateOfBirth, '1995-08-15');
  });
});
