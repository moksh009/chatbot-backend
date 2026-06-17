'use strict';

const Order = require('../../models/Order');
const { isLeadOptedOutForSend } = require('./marketingConsent');
const { resolveAttributionWindowHours } = require('../../constants/cartRecoveryDefaults');

/**
 * Decide whether a cart recovery send should be skipped for this lead.
 * BUG-016: stop messaging after order placed / recovered / recent purchase.
 */
async function shouldSuppressCartSend(client, lead, config = {}) {
  if (!lead) return { suppress: true, reason: 'missing_lead' };

  if (lead.isOrderPlaced === true) {
    return { suppress: true, reason: 'order_placed' };
  }

  const status = String(lead.cartStatus || '').toLowerCase();
  if (['purchased', 'recovered', 'failed'].includes(status)) {
    return { suppress: true, reason: `cart_status_${status}` };
  }

  if (lead.suppressRecovery === true) {
    return { suppress: true, reason: 'manual_suppress' };
  }

  const phone = lead.phoneNumber;
  if (phone && !/^unknown_/i.test(String(phone))) {
    if (await isLeadOptedOutForSend(client.clientId, phone)) {
      return { suppress: true, reason: 'opted_out' };
    }
  }

  const attributionHours = resolveAttributionWindowHours(config.attributionWindowHours);
  if (attributionHours > 0 && phone && !/^unknown_/i.test(String(phone))) {
    const since = new Date(Date.now() - attributionHours * 60 * 60 * 1000);
    const recentOrder = await Order.findOne({
      clientId: client.clientId,
      phone: String(phone).replace(/\D/g, '').slice(-10),
      createdAt: { $gte: since },
    })
      .select('_id')
      .lean();
    if (recentOrder) {
      return { suppress: true, reason: 'recent_order' };
    }
  }

  return { suppress: false, reason: null };
}

module.exports = { shouldSuppressCartSend };
