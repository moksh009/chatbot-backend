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

    const seq = await FollowUpSequence.findOne({ clientId, leadId: lead._id }).lean();
    assert.strictEqual(seq.status, 'cancelled');
  });
});
