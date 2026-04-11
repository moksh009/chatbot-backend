"use strict";

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const WhatsApp = require("./whatsapp");
const Order = require("../models/Order");
const Client = require("../models/Client");
const { createPaymentLink } = require("./razorpay");
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
    
    case "SHOW_SERVICES": {
      // Dynamically render service list from client's nicheData
      const services = client.nicheData?.services || [];
      if (!services.length) return;
      
      const listText = "✨ *Our Services* ✨\n\n" + services.map((s, i) =>
        `${i+1}. *${s.name}* — ₹${s.price} (${s.duration || 30} min)`
      ).join("\n");
      
      await WhatsApp.sendText(client, phone, listText);
      break;
    }
    
    case "SHOW_SLOTS": {
      // Implementation depends on availability utility
      // Placeholder: In a real scenario, this would call getAvailableSlots
      await WhatsApp.sendText(client, phone, "I'm checking our calendar for available slots... Please wait a moment. 📅");
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
      
      const list = upcoming.map(a => `*${a.serviceName}* on ${new Date(a.startTime).toLocaleDateString()}`).join("\n");
      await WhatsApp.sendText(client, phone, `🛎️ *Your Upcoming Bookings:*\n\n${list}`);
      break;
    }
    
    case "GENERATE_PAYMENT_LINK": {
      // Phase 17: Robust Payment Link Generation
      try {
        const amount = node.data?.amount || 500; // Default or from node data
        const description = node.data?.description || `Payment for ${client.name}`;
        
        const paymentLink = await createPaymentLink({
          amount: Math.round(amount),
          currency: 'INR',
          description,
          customer: { name: (lead?.name || 'Customer'), contact: phone },
          metadata: { type: 'standalone_payment', nodeId: node.id }
        }, client);

        const msg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo).replace('{{payment_link}}', paymentLink.short_url)
          : `💳 Your secure payment link is ready: ${paymentLink.short_url}`;
        
        await WhatsApp.sendText(client, phone, msg);
      } catch (err) {
        console.error("[NodeActions] GENERATE_PAYMENT_LINK error:", err.message);
        await WhatsApp.sendText(client, phone, "I'm having trouble generating your payment link. Our team will help you manually! 🙏");
      }
      break;
    }
    
    case "CHECK_ORDER_STATUS": {
      const axios = require("axios");

      try {
        // 1. Priority: Check local DB first
        const localOrder = await Order.findOne({ 
          $or: [{ customerPhone: phone }, { phone: phone }], 
          clientId: client.clientId 
        }).sort({ createdAt: -1 });

        let statusMsg = "";
        let foundOnShopify = false;

        // 2. Secondary: If Shopify is connected, try to fetch real-time status if local is missing or old
        if (client.shopifyAccessToken && client.shopDomain) {
          try {
            // Shopify check by phone is unreliable via API filters, so we usually rely on our synced orders.
            // However, we can try to find the customer first.
            // For now, let's stick to local which is synced via Webhooks (hardened in Phase 1)
          } catch (e) { console.error("Shopify direct check failed:", e.message); }
        }

        if (!localOrder) {
          statusMsg = "I couldn't find any recent orders associated with your number. 😕 If you just placed one, please share your Order ID!";
        } else {
          statusMsg = `📦 *Order ${localOrder.orderId}*\n` +
                      `Status: *${localOrder.status || 'Processing'}*\n` +
                      `Total: ₹${localOrder.totalPrice || localOrder.amount}\n` +
                      `Placed: ${new Date(localOrder.createdAt).toLocaleDateString('en-IN')}\n`;
          
          if (localOrder.trackingUrl) {
            statusMsg += `🚚 Tracking: ${localOrder.trackingUrl}`;
          } else {
            statusMsg += `\n_We'll notify you here once it's shipped!_ ✨`;
          }
        }

        // Save to metadata for variable resolution
        await Conversation.findByIdAndUpdate(convo._id, {
          $set: { 
            "metadata.lastOrderStatus": statusMsg,
            "metadata.order_status": localOrder?.status || 'NOT_FOUND',
            "metadata.order_id": localOrder?.orderId || 'N/A'
          }
        });

        // Optionally send the status directly if node data asks for it
        if (node.data?.sendDirectly) {
           await WhatsApp.sendText(client, phone, statusMsg);
        }
      } catch (err) {
        console.error("[NodeActions] CHECK_ORDER_STATUS error:", err.message);
      }
      break;
    }

    case "CONVERT_COD_TO_PREPAID": {
      try {
        const latestOrder = await Order.findOne({ phone, clientId: client.clientId }).sort({ createdAt: -1 });
        if (!latestOrder) {
            await WhatsApp.sendText(client, phone, "I couldn't find your recent COD order to convert. 😕");
            break;
        }

        if (latestOrder.paymentMethod !== 'COD') {
            await WhatsApp.sendText(client, phone, "Your latest order is already prepaid! Thank you! 🌟");
            break;
        }

        // Generate Razorpay Link
        const amount = latestOrder.totalPrice || latestOrder.amount || 0;
        const discountAmount = Math.round(amount * 0.05); // 5% discount for converting
        const finalAmount = amount - discountAmount;

        const paymentLink = await createPaymentLink({
            amount: finalAmount,
            currency: 'INR',
            description: `Prepay for Order ${latestOrder.orderId} and save!`,
            customer: { name: (lead?.name || 'Customer'), contact: phone },
            metadata: { orderId: latestOrder.orderId, type: 'cod_conversion' }
        }, client);

        const msg = `🎁 *Special Offer!* 🎁\n\nConvert your COD order *${latestOrder.orderId}* to Prepaid now and save *₹${discountAmount}* instantly!\n\n💳 Pay ₹${finalAmount} securely here: ${paymentLink.short_url}\n\n_Limited time offer to speed up your delivery!_`;
        
        await WhatsApp.sendText(client, phone, msg);
      } catch (err) {
        console.error("[NodeActions] CONVERT_COD_TO_PREPAID error:", err.message);
        await WhatsApp.sendText(client, phone, "I'm having trouble generating your pre-payment link. Please try again later or pay on delivery. 🙏");
      }
      break;
    }

    case "CREATE_CHECKOUT": {
      // Feature 1: WhatsApp-Native Checkout
      const axios = require("axios");

      try {
        if (!client.shopifyAccessToken) break;
        
        // Check if feature is toggled ON
        const flows = client.automationFlows || [];
        const isEnabled = flows.find(f => f.id === 'whatsapp_checkout')?.isActive;
        if (!isEnabled) {
          await WhatsApp.sendText(client, phone, `Please visit our store to complete your purchase: ${client.nicheData?.storeUrl || ''}`);
          break;
        }

        // Find the product from intent — look for last clicked or mentioned product
        const products = client.nicheData?.products || [];
        if (!products.length) break;
        
        // Use first product as default (in real scenario, AI would pick based on context)
        const product = products[0];
        
        if (!product.variantId && !product.id) {
          // No Shopify variant ID stored — fallback to store URL
          await WhatsApp.sendText(client, phone, `Ready to order? Here's your link: ${product.url || client.nicheData?.storeUrl}`);
          break;
        }

        const response = await axios.post(
          `https://${client.shopDomain}/admin/api/2024-01/checkouts.json`,
          {
            checkout: {
              line_items: [{ variant_id: product.variantId || product.id, quantity: 1 }],
              phone: phone
            }
          },
          { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken } }
        );

        const checkoutUrl = response.data.checkout.web_url;
        await WhatsApp.sendText(client, phone, `🛒 Your cart is ready! Complete your order here:\n${checkoutUrl}\n\n_This link is personalized for you and expires in 24 hours._`);
      } catch (err) {
        console.error("[NodeActions] CREATE_CHECKOUT error:", err.message);
        await WhatsApp.sendText(client, phone, `Ready to order? Visit us: ${client.nicheData?.storeUrl || ''}`);
      }
      break;
    }

    case "INITIATE_RETURN": {
      // Phase 17: Enterprise Return Logic
      try {
        const Order = require("../models/Order");
        const ReturnRequest = require("../models/ReturnRequest"); // New model needed? Let's check or use a field.

        const latestOrder = await Order.findOne({ customerPhone: phone, clientId: client.clientId }).sort({ createdAt: -1 });
        
        if (!latestOrder) {
          await WhatsApp.sendText(client, phone, "I couldn't find any recent orders for your number. Please contact us directly for help with returns.");
          break;
        }

        // Create a formal return request or update order
        const returnId = `RET-${latestOrder.orderId.replace('#','')}-${Date.now().toString().slice(-4)}`;
        
        await Order.findByIdAndUpdate(latestOrder._id, { 
          $set: { 
            status: 'Return Requested',
            'metadata.returnReason': convo.metadata?.return_reason || 'Not specified',
            'metadata.returnId': returnId
          } 
        });

        // Log in Lead Activity
        if (lead) {
          const AdLead = require("../models/AdLead");
          await AdLead.findByIdAndUpdate(lead._id, {
            $push: {
              activityLog: {
                action: 'return_requested',
                details: `Return requested for order ${latestOrder.orderId}. ID: ${returnId}`,
                timestamp: new Date()
              }
            }
          });
        }

        // 2. Notify Admin via NotificationService
        const NotificationService = require("./notificationService");
        await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          topic: "🔄 New Return Request",
          triggerSource: "Returns flow",
          channel: "both"
        });

        const successMsg = node.data?.body 
          ? replaceVariables(node.data.body, client, lead, convo)
          : `✅ *Return Request Received!*\n\nOrder *${latestOrder.orderId}* has been flagged for return.\n\nYour return ID is *${returnId}*. Our team will contact you within 24 hours to confirm the pickup details.`;

        await WhatsApp.sendText(client, phone, successMsg);

      } catch (err) {
        console.error("[NodeActions] INITIATE_RETURN error:", err.message);
        await WhatsApp.sendText(client, phone, "I'm having trouble initiating your return. Please try again or type 'Agent' to talk to us.");
      }
      break;
    }

    case "SEND_PURCHASE_LINK": {
      const productKey = node.data?.productKey;
      const baseUrl = node.data?.baseUrl || client.nicheData?.storeUrl;
      const checkoutUrl = `${baseUrl}?utm_source=whatsapp&utm_medium=chatbot&uid=${lead?._id || 'unknown'}&p=${productKey || 'doorbell'}`;
      
      const msg = node.data?.body 
        ? replaceVariables(node.data.body, { client, lead, convo }) 
        : `👉 Order here: ${checkoutUrl}`;
      
      await WhatsApp.sendText(client, phone, msg.replace(`{{buy_url_${productKey}}}`, checkoutUrl));
      
      // Log activity
      if (lead) {
        const AdLead = require("../models/AdLead");
        await AdLead.findByIdAndUpdate(lead._id, {
          $push: {
            activityLog: {
              action: 'purchase_link_sent',
              details: `Sent ${productKey} purchase link: ${checkoutUrl}`,
              timestamp: new Date()
            }
          }
        });
      }
      break;
    }

    case "ADMIN_ALERT": {
      const NotificationService = require("./notificationService");
      const Conversation = require("../models/Conversation");
      
      const topic = node.data?.topic || "New Priority Request";
      const triggerSource = node.data?.triggerSource || "Automation Flow";
      const channel = node.data?.alertChannel || "both"; 

      try {
        // 1. Mark for attention in Dashboard
        await Conversation.findOneAndUpdate(
          { phone, clientId: client.clientId },
          { 
            requiresAttention: true, 
            attentionReason: topic,
            updatedAt: new Date()
          }
        );

        // 2. Dispatch Alerts
        await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          topic,
          triggerSource,
          channel
        });
      } catch (err) {
        console.error("[NodeActions] ADMIN_ALERT failure:", err.message);
      }

      // 3. Emit real-time signal
      if (global.io) {
        global.io.to(`client_${client.clientId}`).emit('attention_required', {
          phone,
          reason: `Admin Alert: ${topic}`,
          priority: 'high'
        });
      }
      break;
    }

    case "CART_RECOVERY_START": {
      try {
        const { createCheckout } = require("./shopifyHelper"); // Assuming this exists or using CREATE_CHECKOUT logic
        const cartValue = lead?.metadata?.cartValue || 0;
        
        // 1. Tag lead for tracking
        await AdLead.findByIdAndUpdate(lead._id, { $addToSet: { tags: 'Recovery Started' } });

        // 2. Logic: If high value, offer immediate discount
        if (cartValue > 2000) {
            await WhatsApp.sendText(client, phone, "🛍️ We noticed you left some premium items in your cart! To help you decide, here's a one-time 15% discount code: *SAVE15*\n\nComplete your order here: {{buy_url}}");
        } else {
            await WhatsApp.sendText(client, phone, "👋 Still thinking about those items in your cart? They're waiting for you! 🛒\n\nCheck out now: {{buy_url}}");
        }
      } catch (err) {
        console.error("[NodeActions] CART_RECOVERY_START error:", err.message);
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
