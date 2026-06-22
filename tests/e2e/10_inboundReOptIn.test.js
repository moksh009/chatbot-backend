'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('../helpers/memoryRedis');

describe('10 — inbound re-opt-in after STOP', () => {
  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('executeInboundReOptIn restores opted_in and clears suppression', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const SuppressionList = require('../../models/SuppressionList');
    const Conversation = require('../../models/Conversation');
    const { executeGlobalOptOut } = require('../../utils/commerce/optOutKillSwitch');
    const { executeInboundReOptIn, isLeadOptedOut } = require('../../utils/commerce/inboundReOptInService');

    const clientId = `reopt_${Date.now()}`;
    const phone = '919484607042';
    await Client.create({ clientId, businessName: 'ReOptIn Test' });
    const lead = await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'Re Opt Lead',
      optStatus: 'opted_in',
    });
    const convo = await Conversation.create({
      clientId,
      phone,
      status: 'BOT_ACTIVE',
      botPaused: false,
    });

    const client = await Client.findOne({ clientId }).lean();
    await executeGlobalOptOut({
      client,
      phone,
      source: 'keyword_stop',
      keyword: 'STOP',
      conversationId: convo._id,
      sendConfirmation: false,
    });

    const optedOutLead = await AdLead.findById(lead._id).lean();
    assert.strictEqual(optedOutLead.optStatus, 'opted_out');
    assert.ok(isLeadOptedOut(optedOutLead));

    const suppressionBefore = await SuppressionList.countDocuments({ clientId });
    assert.ok(suppressionBefore >= 1);

    const result = await executeInboundReOptIn({
      client,
      phone,
      lead: optedOutLead,
      convo,
      source: 'inbound_message',
      silent: true,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, false);

    const restored = await AdLead.findById(lead._id).lean();
    assert.strictEqual(restored.optStatus, 'opted_in');
    assert.strictEqual(restored.channelConsent.whatsapp.status, 'opted_in');

    const suppressionAfter = await SuppressionList.countDocuments({ clientId });
    assert.strictEqual(suppressionAfter, 0);

    const restoredConvo = await Conversation.findById(convo._id).lean();
    assert.strictEqual(restoredConvo.status, 'BOT_ACTIVE');
    assert.strictEqual(restoredConvo.botPaused, false);
  });

  it('findLeadByPhone matches +91 variant when convo uses digits-only', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const { findLeadByPhone, executeInboundReOptIn } = require('../../utils/commerce/inboundReOptInService');

    const clientId = `reopt_phone_${Date.now()}`;
    const storedPhone = '+919484607042';
    const inboundPhone = '919484607042';
    await Client.create({ clientId, businessName: 'Phone Variant Test' });
    const lead = await AdLead.create({
      clientId,
      phoneNumber: storedPhone,
      optStatus: 'opted_out',
      channelConsent: { whatsapp: { status: 'opted_out' } },
    });

    const found = await findLeadByPhone(clientId, inboundPhone);
    assert.ok(found);
    assert.equal(String(found._id), String(lead._id));

    const client = await Client.findOne({ clientId }).lean();
    const result = await executeInboundReOptIn({
      client,
      phone: inboundPhone,
      silent: true,
    });
    assert.strictEqual(result.success, true);

    const updated = await AdLead.findById(lead._id).lean();
    assert.strictEqual(updated.optStatus, 'opted_in');
  });

  it('checkConsent allows service intent for opted_out contact', async () => {
    const { checkConsent } = require('../../utils/messaging/checks/checkConsent');
    const contactOut = {
      optStatus: 'opted_out',
      channelConsent: { whatsapp: { status: 'opted_out' } },
    };
    assert.strictEqual(
      checkConsent({ contact: contactOut, channel: 'whatsapp', intent: 'service' }).pass,
      true
    );
    assert.strictEqual(
      checkConsent({ contact: contactOut, channel: 'whatsapp', intent: 'marketing' }).pass,
      false
    );
  });

  it('isUserInitiatedInbound detects text and button replies', async () => {
    const { isUserInitiatedInbound } = require('../../utils/commerce/inboundReOptInService');
    assert.equal(isUserInitiatedInbound({ type: 'text', text: { body: 'hi' } }), true);
    assert.equal(
      isUserInitiatedInbound({
        type: 'interactive',
        interactive: { button_reply: { id: 'menu', title: 'Menu' } },
      }),
      true
    );
    assert.equal(isUserInitiatedInbound({ type: 'unknown' }), false);
  });
});
