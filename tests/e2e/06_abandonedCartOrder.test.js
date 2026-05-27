'use strict';

/**
 * Abandoned cart → order placed cancels sequences (memory Mongo).
 * Mirrors phase2E2eSmoke revenue pipeline.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('../helpers/memoryRedis');

describe('06 — abandoned cart order lifecycle', () => {
  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('order webhook marks purchased via checkout_token match and cancels active sequence', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const FollowUpSequence = require('../../models/FollowUpSequence');
    const { handleOrderAtomic } = require('../../utils/shopify/handleOrderAtomic');

    const clientId = `cart_${Date.now()}`;
    const phone = '+919900011133';
    await Client.create({
      clientId,
      businessName: 'Cart E2E',
      flags: { useSendEnvelope: true },
    });

    const lead = await AdLead.create({
      clientId,
      phoneNumber: '919988776644',
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      checkoutToken: 'tok_e2e',
      recoveryStep: 1,
    });

    const seq = await FollowUpSequence.create({
      clientId,
      leadId: lead._id,
      phone,
      type: 'abandoned_cart',
      status: 'active',
      steps: [{ type: 'whatsapp', status: 'pending' }],
    });

    const client = await Client.findOne({ clientId }).lean();
    const out = await handleOrderAtomic(
      client,
      {
        id: `ord_${Date.now()}`,
        created_at: new Date().toISOString(),
        checkout_token: 'tok_e2e',
        total_price: '1999.00',
      },
      phone
    );
    assert.strictEqual(out.lead.isOrderPlaced, true);
    assert.strictEqual(out.lead.cartStatus, 'purchased');
    assert.strictEqual(out.lead.recoveredViaWhatsApp, true);

    const seqAfter = await FollowUpSequence.findById(seq._id).lean();
    assert.strictEqual(seqAfter.status, 'cancelled');
  });
});
