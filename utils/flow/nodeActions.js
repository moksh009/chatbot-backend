"use strict";

const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const WhatsApp = require('../meta/whatsapp');
const Order = require("../../models/Order");
const Client = require("../../models/Client");
const { createPaymentLink } = require('../commerce/paymentService');
const { injectVariablesLegacy: replaceVariables } = require('../core/variableInjector');

/**
 * Handle special side-effects for nodes that have an "action" field.
 */
async function handleNodeAction(action, node, client, phone, convo, lead) {
  const io = global.io;
  
  switch (action) {
    
    case "ESCALATE_HUMAN": {
      const { buildReopenAttentionUpdate } = require('../core/supportConversationMetrics');
      await Conversation.findByIdAndUpdate(convo._id, buildReopenAttentionUpdate({
        botPaused: true,
        attentionReason: 'Bot flow escalated to human',
        status: 'HUMAN_TAKEOVER',
      }));
      
      try {
        const AdLead = require("../../models/AdLead");
        const { applyNeedHelpTag } = require('../commerce/needHelpTag');
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { pendingSupport: true } }
        );
        await applyNeedHelpTag(client.clientId, phone);
      } catch (err) { console.error("[NodeActions] ESCALATE_HUMAN AdLead update error:", err.message); }
      
      if (io) {
        io.to(`client_${client.clientId}`).emit("attention_required", {
          phone,
          reason:   "Human support requested via flow",
          priority: "high"
        });
      }
      
      try {
        const NotificationService = require('../core/notificationService');
        await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          conversationId: convo?._id,
          topic: "Human takeover requested (ESCALATE_HUMAN)",
          triggerSource: "Flow action",
          lead,
        });
      } catch (e) {
        console.error(`[NodeActions] ESCALATE_HUMAN admin alert failed: ${e.message}`);
      }
      break;
    }
    
    case "WARRANTY_CHECK": {
      // Legacy action — warranty_check nodes are handled by warrantyFlowLookup in dualBrainEngine.
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
        const Order = require("../../models/Order");
        const { withShopifyRetry } = require('../shopify/shopifyHelper');
        const meta = convo?.metadata || {};
        const lastOrder = meta.lastOrder || {};
        let shopifyOrderId =
          meta.shopify_order_id ||
          lastOrder.orderId ||
          meta.shopifyOrderId ||
          null;

        const latestOrder = await Order.findOne({
          $or: [{ customerPhone: phone }, { phone }],
          clientId: client.clientId,
        })
          .sort({ createdAt: -1 })
          .lean();

        if (!shopifyOrderId && latestOrder?.shopifyOrderId) {
          shopifyOrderId = latestOrder.shopifyOrderId;
        }

        const displayNum =
          meta.order_number ||
          (lastOrder.orderNumber ? `#${lastOrder.orderNumber}` : "") ||
          latestOrder?.orderId ||
          "";

        if (!shopifyOrderId && !latestOrder) {
          await WhatsApp.sendText(
            client,
            phone,
            "I do not have an order on file yet. Open *Track order* once so I can load your latest order, then try cancel again."
          );
          break;
        }

        if (client.shopifyAccessToken && client.shopDomain && shopifyOrderId) {
          try {
            await withShopifyRetry(client.clientId, async (shopify) => {
              await shopify.post(`/orders/${shopifyOrderId}/cancel.json`, {
                reason: "customer",
                email: false,
                restock: true,
              });
            });
          } catch (apiErr) {
            const msg = String(apiErr?.response?.data?.errors || apiErr.message || "");
            console.error("[NodeActions] Shopify cancel failed:", msg);
            if (/fulfilled|shipped|complete/i.test(msg)) {
              await WhatsApp.sendText(
                client,
                phone,
                "This order can no longer be cancelled automatically because it is already fulfilled or shipped. Our team can help with a return instead."
              );
              break;
            }
            await WhatsApp.sendText(
              client,
              phone,
              "We could not cancel through the store just now. A teammate will confirm on WhatsApp shortly."
            );
            break;
          }

          const label = displayNum || `#${shopifyOrderId}`;
          await WhatsApp.sendText(client, phone, `✅ *${label}* has been cancelled in the store.`);
          if (latestOrder?._id) {
            await Order.findByIdAndUpdate(latestOrder._id, {
              status: "Cancelled",
              cancelReason: "Requested via WhatsApp flow",
            });
          }
          break;
        }

        if (latestOrder) {
          if (latestOrder.status === "Cancelled") {
            await WhatsApp.sendText(client, phone, `Order ${latestOrder.orderId} is already cancelled.`);
            break;
          }
          if (latestOrder.fulfillmentStatus === "shipped") {
            await WhatsApp.sendText(
              client,
              phone,
              `Sorry, order ${latestOrder.orderId} has already shipped and cannot be cancelled here.`
            );
            break;
          }
          await Order.findByIdAndUpdate(latestOrder._id, {
            status: "Cancelled",
            cancelReason: "Requested via Chat",
          });
          await WhatsApp.sendText(client, phone, `✅ Order *${latestOrder.orderId}* has been cancelled.`);
          break;
        }

        await WhatsApp.sendText(
          client,
          phone,
          "I could not cancel this order automatically. Please message our team with your order number."
        );
      } catch (err) {
        console.error("[NodeActions] CANCEL_ORDER error:", err.message);
        await WhatsApp.sendText(
          client,
          phone,
          "Something went wrong while cancelling. Please try again in a moment or ask our team for help."
        );
      }
      break;
    }

    case "CHECK_ORDER_STATUS": {
      try {
        const { resolveLatestOrderContext } = require('../commerce/orderLookupService');
        const r = await resolveLatestOrderContext({ client, phone });
        const prev = convo?.metadata || {};
        if (convo?._id && r.mergedMeta) {
          await Conversation.findByIdAndUpdate(convo._id, {
            $set: { metadata: { ...prev, ...r.mergedMeta } },
          });
        }
        const custom =
          (node.data?.body && String(node.data.body).trim()) ||
          (node.data?.text && String(node.data.text).trim()) ||
          "";
        const convoPlain =
          convo && typeof convo.toObject === "function" ? convo.toObject() : { ...(convo || {}) };
        const mergedConvo = {
          ...convoPlain,
          metadata: { ...prev, ...(r.mergedMeta || {}) },
        };
        let out = r.userMessage || "";
        if (custom) {
          const rendered = String(replaceVariables(custom, client, lead, mergedConvo) || "").trim();
          if (rendered) out = rendered;
        }
        if (!out) {
          out =
            "We could not look up your order just now. Please share your *order ID* or try again shortly.";
        }
        await WhatsApp.sendText(client, phone, out.substring(0, 4096));
      } catch (err) {
        console.error("[NodeActions] CHECK_ORDER_STATUS error:", err.message);
        try {
          await WhatsApp.sendText(
            client,
            phone,
            "We could not look up your order right now. Please share your *order ID* or try again in a few minutes."
          );
        } catch (_) {}
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
      const { buildReopenAttentionUpdate } = require('../core/supportConversationMetrics');
      const topic = node.data?.topic || "New Priority Request";
      const channels = Array.isArray(node.data?.notifyChannels) ? node.data.notifyChannels : ['Dashboard'];
      const rawBody = node.data?.messageBody || topic;
      const messageBody = replaceVariables(rawBody, { client, lead, convo }) || rawBody;

      await Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        buildReopenAttentionUpdate({ attentionReason: topic })
      );

      if (channels.includes('Dashboard')) {
        if (global.io) {
          global.io.to(`client_${client.clientId}`).emit('attention_required', {
            phone,
            reason: `Admin Alert: ${topic}`,
            priority: 'high',
            messageBody,
          });
        }
      }

      if (channels.includes('Email')) {
        const emailTo = node.data?.alertEmailTo;
        if (emailTo) {
          try {
            const { sendAlertEmail } = require('../core/emailService');
            await sendAlertEmail({
              to: emailTo,
              subject: `[TopEdge Alert] ${topic}`,
              body: messageBody,
              clientId: client.clientId,
              customerPhone: phone,
            });
          } catch (emailErr) {
            console.error(`[NodeActions] ADMIN_ALERT email send failed: ${emailErr.message}`);
          }
        }
      }
      break;
    }
    
    case "CONVERT_COD_TO_PREPAID": {
      try {
        const Order = require('../../models/Order');
        const { sendCODToPrepaidNudge } = require('../commerce/ecommerceHelpers');
        const lastOrder = await Order.findOne({ clientId: client.clientId, customerPhone: phone }).sort({ createdAt: -1 });

        if (lastOrder) {
          await sendCODToPrepaidNudge(lastOrder, client, phone);
        } else {
          // Fallback if no order record found yet
          const discount = node.data?.discountAmount || 50;
          await WhatsApp.sendText(client, phone, `💳 *Exclusive Offer for You!*\n\nSwitch to online payment and get *₹${discount} instant discount*! Reach out to us to convert your COD order now.`);
        }

        // Tag lead for analytics
        try {
          const AdLead = require('../../models/AdLead');
          await AdLead.findOneAndUpdate(
            { phoneNumber: phone, clientId: client.clientId },
            { $set: { 'metadata.codConversionOffered': true, 'metadata.lastCodOfferAt': new Date() } }
          );
        } catch { /* non-blocking */ }
      } catch (err) {
        console.error('[NodeActions] CONVERT_COD_TO_PREPAID error:', err.message);
      }
      break;
    }

    case "CART_RECOVERY_SEND_STEP":
    case "sequence": {
      try {
        const stepNumber = node.data?.stepNumber || 1;
        const { generateSmartRecoveryMessage } = require('../commerce/smartCartRecovery');

        // Get lead for cart data
        const AdLead = require('../../models/AdLead');
        const leadRecord = lead || await AdLead.findOne({ phoneNumber: phone, clientId: client.clientId });

        let messageText = null;

        // Attempt AI personalised message
        if (leadRecord?.cartSnapshot) {
          messageText = await generateSmartRecoveryMessage(client, leadRecord, stepNumber);
        }

        // Fallback message if AI fails or no cart data
        if (!messageText) {
          const fallbacks = {
            1: `👋 Hey${lead?.name ? ' ' + lead.name.split(' ')[0] : ''}! You left something in your cart. Complete your order here: ${client.nicheData?.storeUrl || ''}`,
            2: `⏰ Your cart items are going fast! Don't miss out — complete your purchase before they're gone: ${client.nicheData?.storeUrl || ''}`,
            3: `🎁 Last chance! Use code *SAVE10* for 10% off your cart. This offer expires soon: ${client.nicheData?.storeUrl || ''}`
          };
          messageText = fallbacks[stepNumber] || fallbacks[1];
        }

        await WhatsApp.sendText(client, phone, messageText);

        // Track recovery step
        try {
          const AdLead2 = require('../../models/AdLead');
          await AdLead2.findOneAndUpdate(
            { phoneNumber: phone, clientId: client.clientId },
            {
              $set: { [`metadata.cartRecoveryStep${stepNumber}SentAt`]: new Date() },
              $inc: { 'metadata.cartRecoveryStepsSent': 1 }
            }
          );
        } catch { /* non-blocking */ }
      } catch (err) {
        console.error('[NodeActions] sequence / CART_RECOVERY_SEND_STEP error:', err.message);
      }
      break;
    }

    case "SET_VARIABLE": {
      try {
        const varName  = node.data?.variableName;
        const varValue = node.data?.variableValue;
        if (varName && convo) {
          await Conversation.findByIdAndUpdate(convo._id, {
            $set: { [`variables.${varName}`]: varValue }
          });
        }
      } catch (err) {
        console.error('[NodeActions] SET_VARIABLE error:', err.message);
      }
      break;
    }

    case "CART_RECOVERY_START": {
      try {
        const AdLead = require("../../models/AdLead");
        const { normalizePhone } = require('../core/helpers');
        const clean = normalizePhone(phone);
        await AdLead.findOneAndUpdate(
          { phoneNumber: clean, clientId: client.clientId },
          {
            $set: {
              cartStatus: "abandoned",
              recoveryStep: 0,
              recoveryStartedAt: new Date(),
            },
          },
          { upsert: false }
        );
        if (convo?._id) {
          const Conversation = require("../../models/Conversation");
          await Conversation.findByIdAndUpdate(convo._id, {
            $set: { "metadata.cartRecoveryActive": true },
          });
        }
      } catch (err) {
        console.error("[NodeActions] CART_RECOVERY_START error:", err.message);
      }
      break;
    }

    case "ORDER_REFUND_STATUS": {
      try {
        const Order = require("../../models/Order");
        const { normalizePhone } = require('../core/helpers');
        const clean = normalizePhone(phone);
        const order = await Order.findOne({
          clientId: client.clientId,
          $or: [{ customerPhone: clean }, { customerPhone: phone }],
        })
          .sort({ createdAt: -1 })
          .lean();
        const status = String(order?.financialStatus || order?.status || "").toLowerCase();
        let msg =
          "For *{{brand_name}}* orders, refunds usually post within *5–7 business days* after approval, depending on your bank.";
        if (status.includes("refund")) {
          msg = "✅ Your refund for order *{{order_number}}* has been initiated. It may take 5–7 business days to reflect in your account.";
        } else if (order) {
          msg = `Order *${order.orderNumber || order.orderId}* status: *${order.status || "processing"}*. If you requested a refund, our team will confirm on WhatsApp shortly.`;
        }
        await WhatsApp.sendText(client, phone, replaceVariables(msg, client, lead, convo));
      } catch (err) {
        console.error("[NodeActions] ORDER_REFUND_STATUS error:", err.message);
      }
      break;
    }

    default:
      console.warn(`[NodeActions] Unknown action: ${action}`);
  }
}

module.exports = { handleNodeAction };
