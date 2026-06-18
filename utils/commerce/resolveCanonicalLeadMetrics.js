'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const {
  findOrdersForLead,
  resolveLinkedPhonesForLead,
  summarizeOrders,
  normalizeEmail,
  buildEmailRegex,
} = require('../customer360/leadLookupHelpers');
const {
  normalizeLeadForDisplay,
  computeAov,
} = require('./leadDisplayNormalize');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');

const DEFAULT_LEAD_SELECT =
  'name email phoneNumber leadScore scoreLabel intentState cartStatus tags source totalSpent lifetimeValue ordersCount lastInteraction isOrderPlaced cartSnapshot addToCartCount checkoutInitiatedCount importBatchId meta warrantyRecords scoringEngine lastScoredAt inboundMessageCount lastInboundAt chatSummary lastMessageContent optStatus channelConsent';

/**
 * Resolve AdLead for a conversation phone. When multiple leads share an email,
 * pick the row with the highest waterfall score (then ordersCount).
 */
async function findBestLeadForConversationPhone(tenantId, phone, selectFields = DEFAULT_LEAD_SELECT) {
  const clean = String(phone || '').replace(/\D/g, '');
  const suffix = clean.length >= 10 ? clean.slice(-10) : clean;
  const base = { clientId: tenantId };

  const tryOne = async (pn) => {
    if (!pn) return null;
    return AdLead.findOne({ ...base, phoneNumber: pn }).select(selectFields).maxTimeMS(8000).lean();
  };

  let lead = await tryOne(phone);
  if (!lead && clean && clean !== String(phone)) lead = await tryOne(clean);
  if (!lead && suffix) lead = await tryOne(suffix);
  if (!lead && clean.length >= 12 && clean.startsWith('91')) lead = await tryOne(clean.slice(2));

  let email = normalizeEmail(lead?.email);
  if (!email && phone) {
    const variants = phoneVariants(phone);
    const orderHint = await Order.findOne({
      clientId: tenantId,
      $or: [
        { phone: { $in: variants } },
        { customerPhone: { $in: variants } },
        ...(suffix
          ? [
              { phone: { $regex: `${suffix}$` } },
              { customerPhone: { $regex: `${suffix}$` } },
            ]
          : []),
      ],
    })
      .select('customerEmail email')
      .sort({ createdAt: -1 })
      .lean();
    email = normalizeEmail(orderHint?.customerEmail || orderHint?.email);
  }

  const emailRegex = buildEmailRegex(email);
  if (emailRegex) {
    const siblings = await AdLead.find({
      clientId: tenantId,
      email: emailRegex,
    })
      .select(selectFields)
      .limit(40)
      .maxTimeMS(5000)
      .lean();

    if (siblings.length) {
      const ranked = [...siblings].sort((a, b) => {
        const scoreDiff = (Number(b.leadScore) || 0) - (Number(a.leadScore) || 0);
        if (scoreDiff !== 0) return scoreDiff;
        return (Number(b.ordersCount) || 0) - (Number(a.ordersCount) || 0);
      });
      const best = ranked[0];
      if (!lead || (Number(best.leadScore) || 0) >= (Number(lead.leadScore) || 0)) {
        lead = best;
      }
    }
  }

  return lead;
}

/**
 * Canonical per-lead metrics — same commerce + waterfall score semantics as
 * Audience (`enrichLeadRow`) and Customer 360 (`/analytics/lead/:id`).
 */
async function resolveCanonicalLeadMetrics(clientId, phone, options = {}) {
  const {
    selectFields = DEFAULT_LEAD_SELECT,
    orderLimit = 50,
    lead: existingLead = null,
    orders: prefetchedOrders = null,
    includeLinkedPhones = true,
    skipLinkedOrderLookup = false,
  } = options;

  const lead =
    existingLead ||
    (phone ? await findBestLeadForConversationPhone(clientId, phone, selectFields) : null);

  const phoneForOrders = lead?.phoneNumber || phone;
  const orders =
    Array.isArray(prefetchedOrders) && prefetchedOrders.length
      ? prefetchedOrders
      : phoneForOrders
        ? await findOrdersForLead(clientId, phoneForOrders, {
            email: lead?.email,
            limit: orderLimit,
            skipLinkedLookup: skipLinkedOrderLookup,
          })
        : [];

  const orderSummary = summarizeOrders(orders);
  const linkedPhones =
    includeLinkedPhones && phoneForOrders
      ? await resolveLinkedPhonesForLead(clientId, phoneForOrders, lead?.email)
      : [];

  let displayLead = lead
    ? normalizeLeadForDisplay({ ...lead }, { orders: orderSummary.orders })
    : null;

  if (displayLead) {
    displayLead.ltv = orderSummary.totalSpent;
    displayLead.lifetimeValue = orderSummary.totalSpent;
    displayLead.stageName = displayLead.scoreLabel || displayLead.intentState || 'Cold Lead';
  }

  const leadScore = Number(displayLead?.leadScore ?? lead?.leadScore ?? 0) || 0;
  const scoreLabel =
    String(displayLead?.scoreLabel || lead?.scoreLabel || '').trim() ||
    String(displayLead?.intentState || lead?.intentState || '').trim() ||
    'Cold Lead';
  const totalSpent = orderSummary.totalSpent;
  const ordersCount = orderSummary.ordersCount;
  const displayAov =
    displayLead?.displayAov ??
    computeAov({ ordersCount, totalSpent, lifetimeValue: totalSpent });

  return {
    lead: displayLead,
    leadId: displayLead?._id || lead?._id || null,
    leadScore,
    scoreLabel,
    stageName: scoreLabel,
    intentState: displayLead?.intentState || lead?.intentState || null,
    ltv: totalSpent,
    lifetimeValue: totalSpent,
    totalSpent,
    ordersCount,
    displayAov,
    lastPurchaseDate: orderSummary.lastPurchaseDate || displayLead?.lastPurchaseDate || null,
    orders: orderSummary.orders,
    linkedPhones,
    orderSummary,
  };
}

module.exports = {
  DEFAULT_LEAD_SELECT,
  findBestLeadForConversationPhone,
  resolveCanonicalLeadMetrics,
};
