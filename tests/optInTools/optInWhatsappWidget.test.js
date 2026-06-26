'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const OptInTool = require('../../models/OptInTool');
const AdLead = require('../../models/AdLead');
const optInService = require('../../services/optInToolsService');
const { subscribe } = require('../../services/optInSubscribeService');
const { buildWaMeLink } = require('../../utils/optIn/resolveMerchantWaPhone');

const CLIENT = 'optin_wa_tenant';
const EMBED_KEY = 'd'.repeat(48);

describe('optIn whatsapp widget', () => {
  before(async () => {
    await startMemoryMongo();
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('enforceSingleLiveWhatsappWidget keeps only one live widget', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({
      clientId: CLIENT,
      businessName: 'WA Brand',
      shopifyConnected: true,
      shopDomain: 'wa.myshopify.com',
      growthEmbedPublicKey: EMBED_KEY,
      phoneNumber: '+919876543210',
      whatsappDisplayPhoneNumber: '919876543210',
      whatsappConnected: true,
    });

    const first = await optInService.createTool(CLIENT, { type: 'whatsapp_widget', name: 'Widget A' });
    const second = await optInService.createTool(CLIENT, { type: 'whatsapp_widget', name: 'Widget B' });

    await OptInTool.updateOne({ _id: first.id }, { $set: { status: 'live', publishedAt: new Date() } });
    await OptInTool.updateOne({ _id: second.id }, { $set: { status: 'live', publishedAt: new Date() } });

    await optInService.enforceSingleLiveWhatsappWidget(CLIENT, second.id);

    const live = await OptInTool.find({ clientId: CLIENT, type: 'whatsapp_widget', status: 'live' }).lean();
    assert.equal(live.length, 1);
    assert.equal(String(live[0]._id), second.id);
  });

  it('validateToolForPublish requires WA number for whatsapp_widget', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({ clientId: CLIENT, businessName: 'No WA' });
    const tool = await optInService.createTool(CLIENT, { type: 'whatsapp_widget' });
    const doc = await OptInTool.findById(tool.id).lean();
    const client = await Client.findOne({ clientId: CLIENT }).lean();
    const errors = optInService.validateToolForPublish(doc, client);
    assert.ok(errors.some((e) => e.includes('WhatsApp business number')));
  });

  it('subscribe returns waLink for whatsapp_widget', async () => {
    await clearCollections(['Client', 'OptInTool', 'AdLead']);
    await Client.create({
      clientId: CLIENT,
      businessName: 'WA Brand',
      growthEmbedPublicKey: EMBED_KEY,
      growthEmbedEnabled: true,
      whatsappDisplayPhoneNumber: '919876543210',
      whatsappConnected: true,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'WA widget',
      type: 'whatsapp_widget',
      status: 'live',
      design: {
        defaultWhatsAppMessage: 'Hey from store',
        collectPhone: true,
      },
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
    assert.ok(res.waLink);
    assert.match(res.waLink, /^https:\/\/wa\.me\/919876543210/);
    assert.ok(res.waLink.includes('text='));

    const lead = await AdLead.findOne({ clientId: CLIENT }).lean();
    assert.equal(lead.optInSource, 'whatsapp_widget');
  });

  it('buildWaMeLink encodes default message', () => {
    const link = buildWaMeLink({ whatsappDisplayPhoneNumber: '919111222333' }, { defaultWhatsAppMessage: 'Hello there' });
    assert.equal(link, 'https://wa.me/919111222333?text=Hello%20there');
  });
});
