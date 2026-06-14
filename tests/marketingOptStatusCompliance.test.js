'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('./helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('./helpers/memoryRedis');
const {
  isManualReOptInBlocked,
  canAutomatedKeywordOptIn,
  buildManualOptStatusHistoryEntry,
  buildKeywordOptInSetFields,
  buildOrderPlacedOptInSetFields,
  buildCsvImportOptInSetFields,
  markLeadOptOutFromSendFailure,
} = require('../utils/commerce/marketingOptStatusRules');

describe('marketing opt-status compliance rules', () => {
  it('blocks manual opted_out -> opted_in transitions only', () => {
    assert.equal(isManualReOptInBlocked('opted_out', 'opted_in'), true);
    assert.equal(isManualReOptInBlocked('opted_in', 'opted_out'), false);
    assert.equal(isManualReOptInBlocked('unknown', 'opted_in'), false);
    assert.equal(isManualReOptInBlocked('opted_out', 'opted_out'), false);
  });

  it('allows customer keyword opt-in from opted_out', () => {
    assert.equal(canAutomatedKeywordOptIn('opted_out'), true);
    assert.equal(canAutomatedKeywordOptIn('unknown'), true);
    assert.equal(canAutomatedKeywordOptIn('pending'), true);
    assert.equal(canAutomatedKeywordOptIn('opted_in'), true);
  });

  it('buildKeywordOptInSetFields restores opted_in marketing posture', () => {
    const fields = buildKeywordOptInSetFields();
    assert.equal(fields.optStatus, 'opted_in');
    assert.equal(fields.whatsappMarketingEligible, true);
    assert.equal(fields['channelConsent.whatsapp.status'], 'opted_in');
  });

  it('buildManualOptStatusHistoryEntry returns admin audit row', () => {
    const row = buildManualOptStatusHistoryEntry('opted_out');
    assert.equal(row.event, 'opted_out');
    assert.equal(row.source, 'admin_manual');
  });

  it('buildCsvImportOptInSetFields marks contacts opted_in', () => {
    const fields = buildCsvImportOptInSetFields();
    assert.equal(fields.optStatus, 'opted_in');
    assert.equal(fields.optInSource, 'csv_import');
    assert.equal(fields.whatsappMarketingEligible, true);
  });

  it('buildOrderPlacedOptInSetFields opts in unless already opted_out', () => {
    const fields = buildOrderPlacedOptInSetFields('unknown');
    assert.equal(fields.optStatus, 'opted_in');
    assert.equal(fields.optInSource, 'shopify_order');
    assert.deepEqual(buildOrderPlacedOptInSetFields('opted_out'), {});
  });
});

describe('marketing opt-status persistence', () => {
  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('executeGlobalOptOut writes opted_out status and optInHistory immediately', async () => {
    await clearCollections();
    const Client = require('../models/Client');
    const AdLead = require('../models/AdLead');
    const { executeGlobalOptOut } = require('../utils/commerce/optOutKillSwitch');

    const clientId = `opt_hist_${Date.now()}`;
    const phone = '919911223344';
    await Client.create({ clientId, businessName: 'History Test' });
    await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'History Lead',
      optStatus: 'opted_in',
    });

    const client = await Client.findOne({ clientId }).lean();
    await executeGlobalOptOut({
      client,
      phone,
      source: 'keyword_stop',
      keyword: 'STOP',
      sendConfirmation: false,
    });

    const updated = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
    assert.equal(updated.optStatus, 'opted_out');
    assert.ok(Array.isArray(updated.optInHistory) && updated.optInHistory.length >= 1);
    assert.equal(updated.optInHistory[0].event, 'opted_out');
  });

  it('keyword opt-in restores opted_out lead to opted_in', async () => {
    await clearCollections();
    const AdLead = require('../models/AdLead');
    const clientId = `reopt_${Date.now()}`;
    const phone = '919900887766';

    await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'Opted Out Lead',
      optOutDate: new Date(),
      optOutSource: 'keyword_stop',
      channelConsent: {
        whatsapp: { status: 'opted_out', source: 'stop_keyword', timestamp: new Date() },
      },
    });

    const updated = await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId },
      {
        $set: buildKeywordOptInSetFields(),
        $push: {
          optInHistory: {
            event: 'opted_in',
            action: 're_opted_in',
            source: 'user_keyword',
            timestamp: new Date(),
          },
        },
      },
      { new: true }
    );

    assert.equal(updated.optStatus, 'opted_in');
    assert.equal(updated.whatsappMarketingEligible, true);
  });

  it('delivery failure marks lead as opted_out', async () => {
    await clearCollections();
    const AdLead = require('../models/AdLead');
    const clientId = `fail_${Date.now()}`;
    const phone = '919922334455';

    await AdLead.create({
      clientId,
      phoneNumber: phone,
      name: 'Send Fail Lead',
      optStatus: 'opted_in',
    });

    await markLeadOptOutFromSendFailure({
      clientId,
      phone,
      errorMessage: '131026 recipient unavailable',
    });

    const updated = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
    assert.equal(updated.optStatus, 'opted_out');
    assert.equal(updated.optOutSource, 'delivery_failed');
  });
});
