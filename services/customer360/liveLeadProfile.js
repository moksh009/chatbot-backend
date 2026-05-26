'use strict';

const Order = require('../../models/Order');
const Message = require('../../models/Message');
const FollowUpSequence = require('../../models/FollowUpSequence');
const CampaignMessage = require('../../models/CampaignMessage');
const WarrantyRecord = require('../../models/WarrantyRecord');
const Conversation = require('../../models/Conversation');
const { getAppRedis } = require('../../utils/core/redisFactory');

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
    orders = await Order.find({ clientId, phone })
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();
  }
  const payload = { orders, shopifyDataStale };
  if (redis) await redis.set(key, JSON.stringify(payload), 'EX', 60);
  return payload;
}

async function buildLiveLeadPanels(lead) {
  const phone = lead.phoneNumber;
  const clientId = lead.clientId;
  const convo = await Conversation.findOne({ clientId, phone }).select('_id').lean();

  const [
    shopifyPanel,
    messages,
    sequences,
    campaigns,
    warranties,
  ] = await Promise.all([
    cachedShopifyOrders(clientId, phone),
    convo
      ? Message.find({ conversationId: convo._id })
          .sort({ timestamp: -1 })
          .limit(5)
          .select('sentimentScore sentimentLabel content timestamp direction')
          .lean()
      : [],
    FollowUpSequence.find({ clientId, phone, status: 'active' }).lean(),
    CampaignMessage.find({
      clientId,
      phone,
      status: { $in: ['queued', 'processing', 'sent'] },
    })
      .limit(10)
      .lean(),
    WarrantyRecord.find({ clientId, phone }).limit(5).lean(),
  ]);

  return {
    live: {
      shopifyOrders: shopifyPanel.orders,
      shopifyDataStale: shopifyPanel.shopifyDataStale,
      recentMessages: messages,
      activeSequences: sequences,
      activeCampaigns: campaigns,
      warrantyRecords: warranties,
      recentSentimentTrend: lead.recentSentimentTrend,
      scoreBreakdown: lead.scoreBreakdown,
    },
  };
}

module.exports = { buildLiveLeadPanels, cachedShopifyOrders };
