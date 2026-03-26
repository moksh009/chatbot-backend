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
    
    case "AI_FALLBACK": {
      // Handled in dualBrainEngine.js by returning false or explicitly calling runAIFallback
      break;
    }
    
    default:
      console.warn(`[NodeActions] Unknown action: ${action}`);
  }
}

module.exports = { handleNodeAction };
