'use strict';

const assert = require('assert');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');

async function testIdempotentAttribution() {
  const Campaign = require('../../models/Campaign');
  const CampaignMessage = require('../../models/CampaignMessage');
  const CampaignRevenueAttribution = require('../../models/CampaignRevenueAttribution');
  const { attributeRevenueToCampaign } = require('../../utils/commerce/campaignStatsHelper');

  const clientId = `attr_${Date.now()}`;
  const phone = '919899887766';
  const campaign = await Campaign.create({
    clientId,
    name: 'Campaign A',
    status: 'COMPLETED',
  });
  await CampaignMessage.create({
    clientId,
    campaignId: campaign._id,
    phone,
    status: 'sent',
    sentAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  const order = {
    clientId,
    orderId: `ORD_${Date.now()}`,
    customerPhone: phone,
    totalPrice: 1200,
    createdAt: new Date(),
  };

  await attributeRevenueToCampaign(order, null);
  await attributeRevenueToCampaign(order, null);

  const fresh = await Campaign.findById(campaign._id).lean();
  assert.strictEqual(Number(fresh.revenueAttributed || 0), 1200);
  assert.strictEqual(Number(fresh.attributedOrders || 0), 1);

  const rows = await CampaignRevenueAttribution.find({ clientId }).lean();
  assert.strictEqual(rows.length, 1);
}

async function testReassignAttributionToNewLastTouch() {
  const Campaign = require('../../models/Campaign');
  const CampaignMessage = require('../../models/CampaignMessage');
  const { attributeRevenueToCampaign } = require('../../utils/commerce/campaignStatsHelper');

  const clientId = `attr_reassign_${Date.now()}`;
  const phone = '919855554444';
  const campaignA = await Campaign.create({
    clientId,
    name: 'Campaign A',
    status: 'COMPLETED',
  });
  const campaignB = await Campaign.create({
    clientId,
    name: 'Campaign B',
    status: 'COMPLETED',
  });

  const now = Date.now();
  await CampaignMessage.create({
    clientId,
    campaignId: campaignA._id,
    phone,
    status: 'delivered',
    sentAt: new Date(now - 4 * 60 * 60 * 1000),
  });

  const order = {
    clientId,
    orderId: `ORD_REASSIGN_${Date.now()}`,
    customerPhone: phone,
    totalPrice: 900,
    createdAt: new Date(now),
  };
  await attributeRevenueToCampaign(order, null);

  await CampaignMessage.create({
    clientId,
    campaignId: campaignB._id,
    phone,
    status: 'read',
    sentAt: new Date(now - 2 * 60 * 60 * 1000),
  });
  await attributeRevenueToCampaign(order, null);

  const freshA = await Campaign.findById(campaignA._id).lean();
  const freshB = await Campaign.findById(campaignB._id).lean();
  assert.strictEqual(Number(freshA.revenueAttributed || 0), 0);
  assert.strictEqual(Number(freshA.attributedOrders || 0), 0);
  assert.strictEqual(Number(freshB.revenueAttributed || 0), 900);
  assert.strictEqual(Number(freshB.attributedOrders || 0), 1);
}

async function main() {
  await startMemoryMongo();
  try {
    await clearCollections();
    await testIdempotentAttribution();
    await clearCollections();
    await testReassignAttributionToNewLastTouch();
    console.log('✓ campaignRevenueAttribution tests passed');
  } finally {
    await stopMemoryMongo();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
