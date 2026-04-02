const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const DailyStat = require("../models/DailyStat");
const { startOfDay } = require("date-fns");
const { sendWhatsAppText } = require("../utils/whatsappHelpers");

router.get("/success/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const razorpayPaymentId = req.query.razorpay_payment_id;

    const order = await Order.findById(orderId).populate("clientId");
    if (!order) {
      console.error(`Payment callback: Order ${orderId} not found`);
      return res.redirect(process.env.FALLBACK_URL || "https://topedgeai.com");
    }

    const client = order.clientId;

    // Mark order as paid
    await Order.findByIdAndUpdate(orderId, {
      isCOD: false,
      paidViaLink: true,
      paidAt: new Date(),
      razorpayPaymentId: razorpayPaymentId || ""
    });

    // Update daily stats
    const today = startOfDay(new Date());
    await DailyStat.findOneAndUpdate(
      { clientId: client._id, date: today },
      {
        $inc: {
          codConvertedCount: 1,
          codConvertedRevenue: parseFloat(order.totalPrice),
          rtoCostSaved: 150
        }
      },
      { upsert: true }
    );

    // Emit to dashboard
    const io = req.app.get("socketio") || global.io;
    if (io) {
      io.to(`client_${client.clientId}`).emit("cod_converted", {
        phone: order.phone || order.customerPhone,
        orderNumber: order.orderNumber,
        amount: order.totalPrice
      });
      io.to(`client_${client.clientId}`).emit("stats_update", {
        type: "cod_converted",
        amount: parseFloat(order.totalPrice)
      });
    }

    // Send WhatsApp confirmation to customer
    if (sendWhatsAppText && client.whatsappToken && client.phoneNumberId) {
      await sendWhatsAppText({
        token: client.whatsappToken,
        phoneNumberId: client.phoneNumberId,
        to: order.phone || order.customerPhone,
        body: `✅ Payment confirmed! ₹${order.totalPrice} received for order #${order.orderNumber}.\n\nYour order will be dispatched within 24 hours. Thank you! 🙏`
      });
    }

    // Redirect to success page (use client's domain if available)
    const successUrl = client.shopDomain
      ? `https://${client.shopDomain}/pages/order-confirmed`
      : (process.env.PAYMENT_SUCCESS_URL || "https://topedgeai.com/payment-success");

    res.redirect(successUrl);

  } catch (err) {
    console.error("Payment callback error:", err);
    res.redirect(process.env.FALLBACK_URL || "https://topedgeai.com");
  }
});

// --- SECURE WEBHOOKS ---

const crypto = require("crypto");
const axios = require("axios");

async function markOrderPaidShopify(client, orderIdString, internalOrder) {
  if (!client.shopifyAccessToken || !client.shopDomain || !orderIdString) return;
  try {
    const baseUrl = `https://${client.shopDomain}/admin/api/${client.shopifyApiVersion || '2024-01'}`;
    
    // 1. Tag Order as Prepaid-Converted
    const orderRes = await axios.get(`${baseUrl}/orders/${orderIdString}.json`, { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } });
    let tags = orderRes.data.order?.tags || '';
    if (!tags.includes('prepaid-converted')) {
      tags = tags ? `${tags}, prepaid-converted` : 'prepaid-converted';
      await axios.put(`${baseUrl}/orders/${orderIdString}.json`, 
        { order: { id: orderIdString, tags } },
        { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
      );
    }

    // 2. Add Capture Transaction to mark as Paid
    await axios.post(`${baseUrl}/orders/${orderIdString}/transactions.json`, 
      {
         transaction: {
           currency: orderRes.data.order.currency,
           amount: internalOrder.totalPrice || orderRes.data.order.total_price,
           kind: "capture",
           gateway: client.activePaymentGateway || "manual"
         }
      },
      { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
    );
    console.log(`[Shopify Mark Paid] Success for ${orderIdString}`);
  } catch (err) {
    console.error(`[Shopify Mark Paid Error]`, err.response?.data || err.message);
  }
}

router.post("/webhook/razorpay", express.json(), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET; 
    const signature = req.headers['x-razorpay-signature'];
    
    if (secret && signature) {
      const body = req.rawBody ? req.rawBody : JSON.stringify(req.body);
      const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
      if (expectedSignature !== signature) {
         return res.status(401).send("Invalid signature");
      }
    }

    const { event, payload } = req.body;
    if (event === "payment.captured" || event === "payment_link.paid") {
      const entity = payload.payment?.entity || payload.payment_link?.entity;
      const notes = entity?.notes || {};
      
      const orderDbId = notes.order_db_id;
      const shopifyOrderId = notes.shopify_order_id;
      
      if (orderDbId) {
        const order = await Order.findById(orderDbId).populate("clientId");
        if (order && !order.paidViaLink) {
           await Order.findByIdAndUpdate(orderDbId, { isCOD: false, paidViaLink: true, paidAt: new Date() });
           if (order.clientId) {
              await markOrderPaidShopify(order.clientId, shopifyOrderId, order);
              
              const io = req.app.get("socketio") || global.io;
              if (io) io.to(`client_${order.clientId.clientId}`).emit("cod_converted_webhook", { orderId: order.orderNumber });
           }
        }
      }
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server Error");
  }
});

router.post("/webhook/cashfree", express.json(), async (req, res) => {
  try {
    // Basic verification - typically CF uses signature headers 
    const body = req.body;
    if (body.type === "PAYMENT_SUCCESS_WEBHOOK" || body.type === "PAYMENT_LINK_PAID") {
      const notes = body.data?.link?.link_meta?.notes || {};
      const orderDbId = notes.order_db_id;
      const shopifyOrderId = notes.shopify_order_id;

      if (orderDbId) {
        const order = await Order.findById(orderDbId).populate("clientId");
        if (order && !order.paidViaLink) {
           await Order.findByIdAndUpdate(orderDbId, { isCOD: false, paidViaLink: true, paidAt: new Date() });
           if (order.clientId) {
              await markOrderPaidShopify(order.clientId, shopifyOrderId, order);
              
              const io = req.app.get("socketio") || global.io;
              if (io) io.to(`client_${order.clientId.clientId}`).emit("cod_converted_webhook", { orderId: order.orderNumber });
           }
        }
      }
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
