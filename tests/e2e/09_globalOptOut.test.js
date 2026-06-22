'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('../helpers/memoryRedis');

describe('09 — STOP / global opt-out', () => {
  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('executeGlobalOptOut sets opted_out and cancels sequences', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const FollowUpSequence = require('../../models/FollowUpSequence');
    const { executeGlobalOptOut } = require('../../utils/commerce/optOutKillSwitch');

    const clientId = `optout_${Date.now()}`;
    const phone = '919988776655';
    await Client.create({ clientId, businessName: 'OptOut Test', flags: { useSendEnvelope: true } });
    const lead = await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'Opt Out Lead',
      optStatus: 'opted_in',
    });
    await FollowUpSequence.create({
      clientId,
      leadId: lead._id,
      phone,
      type: 'abandoned_cart',
      status: 'active',
      steps: [{ type: 'whatsapp', status: 'pending' }],
    });

    const client = await Client.findOne({ clientId }).lean();
    const result = await executeGlobalOptOut({
      client,
      phone,
      source: 'keyword_stop',
      keyword: 'STOP',
      sendConfirmation: false,
    });
    assert.strictEqual(result.success, true);

    const updated = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
    assert.strictEqual(updated.optStatus, 'opted_out');
    assert.strictEqual(updated.channelConsent?.whatsapp?.status, 'opted_out');

    const seq = await FollowUpSequence.findOne({ clientId, leadId: lead._id }).lean();
    assert.strictEqual(seq.status, 'cancelled');
  });

  it('executeGlobalOptOut sends confirmation before suppression write path', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const SuppressionList = require('../../models/SuppressionList');
    const { executeGlobalOptOut } = require('../../utils/commerce/optOutKillSwitch');
    const WhatsApp = require('../../utils/meta/whatsapp');

    const clientId = `optout_confirm_${Date.now()}`;
    const phone = '919877665544';
    await Client.create({ clientId, businessName: 'OptOut Confirm Test' });
    await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'Confirm Lead',
      optStatus: 'opted_in',
    });

    const originalSendText = WhatsApp.sendText;
    let capturedMessage = null;
    try {
      WhatsApp.sendText = async (_client, to, body) => {
        capturedMessage = { to, body };
        return { messages: [{ id: 'wamid.confirm.mock' }] };
      };

      const client = await Client.findOne({ clientId }).lean();
      const result = await executeGlobalOptOut({
        client,
        phone,
        source: 'keyword_stop',
        keyword: 'STOP',
        sendConfirmation: true,
      });

      assert.strictEqual(result.success, true);
      assert.ok(capturedMessage, 'expected STOP confirmation send to be attempted');
      assert.equal(capturedMessage.to, phone);
      assert.match(String(capturedMessage.body || ''), /unsubscribe|subscribed|START|SUBSCRIBE/i);

      const suppression = await SuppressionList.find({ clientId }).lean();
      assert.ok(suppression.length >= 1, 'expected suppression records after confirmation send');
    } finally {
      WhatsApp.sendText = originalSendText;
    }
  });
});
