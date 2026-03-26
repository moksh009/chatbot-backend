const cron = require('node-cron');
const ReviewRequest = require('../models/ReviewRequest');
const Client = require('../models/Client');
const axios = require('axios');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

// Runs daily at 10:00 AM IST (04:30 UTC)
module.exports = function scheduleReviewCron() {
  cron.schedule("30 4 * * *", async () => {
    try {
      const due = await ReviewRequest.find({
        status: "scheduled",
        scheduledFor: { $lte: new Date() }
      }).populate("clientId");

      for (const review of due) {
        const client = review.clientId;
        if (!client?.whatsappToken || !client?.phoneNumberId) continue;

        // Get template or use default
        const template = (client.messageTemplates || []).find(t => t.id === "review_request");
        const bodyText = template?.body
          ? template.body
              .replace("{{product_name}}", review.productName)
          : `Hi! How's your *${review.productName}*? 😊\n\nYour feedback helps us improve and helps other customers!`;

        const btn1 = template?.buttons?.[0]?.label || "😍 Loved it!";
        const btn2 = template?.buttons?.[1]?.label || "😐 It's okay";
        const btn3 = template?.buttons?.[2]?.label || "😕 Not happy";

        const interactive = {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: [
              { type: "reply", reply: { id: `rv_good_${review._id}`, title: btn1.substring(0, 20) } },
              { type: "reply", reply: { id: `rv_ok_${review._id}`, title: btn2.substring(0, 20) } },
              { type: "reply", reply: { id: `rv_bad_${review._id}`, title: btn3.substring(0, 20) } }
            ]
          }
        };

        try {
          await axios.post(
            `https://graph.facebook.com/v18.0/${client.phoneNumberId}/messages`,
            {
              messaging_product: "whatsapp",
              to: review.phone,
              type: "interactive",
              interactive
            },
            { headers: { Authorization: `Bearer ${client.whatsappToken}` } }
          );

          await ReviewRequest.findByIdAndUpdate(review._id, {
            status: "sent",
            sentAt: new Date()
          });

          // Log in Messages collection
          let conversation = await Conversation.findOne({ phone: review.phone, clientId: client._id });
          if (!conversation) {
             // Not strictly guaranteed they had a conversation, but usually they did since they bought something
             conversation = await Conversation.create({ phone: review.phone, clientId: client._id, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
          }
          await Message.create({
            clientId: client._id,
            conversationId: conversation._id,
            from: 'bot',
            to: review.phone,
            content: `[Interactive] ${bodyText}`,
            type: 'interactive',
            direction: 'outgoing',
            status: 'sent'
          });

        } catch (sendErr) {
          console.error(`[ReviewCron] Error sending to ${review.phone}:`, sendErr.response?.data || sendErr.message);
        }
      }
    } catch (err) {
      console.error("[ReviewCron] General error:", err);
    }
  });
};
