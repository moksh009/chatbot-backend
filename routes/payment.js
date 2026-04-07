const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const logger  = require('../utils/logger')('PaymentWebhook');
const Order   = require('../models/Order');
const Client  = require('../models/Client');
const AdLead  = require('../models/AdLead');
const { processOrderForLoyalty } = require('../utils/walletService');
const { sendWhatsAppText }       = require('../utils/dualBrainEngine');

/**
 * POST /api/payment/razorpay/webhook
 * Handles payment status updates from Razorpay.
 */
router.post('/razorpay/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;

  // 1. Verify Signature
  if (secret && signature) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(JSON.stringify(req.body));
    const digest = hmac.digest('hex');
    if (digest !== signature) {
      logger.warn('Razorpay signature mismatch');
      return res.status(400).send('Invalid signature');
    }
  }

  const event = req.body.event;
  const payload = req.body.payload.payment_link || req.body.payload.payment;
  
  if (!payload) return res.status(200).send('OK');

  const { orderId, clientId } = payload.entity.notes || {};
  if (!orderId) return res.status(200).send('OK');

  logger.info(`Payment event: ${event} for Order: ${orderId}`);

  try {
    if (event === 'payment_link.paid' || event === 'payment.captured') {
      // 2. Update Order Status
      const order = await Order.findByIdAndUpdate(orderId, {
        $set: { 
          status: 'paid',
          paymentStatus: 'captured',
          paidAt: new Date(),
          razorpayPaymentId: payload.entity.id
        }
      }, { new: true });

      if (order) {
        const client = await Client.findById(clientId).lean();
        const lead   = await AdLead.findOne({ phoneNumber: order.customerPhone, clientId: client._id });

        // 3. Award Loyalty Points
        if (client?.loyaltyConfig?.isEnabled) {
          await processOrderForLoyalty(client.clientId, order.customerPhone, order.totalPrice || order.amount, order.orderNumber || orderId);
        }

        // 4. Send WhatsApp Confirmation
        const confirmMsg = `✅ *Payment Confirmed!*\n\nThank you, we've received your payment of ₹${order.totalPrice || order.amount} for Order #${order.orderNumber || orderId}. We are now processing your shipment. 📦`;
        await sendWhatsAppText(client, order.customerPhone, confirmMsg);
        
        // 5. Notify Dashboard
        const io = global.io;
        if (io) io.to(`client_${client.clientId}`).emit('payment_received', { orderId, phone: order.customerPhone });
      }
    } else if (event === 'payment_link.expired' || event === 'payment.failed') {
      await Order.findByIdAndUpdate(orderId, { $set: { status: 'payment_failed' } });
    }

    res.status(200).send('OK');
  } catch (err) {
    logger.error('[PaymentWebhook] Processing error:', err.message);
    res.status(500).send('Internal Error');
  }
});

module.exports = router;
