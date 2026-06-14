'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const { injectMemoryRedis, resetMemoryRedis } = require('../helpers/memoryRedis');

describe('cart recovery order reconcile', () => {
  before(async () => {
    await startMemoryMongo();
    injectMemoryRedis();
  });

  after(async () => {
    resetMemoryRedis();
    await stopMemoryMongo();
  });

  it('reconcileOpenCartLeadsForClient marks lead recovered when Order exists without webhook', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const Order = require('../../models/Order');
    const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');
    const { reconcileOpenCartLeadsForClient } = require('../../utils/commerce/cartRecoveryOrderReconcile');
    const { buildAbandonedCartWorkspace } = require('../../utils/commerce/abandonedCartWorkspace');

    const clientId = `reconcile_${Date.now()}`;
    const phone = '+919313045439';

    await Client.create({ clientId, businessName: 'Reconcile Test' });

    const abandonAt = new Date(Date.now() - 30 * 60 * 1000);
    await AdLead.create({
      clientId,
      phoneNumber: normalizeIndianPhone('9313045439'),
      name: 'Moksh Patel',
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      cartAbandonedAt: abandonAt,
      cartValue: 750,
      checkoutInitiatedCount: 1,
      cartSnapshot: {
        items: [{ title: 'The Collection Snowboard: Liquid', quantity: 1, price: 750 }],
        total_price: 750,
      },
    });

    const orderAt = new Date(Date.now() - 10 * 60 * 1000);
    await Order.create({
      clientId,
      shopifyOrderId: '1005',
      orderId: '#1005',
      orderNumber: '1005',
      customerName: 'Moksh Patel',
      customerPhone: '9313045439',
      totalPrice: 749.95,
      amount: 749.95,
      financialStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      status: 'paid',
      createdAt: orderAt,
    });

    const out = await reconcileOpenCartLeadsForClient(clientId, { since: new Date(Date.now() - 86400000) });
    assert.equal(out.reconciled, 1);

    const lead = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
    assert.equal(lead.isOrderPlaced, true);
    assert.equal(lead.cartStatus, 'purchased');

    const ws = await buildAbandonedCartWorkspace(clientId, { preset: '30d' });
    assert.equal(ws.metrics.recoveredCarts, 1);
    assert.equal(ws.metrics.activeAbandoned, 0);
    assert.ok(ws.metrics.revenueRecovered >= 749);
    assert.equal(ws.rows[0].recoveryStatus.key, 'organic');
  });

  it('reconcileOpenCartLeadsForClient matches Order.customerPhone stored as 91-prefix E.164 digits', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const Order = require('../../models/Order');
    const { normalizeIndianPhone } = require('../../utils/core/normalizeIndianPhone');
    const { reconcileOpenCartLeadsForClient } = require('../../utils/commerce/cartRecoveryOrderReconcile');

    const clientId = `reconcile91_${Date.now()}`;
    const phone = '+919313045439';

    await Client.create({ clientId, businessName: 'Reconcile 91-prefix' });

    const abandonAt = new Date(Date.now() - 45 * 60 * 1000);
    await AdLead.create({
      clientId,
      phoneNumber: normalizeIndianPhone('9313045439'),
      name: 'Moksh Patel',
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      cartAbandonedAt: abandonAt,
      cartValue: 750,
      checkoutInitiatedCount: 1,
    });

    await Order.create({
      clientId,
      shopifyOrderId: '1006',
      orderId: '#1006',
      customerName: 'Moksh Patel',
      customerPhone: '919313045439',
      totalPrice: 749.95,
      amount: 749.95,
      financialStatus: 'paid',
      status: 'paid',
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const out = await reconcileOpenCartLeadsForClient(clientId, { since: new Date(Date.now() - 86400000) });
    assert.equal(out.reconciled, 1);

    const lead = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
    assert.equal(lead.isOrderPlaced, true);
    assert.ok(['purchased', 'recovered'].includes(lead.cartStatus));
  });

  it('reconcileCartRecoveryFromShopifyOrder matches via checkout_token without phone', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const { reconcileCartRecoveryFromShopifyOrder } = require('../../utils/commerce/cartRecoveryOrderReconcile');

    const clientId = `token_reconcile_${Date.now()}`;
    const token = `chk_${Date.now()}`;

    await Client.create({ clientId, businessName: 'Token Test' });
    await AdLead.create({
      clientId,
      phoneNumber: `unknown_checkout_${token}`,
      email: 'buyer@example.com',
      checkoutToken: token,
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      cartAbandonedAt: new Date(Date.now() - 60 * 60 * 1000),
      cartValue: 1200,
    });

    const out = await reconcileCartRecoveryFromShopifyOrder(
      { clientId },
      {
        id: '2001',
        name: '#2001',
        created_at: new Date(),
        total_price: '1200',
        checkout_token: token,
        email: 'buyer@example.com',
        financial_status: 'paid',
      },
      { source: 'test' }
    );

    assert.equal(out.matched, true);
    const lead = await AdLead.findOne({ clientId, checkoutToken: token }).lean();
    assert.equal(lead.isOrderPlaced, true);
    assert.ok(['recovered', 'purchased'].includes(lead.cartStatus));
  });

  it('reconcileOpenCartLeadsForClient matches by email when order has no real phone', async () => {
    await clearCollections();
    const Client = require('../../models/Client');
    const AdLead = require('../../models/AdLead');
    const Order = require('../../models/Order');
    const { reconcileOpenCartLeadsForClient } = require('../../utils/commerce/cartRecoveryOrderReconcile');

    const clientId = `email_reconcile_${Date.now()}`;
    const email = 'rahul@d2cbrand.in';

    await Client.create({ clientId, businessName: 'Email Reconcile' });
    await AdLead.create({
      clientId,
      phoneNumber: 'unknown_email_rahul@d2cbrand.in',
      email,
      cartStatus: 'abandoned',
      isOrderPlaced: false,
      cartAbandonedAt: new Date(Date.now() - 45 * 60 * 1000),
      cartValue: 899,
    });

    await Order.create({
      clientId,
      shopifyOrderId: '3001',
      orderId: '#3001',
      customerEmail: email,
      customerPhone: '0000000000',
      totalPrice: 899,
      amount: 899,
      financialStatus: 'paid',
      status: 'paid',
      createdAt: new Date(Date.now() - 15 * 60 * 1000),
    });

    const out = await reconcileOpenCartLeadsForClient(clientId, {
      since: new Date(Date.now() - 86400000),
    });
    assert.equal(out.reconciled, 1);

    const lead = await AdLead.findOne({ clientId, email }).lean();
    assert.equal(lead.isOrderPlaced, true);
  });
});
