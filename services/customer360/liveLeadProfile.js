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
  dedupeOrders,
  resolveLinkedPhonesForLead,
} = require('../../utils/customer360/leadLookupHelpers');

function identityCacheKey(clientId, lead) {
  const email = String(lead?.email || '').trim().toLowerCase();
  return `c360_orders:${clientId}:${lead?.phoneNumber || ''}:${email}`;
}

async function cachedShopifyOrders(clientId, lead) {
  const phone = lead?.phoneNumber;
  const email = lead?.email;
  const redis = getAppRedis();
  const key = identityCacheKey(clientId, lead);
  if (redis) {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  }
  let shopifyDataStale = false;
  let shopifyOrders = [];
  try {
    const { searchCustomerByPhone, searchCustomerByEmail } = require('../../utils/shopify/shopifyGraphQL');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500));
    const customer = await Promise.race([
      searchCustomerByPhone(clientId, phone),
      timeout,
    ]);
    if (customer?.orders?.edges) {
      shopifyOrders = customer.orders.edges.map((e) => e.node);
    } else if (email) {
      const byEmail = await Promise.race([
        searchCustomerByEmail(clientId, email),
        timeout,
      ]);
      if (byEmail?.orders?.edges) {
        shopifyOrders = byEmail.orders.edges.map((e) => e.node);
      }
    }
  } catch {
    shopifyDataStale = true;
  }

  const dbOrders = await findOrdersForLead(clientId, phone, { limit: 50, email });
  const orders = dedupeOrders([...dbOrders, ...shopifyOrders]);
  const payload = { orders, shopifyDataStale, shopifyOrderCount: shopifyOrders.length };
  if (redis) await redis.set(key, JSON.stringify(payload), 'EX', 60);
  return payload;
}

async function buildLiveLeadPanels(lead) {
  const phone = lead.phoneNumber;
  const clientId = lead.clientId;
  const phoneIn = phoneVariants(phone);
  const linkedPhones = await resolveLinkedPhonesForLead(clientId, phone, lead.email);
  const linkedVariants = collectLinkedVariants(linkedPhones);

  const convo = await Conversation.findOne({
    clientId,
    phone: linkedVariants.length ? { $in: linkedVariants } : phoneIn.length ? { $in: phoneIn } : phone,
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
    cachedShopifyOrders(clientId, lead),
    convo
      ? Message.find({ conversationId: convo._id })
          .sort({ timestamp: -1 })
          .limit(5)
          .select('sentimentScore sentimentLabel content timestamp direction')
          .lean()
      : [],
    FollowUpSequence.find({
      clientId,
      phone: linkedVariants.length ? { $in: linkedVariants } : phoneIn.length ? { $in: phoneIn } : phone,
      status: 'active',
    }).lean(),
    CampaignMessage.find({
      clientId,
      phone: linkedVariants.length ? { $in: linkedVariants } : phoneIn.length ? { $in: phoneIn } : phone,
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
      linkedPhones: linkedPhones.filter((item) => item !== phone),
    },
  };
}

function collectLinkedVariants(phones = []) {
  const variants = new Set();
  for (const phone of phones) {
    for (const variant of phoneVariants(phone)) {
      if (variant) variants.add(variant);
    }
  }
  return [...variants];
}

module.exports = { buildLiveLeadPanels, cachedShopifyOrders };
