'use strict';

/**
 * Phase 11 — marketing closure smoke (memory Mongo).
 * - syncOrderBackedCustomersToAdLeads materializes Shopify order customers
 * - maybeAttributeQrConversion increments QR conversions once
 */
const assert = require('assert');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');

async function testSyncOrderBackedCustomersToAdLeads() {
  const Order = require('../../models/Order');
  const AdLead = require('../../models/AdLead');
  const { syncOrderBackedCustomersToAdLeads } = require('../../utils/commerce/leadsAnalyticsFacet');

  const clientId = `p11_sync_${Date.now()}`;
  await Order.create({
    clientId,
    orderId: `ord_${Date.now()}`,
    customerName: 'Priya Sharma',
    customerPhone: '919876543210',
    customerEmail: 'priya@example.com',
    totalPrice: 2499,
    createdAt: new Date(),
  });

  const before = await AdLead.countDocuments({ clientId });
  assert.strictEqual(before, 0);

  const result = await syncOrderBackedCustomersToAdLeads(clientId);
  assert.ok(result.created >= 1, 'expected at least one AdLead created');

  const lead = await AdLead.findOne({ clientId }).lean();
  assert.ok(lead);
  assert.ok(String(lead.phoneNumber || '').includes('9876543210'));
  assert.strictEqual(lead.isOrderPlaced, true);
  assert.ok(Number(lead.ordersCount) >= 1);
  assert.strictEqual(lead.source, 'shopify');

  const again = await syncOrderBackedCustomersToAdLeads(clientId);
  assert.strictEqual(again.created, 0);
}

async function testMaybeAttributeQrConversion() {
  const QRCode = require('../../models/QRCode');
  const QRScan = require('../../models/QRScan');
  const { maybeAttributeQrConversion } = require('../../utils/commerce/qrInboundHandler');

  const clientId = `p11_qr_${Date.now()}`;
  const phone = '9199000111222';
  const shortCode = 'QR_TESTP11';

  const qr = await QRCode.create({
    clientId,
    name: 'Test QR',
    shortCode,
    waLink: 'https://wa.me/123',
  });

  await QRScan.create({
    qrCodeId: qr._id,
    phone,
    scannedAt: new Date(),
  });

  const leadDoc = { meta: { lastQRCode: shortCode } };

  const first = await maybeAttributeQrConversion(clientId, phone, leadDoc);
  assert.strictEqual(first, true);

  const afterFirst = await QRCode.findById(qr._id).lean();
  assert.strictEqual(afterFirst.conversions, 1);

  const second = await maybeAttributeQrConversion(clientId, phone, leadDoc);
  assert.strictEqual(second, false);

  const afterSecond = await QRCode.findById(qr._id).lean();
  assert.strictEqual(afterSecond.conversions, 1);
}

async function main() {
  await startMemoryMongo();
  try {
    await clearCollections();
    await testSyncOrderBackedCustomersToAdLeads();
    await clearCollections();
    await testMaybeAttributeQrConversion();
    console.log('✓ phase11MarketingClosure tests passed');
  } finally {
    await stopMemoryMongo();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
