'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');

describe('marketingConsentPlatform', () => {
  before(async () => {
    await startMemoryMongo();
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('isMarketingAutomationContext detects cart recovery', () => {
    const { isMarketingAutomationContext } = require('../../utils/commerce/marketingConsentPlatform');
    assert.equal(isMarketingAutomationContext({ contextType: 'abandoned_cart' }), true);
    assert.equal(isMarketingAutomationContext({ slotId: 'cart_recovery_1' }), true);
    assert.equal(isMarketingAutomationContext({ contextType: 'order' }), false);
  });

  it('auditConsentHealth reports drift', async () => {
    await clearCollections();
    const AdLead = require('../../models/AdLead');
    const Conversation = require('../../models/Conversation');
    const Client = require('../../models/Client');
    const { auditConsentHealth } = require('../../utils/commerce/marketingConsentPlatform');

    const clientId = `health_${Date.now()}`;
    await Client.create({ clientId, businessName: 'Health Test' });
    await AdLead.create({
      clientId,
      phoneNumber: '919911122233',
      optStatus: 'opted_out',
      channelConsent: { whatsapp: { status: 'opted_out' } },
    });
    await Conversation.create({
      clientId,
      phone: '919911122233',
      status: 'BOT_ACTIVE',
      botPaused: false,
    });

    const health = await auditConsentHealth(clientId);
    assert.ok(health.leadOptedOutConvoActive >= 1);
    assert.ok(health.totalDrift >= 1);
  });

  it('syncConsentStateForClient aligns opted-out conversation', async () => {
    await clearCollections();
    const AdLead = require('../../models/AdLead');
    const Conversation = require('../../models/Conversation');
    const Client = require('../../models/Client');
    const {
      syncConsentStateForClient,
      auditConsentHealth,
    } = require('../../utils/commerce/marketingConsentPlatform');

    const clientId = `sync_${Date.now()}`;
    await Client.create({ clientId, businessName: 'Sync Test' });
    await AdLead.create({
      clientId,
      phoneNumber: '919900011122',
      optStatus: 'opted_out',
      channelConsent: { whatsapp: { status: 'opted_out' } },
    });
    const convo = await Conversation.create({
      clientId,
      phone: '919900011122',
      status: 'BOT_ACTIVE',
      botPaused: false,
      lastInteraction: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    await syncConsentStateForClient(clientId, { dryRun: false });
    const updated = await Conversation.findById(convo._id).lean();
    assert.equal(updated.status, 'OPTED_OUT');
    assert.equal(updated.botPaused, true);

    const health = await auditConsentHealth(clientId);
    assert.equal(health.leadOptedOutConvoActive, 0);
  });
});
