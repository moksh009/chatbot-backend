"use strict";

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const WhatsApp = require("./whatsapp");
const Order = require("../models/Order");
const Client = require("../models/Client");
const { createPaymentLink } = require("./paymentService");
const walletService = require("./walletService");
const { injectVariablesLegacy: replaceVariables } = require("./variableInjector");

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
      
      if (client.adminPhoneNumber) {
        await WhatsApp.sendText(client, client.adminPhoneNumber,
          `👋 Human needed: ${phone}. Chat: https://wa.me/${phone}`
        );
      }
      break;
    }
    
    case "GIVE_LOYALTY": {
      try {
        const points = node.data?.points || 10;
        const reason = node.data?.reason || "Flow participation reward";
        
        await walletService.addPoints(client.clientId, phone, points, reason);
        
        const msg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo)
          : `🎁 *Reward!* You just earned *${points}* loyalty points! ✨`;
        
        await WhatsApp.sendText(client, phone, msg);
      } catch (err) {
        console.error("[NodeActions] GIVE_LOYALTY error:", err.message);
      }
      break;
    }

    case "REDEEM_POINTS": {
      try {
        const points = node.data?.pointsRequired || 100;
        const balance = await walletService.getBalance(client.clientId, phone);
        
        if (balance < points) {
          await WhatsApp.sendText(client, phone, `Sorry, you need at least ${points} points to redeem this offer. Your current balance is ${balance} points.`);
          break;
        }

        await walletService.deductPoints(client.clientId, phone, points, "Redeemed via Flow");
        
        const successMsg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo)
          : `✅ *Redeemed!* ${points} points have been deducted. Enjoy your reward!`;
        
        await WhatsApp.sendText(client, phone, successMsg);
      } catch (err) {
        console.error("[NodeActions] REDEEM_POINTS error:", err.message);
      }
      break;
    }

    case "WARRANTY_CHECK": {
      try {
        const WarrantyRecord = require("../models/WarrantyRecord");
        const record = await WarrantyRecord.findOne({ customerPhone: phone, clientId: client.clientId }).sort({ createdAt: -1 });

        let statusMsg = "";
        if (!record) {
          statusMsg = "I couldn't find any active warranty records for your number. 🏷️";
        } else {
          const isExpired = new Date(record.expiresAt) < new Date();
          statusMsg = `📜 *Warranty Status: ${record.productName}*\n` +
                      `Record ID: *${record.recordId}*\n` +
                      `Status: *${isExpired ? 'EXPIRED' : 'ACTIVE'}*\n` +
                      `Expires: ${new Date(record.expiresAt).toLocaleDateString()}`;
        }

        await WhatsApp.sendText(client, phone, statusMsg);
      } catch (err) {
        console.error("[NodeActions] WARRANTY_CHECK error:", err.message);
      }
      break;
    }

    case "GENERATE_PAYMENT": {
      try {
        const amount = node.data?.amount || 500;
        const description = node.data?.description || `Payment for ${client.name}`;
        
        const paymentLink = await createPaymentLink(client, 
          { amount: Math.round(amount), orderId: `node_${Date.now().toString().slice(-6)}`, description },
          { name: (lead?.name || 'Customer'), phone, email: lead?.email }
        );

        const msg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo).replace('{{payment_link}}', paymentLink.url)
          : `💳 Your secure payment link is ready: ${paymentLink.url}`;
        
        await WhatsApp.sendText(client, phone, msg);
      } catch (err) {
        console.error("[NodeActions] GENERATE_PAYMENT error:", err.message);
        await WhatsApp.sendText(client, phone, "I'm having trouble generating your payment link. Our team will help you manually! 🙏");
      }
      break;
    }
    
    case "CANCEL_ORDER": {
      try {
        const Order = require("../models/Order");
        const latestOrder = await Order.findOne({ customerPhone: phone, clientId: client.clientId }).sort({ createdAt: -1 });

        if (!latestOrder) {
          await WhatsApp.sendText(client, phone, "I couldn't find any recent orders to cancel. 😕");
          break;
        }

        if (latestOrder.status === 'Cancelled') {
          await WhatsApp.sendText(client, phone, `Order ${latestOrder.orderId} is already cancelled.`);
          break;
        }

        // Only allow cancellation if not shipped
        if (latestOrder.fulfillmentStatus === 'shipped') {
          await WhatsApp.sendText(client, phone, `Sorry, Order ${latestOrder.orderId} has already been shipped and cannot be cancelled. 🚚`);
          break;
        }

        await Order.findByIdAndUpdate(latestOrder._id, { status: 'Cancelled', cancelReason: 'Requested via Chat' });
        
        // Notify Shopify if needed
        if (client.shopifyAccessToken && latestOrder.shopifyOrderId) {
          const axios = require("axios");
          await axios.post(`https://${client.shopDomain}/admin/api/2026-01/orders/${latestOrder.shopifyOrderId}/cancel.json`, 
            { reason: 'customer', note: 'Cancelled via AI Flow Builder' },
            { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
          ).catch(e => console.error("Shopify cancel failed:", e.message));
        }

        await WhatsApp.sendText(client, phone, `✅ Order *${latestOrder.orderId}* has been successfully cancelled.`);
      } catch (err) {
        console.error("[NodeActions] CANCEL_ORDER error:", err.message);
      }
      break;
    }

    case "CHECK_ORDER_STATUS": {
      try {
        const localOrder = await Order.findOne({ 
          $or: [{ customerPhone: phone }, { phone: phone }], 
          clientId: client.clientId 
        }).sort({ createdAt: -1 });

        let statusMsg = "";
        if (!localOrder) {
          statusMsg = "I couldn't find any recent orders associated with your number. 😕";
        } else {
          statusMsg = `📦 *Order ${localOrder.orderId}*\n` +
                      `Status: *${localOrder.status || 'Processing'}*\n` +
                      `Total: ₹${localOrder.totalPrice || localOrder.amount}\n` +
                      `Placed: ${new Date(localOrder.createdAt).toLocaleDateString('en-IN')}\n`;
          
          if (localOrder.trackingUrl) statusMsg += `🚚 Tracking: ${localOrder.trackingUrl}`;
        }

        await WhatsApp.sendText(client, phone, statusMsg);
      } catch (err) {
        console.error("[NodeActions] CHECK_ORDER_STATUS error:", err.message);
      }
      break;
    }

    case "INITIATE_RETURN": {
      try {
        const latestOrder = await Order.findOne({ customerPhone: phone, clientId: client.clientId }).sort({ createdAt: -1 });
        
        if (!latestOrder) {
          await WhatsApp.sendText(client, phone, "I couldn't find any recent orders for your number. 😕");
          break;
        }

        const returnId = `RET-${latestOrder.orderId.replace('#','')}-${Date.now().toString().slice(-4)}`;
        await Order.findByIdAndUpdate(latestOrder._id, { 
          $set: { status: 'Return Requested', 'metadata.returnId': returnId } 
        });

        const successMsg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo)
          : `✅ *Return Request Received!*\n\nOrder *${latestOrder.orderId}* return ID is *${returnId}*. Our team will contact you for pickup.`;

        await WhatsApp.sendText(client, phone, successMsg);
      } catch (err) {
        console.error("[NodeActions] INITIATE_RETURN error:", err.message);
      }
      break;
    }

    case "ADMIN_ALERT": {
      const NotificationService = require("./notificationService");
      const topic = node.data?.topic || "New Priority Request";
      
      await Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        { requiresAttention: true, attentionReason: topic }
      );

      await NotificationService.sendAdminAlert(client, {
        customerPhone: phone,
        topic,
        triggerSource: node.data?.triggerSource || "Automation Flow"
      });

      if (global.io) {
        global.io.to(`client_${client.clientId}`).emit('attention_required', {
          phone, reason: `Admin Alert: ${topic}`, priority: 'high'
        });
      }
      break;
    }
    
    default:
      console.warn(`[NodeActions] Unknown action: ${action}`);
  }
}

module.exports = { handleNodeAction };
