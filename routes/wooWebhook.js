const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const Order = require('../models/Order');
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
