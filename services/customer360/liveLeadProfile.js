'use strict';

const Message = require('../../models/Message');
const FollowUpSequence = require('../../models/FollowUpSequence');
const CampaignMessage = require('../../models/CampaignMessage');
const Conversation = require('../../models/Conversation');
const { getAppRedis } = require('../../utils/core/redisFactory');
const { phoneVariants } = require('../../utils/messaging/cancelAllAutomationsFor');
const {
  findOrdersForLead,
  findWarrantyRecordsForLead,
} = require('../../utils/customer360/leadLookupHelpers');

async function cachedShopifyOrders(clientId, phone) {
  const redis = getAppRedis();
  const key = `c360_orders:${clientId}:${phone}`;
  if (redis) {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  }
  let shopifyDataStale = false;
  let orders = [];
  try {
    const { searchCustomerByPhone } = require('../../utils/shopify/shopifyGraphQL');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000));
    const customer = await Promise.race([
      searchCustomerByPhone(clientId, phone),
      timeout,
    ]);
    if (customer?.orders?.edges) {
      orders = customer.orders.edges.slice(0, 3).map((e) => e.node);
    }
  } catch {
    shopifyDataStale = true;
    orders = await findOrdersForLead(clientId, phone, { limit: 5 });
  }
  const payload = { orders, shopifyDataStale };
  if (redis) await redis.set(key, JSON.stringify(payload), 'EX', 60);
  return payload;
}

async function buildLiveLeadPanels(lead) {
  const phone = lead.phoneNumber;
  const clientId = lead.clientId;
  const phoneIn = phoneVariants(phone);
  const convo = await Conversation.findOne({
    clientId,
    phone: phoneIn.length ? { $in: phoneIn } : phone,
  })
    .select('_id')
    .lean();

  const [
    shopifyPanel,
    messages,
    sequences,
    campaigns,
    warrantyPanel,
  ] = await Promise.all([
    cachedShopifyOrders(clientId, phone),
    convo
      ? Message.find({ conversationId: convo._id })
          .sort({ timestamp: -1 })
          .limit(5)
          .select('sentimentScore sentimentLabel content timestamp direction')
          .lean()
      : [],
    FollowUpSequence.find({
      clientId,
      phone: phoneIn.length ? { $in: phoneIn } : phone,
      status: 'active',
    }).lean(),
    CampaignMessage.find({
      clientId,
      phone: phoneIn.length ? { $in: phoneIn } : phone,
      status: { $in: ['queued', 'processing', 'sent'] },
    })
      .limit(10)
      .lean(),
    findWarrantyRecordsForLead(clientId, phone, lead),
  ]);

  return {
    live: {
      shopifyOrders: shopifyPanel.orders,
      shopifyDataStale: shopifyPanel.shopifyDataStale,
      recentMessages: messages,
      activeSequences: sequences,
      activeCampaigns: campaigns,
      warrantyRecords: warrantyPanel.records,
      recentSentimentTrend: lead.recentSentimentTrend,
      scoreBreakdown: lead.scoreBreakdown,
    },
  };
}

module.exports = { buildLiveLeadPanels, cachedShopifyOrders };
