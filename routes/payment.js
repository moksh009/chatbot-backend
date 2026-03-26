const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const DailyStat = require("../models/DailyStat");
const { startOfDay } = require("date-fns");
const { sendWhatsAppTextMessage } = require("../utils/whatsapp"); // Verify this path/utility later

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
    if (sendWhatsAppTextMessage) {
      await sendWhatsAppTextMessage(
        client.whatsappToken,
        client.phoneNumberId,
        order.phone || order.customerPhone,
        `✅ Payment confirmed! ₹${order.totalPrice} received for order #${order.orderNumber}.\n\nYour order will be dispatched within 24 hours. Thank you! 🙏`
      );
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

module.exports = router;
