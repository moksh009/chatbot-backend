"use strict";

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

/**
 * Handle special side-effects for nodes that have an "action" field.
 */
async function handleNodeAction(action, node, client, phone, convo, lead) {
  const io = global.io;
  
  switch (action) {
    
    case "ESCALATE_HUMAN": {
      await Conversation.findByIdAndUpdate(convo._id, {
        botPaused:         true,
        requiresAttention: true,
        attentionReason:   "Bot flow escalated to human",
        status:            'HUMAN_TAKEOVER'
      });
      
      if (io) {
        io.to(`client_${client.clientId}`).emit("attention_required", {
          phone,
          reason:   "Human support requested via flow",
          priority: "high"
        });
      }
      
      if (client.adminPhone) {
        // Dynamic require to avoid circular dependency
        const { sendWhatsAppText } = require("./dualBrainEngine");
        await sendWhatsAppText(client, client.adminPhone,
          `👋 Human needed: ${phone}. Chat: https://wa.me/${phone}`
        );
      }
      break;
    }
    
    case "SHOW_SERVICES": {
      // Dynamically render service list from client's nicheData
      const services = client.nicheData?.services || [];
      if (!services.length) return;
      
      const listText = "✨ *Our Services* ✨\n\n" + services.map((s, i) =>
        `${i+1}. *${s.name}* — ₹${s.price} (${s.duration || 30} min)`
      ).join("\n");
      
      const { sendWhatsAppText } = require("./dualBrainEngine");
      await sendWhatsAppText(client, phone, listText);
      break;
    }
    
    case "SHOW_SLOTS": {
      // Implementation depends on availability utility
      // Placeholder: In a real scenario, this would call getAvailableSlots
      const { sendWhatsAppText } = require("./dualBrainEngine");
      await sendWhatsAppText(client, phone, "I'm checking our calendar for available slots... Please wait a moment. 📅");
      break;
    }
    
    case "SHOW_MY_BOOKINGS": {
      const Appointment = require("../models/Appointment");
      const upcoming = await Appointment.find({
        phone, 
        clientId: client.clientId,
        startTime: { $gte: new Date() },
        status: "confirmed"
      }).sort({ startTime: 1 }).limit(3);
      
      const { sendWhatsAppText } = require("./dualBrainEngine");
      
      if (!upcoming.length) {
        await sendWhatsAppText(client, phone, "You have no upcoming appointments. Would you like to book one? 😊");
        return;
      }
      
      const list = upcoming.map(a =>
        `📅 *${a.serviceName}*\n⏰ ${new Date(a.startTime).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`
      ).join("\n\n");
      
      await sendWhatsAppText(client, phone, `🛎️ *Your Upcoming Bookings:*\n\n${list}`);
      break;
    }
    
    case "GENERATE_PAYMENT_LINK": {
      // Placeholder for payment link generation (Razorpay/Cashfree)
      const { sendWhatsAppText } = require("./dualBrainEngine");
      await sendWhatsAppText(client, phone, "I'm generating your secure payment link... 💳");
      break;
    }
    
    case "CHECK_ORDER_STATUS": {
      const Order = require("../models/Order");
      const axios = require("axios");
      const { sendWhatsAppText } = require("./dualBrainEngine");

      try {
        // 1. Try to find the latest order for this phone
        const localOrder = await Order.findOne({ 
          $or: [{ customerPhone: phone }, { phone: phone }], 
          clientId: client.clientId 
        }).sort({ createdAt: -1 });

        let statusMsg = "";

        if (client.shopifyAccessToken && client.shopDomain) {
          // 2. If Shopify is connected, try to fetch real-time status
          try {
            const shopifyResponse = await axios.get(
              `https://${client.shopDomain}/admin/api/2024-01/orders.json?limit=1&customer_id=${phone}`, // This assumes customer phone search works or we have an ID
              { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
            );
            
            // Note: Shopify API phone search is tricky, usually better to search by email or use our local record's Shopify ID
            // For now, we'll rely on our local record which is synced via webhooks/sync-orders
          } catch (e) { /* ignore shopify fetch error and fallback to local */ }
        }

        if (!localOrder) {
          statusMsg = "I couldn't find any recent orders associated with your number. 😕 If you just placed one, it might take a moment to sync!";
        } else {
          statusMsg = `📦 *Order ${localOrder.orderId}*\n` +
                      `Status: *${localOrder.status || 'Processing'}*\n` +
                      `Total: ₹${localOrder.totalPrice || localOrder.amount}\n` +
                      `Placed: ${new Date(localOrder.createdAt).toLocaleDateString('en-IN')}\n`;
          
          if (localOrder.trackingUrl) {
            statusMsg += `🚚 Tracking: ${localOrder.trackingUrl}`;
          } else {
            statusMsg += `\n_We'll notify you here once it's shipped!_`;
          }
        }

        // Update conversation metadata so the template variable {{order_status_summary}} is ready for the next node
        await Conversation.findByIdAndUpdate(convo._id, {
          $set: { "metadata.lastOrderStatus": statusMsg }
        });

        // We don't necessarily need to send a message here if the flow node has text with {{order_status_summary}}
        // But for redundancy or auto-edges, it helps.
      } catch (err) {
        console.error("[NodeActions] CHECK_ORDER_STATUS error:", err.message);
      }
      break;
    }

    case "AI_FALLBACK": {
      // Handled in dualBrainEngine.js by returning false or explicitly calling runAIFallback
      break;
    }
    
    default:
      console.warn(`[NodeActions] Unknown action: ${action}`);
  }
}

module.exports = { handleNodeAction };
