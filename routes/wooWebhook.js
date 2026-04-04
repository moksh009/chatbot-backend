const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const { saveInboundMessage } = require('../utils/dualBrainEngine');
const log = require('../utils/logger')('WooWebhook');

/**
 * URL: /api/woocommerce/webhook/:clientId
 */
router.post('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const topic = req.headers['x-wc-webhook-topic'];
  const payload = req.body;

  log.info(`WooCommerce webhook received [${topic}] for ${clientId}`);

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).send('Client not found');

    if (topic === 'order.created' || topic === 'order.updated') {
        const status = payload.status;
        const phone = payload.billing?.phone?.replace(/\D/g, '');
        const email = payload.billing?.email?.toLowerCase();

        // Abandonment Check
        if (status === 'pending' || status === 'on-hold') {
            const query = { clientId };
            if (phone) query.phoneNumber = phone;
            else if (email) query.email = email;

            const lead = await AdLead.findOne(query);
            if (lead) {
                lead.cartStatus = 'abandoned';
                lead.addToCartCount = (lead.addToCartCount || 0) + 1;
                lead.lastCartEventAt = new Date();
                lead.isOrderPlaced = false;
                await lead.save();
                log.info(`[WooParity] checkout_started detected for ${lead.phoneNumber}`);
            }
        }
    }

    if (topic === 'action.woocommerce_checkout_order_processed' || topic === 'order.created') {

       // Save to Order model
       const order = await Order.findOneAndUpdate(
         { orderId: payload.id.toString(), clientId },
         {
           $set: {
             orderNumber: (payload.number || payload.id).toString(),
             customerPhone: payload.billing?.phone || '',
             customerEmail: payload.billing?.email || '',
             totalPrice: payload.total,
             currency: payload.currency,
             paymentStatus: payload.status === 'pending' ? 'unpaid' : 'paid',
             fulfillmentStatus: 'unfulfilled',
             source: 'woocommerce'
           }
         },
         { upsert: true, new: true }
        );

        // ── Phase 23: E-commerce Parity (Deep Attribution) ──
        const phone = payload.billing?.phone?.replace(/\D/g, '');
        const email = payload.billing?.email?.toLowerCase();

        if (phone || email) {
          const query = { clientId };
          if (phone) query.phoneNumber = phone;
          else if (email) query.email = email;

          const lead = await AdLead.findOne(query);
          if (lead) {
            lead.commerceEvents = lead.commerceEvents || [];
            lead.commerceEvents.push({
               event: 'checkout_completed',
               amount: parseFloat(payload.total),
               currency: payload.currency,
               timestamp: new Date(),
               metadata: { order_id: payload.id, method: payload.payment_method }
            });
            lead.ordersCount = (lead.ordersCount || 0) + 1;
            lead.totalSpent = (lead.totalSpent || 0) + parseFloat(payload.total);
            lead.isOrderPlaced = true;
            lead.cartStatus = 'purchased';
            await lead.save();
            log.info(`[WooParity] order.completed tracked for Lead ${lead._id}`);
          }
        }

        // Check if COD
        if (payload.payment_method === 'cod') {
          log.info(`COD Order detected for ${clientId}. Preparing nudge sequence.`);
          // Logic for COD nudge would be triggered here or via cron
       }
    }

    res.status(200).send('OK');
  } catch (err) {
    log.error('WooCommerce Webhook Processing Error', { error: err.message });
    res.status(500).send('Internal Error');
  }
});

module.exports = router;
