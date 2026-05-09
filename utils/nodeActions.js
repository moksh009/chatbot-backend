"use strict";

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const WhatsApp = require("./whatsapp");
const Order = require("../models/Order");
const Client = require("../models/Client");
const { createPaymentLink } = require("./paymentService");
const walletService = require("./walletService");
const { injectVariablesLegacy: replaceVariables } = require("./variableInjector");

function parseWarrantyMonthsLabel(label) {
  const s = String(label || "").toLowerCase();
  let m = s.match(/(\d+)\s*(year|yr|yrs|years)/);
  if (m) return Math.min(120, Math.max(1, parseInt(m[1], 10) * 12));
  m = s.match(/(\d+)\s*(month|months|mos|mo\b)/);
  if (m) return Math.min(120, Math.max(1, parseInt(m[1], 10)));
  m = s.match(/(\d+)\s*(day|days)/);
  if (m) return Math.min(120, Math.max(1, Math.ceil(parseInt(m[1], 10) / 30)));
  return 12;
}

function addCalendarMonths(d, months) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + months);
  return x;
}

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
      
      try {
        const AdLead = require("../models/AdLead");
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          { $set: { pendingSupport: true } }
        );
      } catch (err) { console.error("[NodeActions] ESCALATE_HUMAN AdLead update error:", err.message); }
      
      if (io) {
        io.to(`client_${client.clientId}`).emit("attention_required", {
          phone,
          reason:   "Human support requested via flow",
          priority: "high"
        });
      }
      
      try {
        const NotificationService = require("./notificationService");
        await NotificationService.sendAdminAlert(client, {
          customerPhone: phone,
          topic: "Human takeover requested (ESCALATE_HUMAN)",
          triggerSource: "Flow action",
        });
      } catch (e) {
        if (client.adminPhoneNumber) {
          await WhatsApp.sendText(client, client.adminPhoneNumber,
            `👋 Human needed: ${phone}. Chat: https://wa.me/${phone}`
          );
        }
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
          break;
        }

        await walletService.deductPoints(client.clientId, phone, points, "Redeemed via Flow");
      } catch (err) {
        console.error("[NodeActions] REDEEM_POINTS error:", err.message);
      }
      break;
    }

    case "WARRANTY_CHECK": {
      try {
        const { normalizePhone } = require("./helpers");
        const WarrantyRecord = require("../models/WarrantyRecord");
        const Contact = require("../models/Contact");
        const cleanPhone = normalizePhone(phone);
        const meta = convo?.metadata || {};
        const rawQuery = String(meta.lookup_serial || meta.order_id_manual || "").trim();
        const normQuery = rawQuery.replace(/^#/i, "").replace(/\s+/g, "").toLowerCase();

        const wf =
          client.wizardFeatures?.toObject
            ? client.wizardFeatures.toObject()
            : client.wizardFeatures || {};
        const warrantyLabel =
          wf.warrantyDuration ||
          client.platformVars?.warrantyDuration ||
          client.brand?.warrantyDefaultDuration ||
          "1 Year";
        const months = parseWarrantyMonthsLabel(warrantyLabel);

        const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const phoneOr = {
          $or: [{ customerPhone: cleanPhone }, { phone: cleanPhone }],
        };

        let branch = "none";
        let order = null;
        let warrantyEnd = null;
        let productName = "";
        let orderRef = "";

        const orderIdMatch = normQuery
          ? {
              $or: [
                { orderNumber: new RegExp(`^${escapeRegex(normQuery)}$`, "i") },
                { orderId: new RegExp(`^${escapeRegex(normQuery)}$`, "i") },
              ],
            }
          : null;

        if (normQuery) {
          order = await Order.findOne({
            clientId: client.clientId,
            $and: [phoneOr, orderIdMatch],
          })
            .sort({ createdAt: -1 })
            .lean();
          if (!order) {
            order = await Order.findOne({
              clientId: client.clientId,
              ...orderIdMatch,
            })
              .sort({ createdAt: -1 })
              .lean();
          }
        } else {
          order = await Order.findOne({
            clientId: client.clientId,
            ...phoneOr,
          })
            .sort({ createdAt: -1 })
            .lean();
        }

        if (order?.createdAt) {
          const purchase = new Date(order.createdAt);
          warrantyEnd = addCalendarMonths(purchase, months);
          branch = new Date() <= warrantyEnd ? "active" : "expired";
          productName =
            (Array.isArray(order.items) && order.items[0]?.name) ||
            "Your purchase";
          orderRef = String(
            order.orderNumber || order.orderId || order.shopifyOrderId || ""
          ).trim();
        } else if (!order) {
          let contact = await Contact.findOne({
            clientId: client.clientId,
            phoneNumber: cleanPhone,
          })
            .select("_id")
            .lean();
          if (!contact && cleanPhone.length >= 10) {
            const suffix = cleanPhone.slice(-10);
            contact = await Contact.findOne({
              clientId: client.clientId,
              phoneNumber: new RegExp(`${escapeRegex(suffix)}$`),
            })
              .select("_id")
              .lean();
          }

          const record = contact
            ? await WarrantyRecord.findOne({
                clientId: client.clientId,
                customerId: contact._id,
              })
                .sort({ createdAt: -1 })
                .lean()
            : null;

          if (record?.expiryDate) {
            warrantyEnd = new Date(record.expiryDate);
            const expired = warrantyEnd < new Date();
            branch = expired ? "expired" : "active";
            productName = record.productName || "";
            orderRef = String(record.shopifyOrderId || "").trim();
          } else {
            branch = "none";
          }
        } else {
          branch = "none";
        }

        const expiresDisplay = warrantyEnd
          ? warrantyEnd.toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : "";

        const summary =
          branch === "none"
            ? "We could not find a warranty on file for this number. Share your order ID and we will help you."
            : branch === "active"
              ? `Your warranty${productName ? ` for ${productName}` : ""} is active${expiresDisplay ? ` until ${expiresDisplay}` : ""}. Ask here if you need your certificate resent on WhatsApp.`
              : `Your warranty${productName ? ` for ${productName}` : ""} has ended${expiresDisplay ? ` (expired ${expiresDisplay})` : ""}.`;

        await Conversation.findByIdAndUpdate(convo._id, {
          $set: {
            "metadata._warranty_branch": branch,
            "metadata._warranty_checked_at": new Date(),
            "metadata._warranty_error": false,
            "metadata._warranty_expires_at": warrantyEnd ? warrantyEnd.toISOString() : "",
            "metadata._warranty_expires_display": expiresDisplay,
            "metadata._warranty_product_name": productName,
            "metadata._warranty_order_ref": orderRef,
            "metadata._warranty_summary": summary,
          },
        });
      } catch (err) {
        console.error("[NodeActions] WARRANTY_CHECK error:", err.message);
        try {
          await Conversation.findByIdAndUpdate(convo._id, {
            $set: {
              "metadata._warranty_branch": "none",
              "metadata._warranty_checked_at": new Date(),
              "metadata._warranty_error": true,
              "metadata._warranty_expires_at": "",
              "metadata._warranty_expires_display": "",
              "metadata._warranty_product_name": "",
              "metadata._warranty_order_ref": "",
              "metadata._warranty_summary":
                "Warranty lookup failed. Please try again or ask for a human agent.",
            },
          });
        } catch (_) {}
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
        const { withShopifyRetry } = require("./shopifyHelper");
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
      const nodeChannel = node.data?.alertChannel;
      const pref = client.adminAlertPreferences;
      const channel =
        nodeChannel === "whatsapp" || nodeChannel === "email" || nodeChannel === "both"
          ? nodeChannel
          : (pref === "whatsapp" || pref === "email" || pref === "both" ? pref : "both");

      await Conversation.findOneAndUpdate(
        { phone, clientId: client.clientId },
        { requiresAttention: true, attentionReason: topic }
      );

      await NotificationService.sendAdminAlert(client, {
        customerPhone: phone,
        topic,
        triggerSource: node.data?.triggerSource || "Automation Flow",
        channel,
        adminPhoneOverride: node.data?.phone ? String(node.data.phone).replace(/\D/g, "") : undefined,
        customerQuery: lead?.capturedData?.support_query || "",
      });

      if (global.io) {
        global.io.to(`client_${client.clientId}`).emit('attention_required', {
          phone, reason: `Admin Alert: ${topic}`, priority: 'high'
        });
      }
      break;
    }
    
    case "CONVERT_COD_TO_PREPAID": {
      try {
        const Order = require('../models/Order');
        const { sendCODToPrepaidNudge } = require('./ecommerceHelpers');
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
          const AdLead = require('../models/AdLead');
          await AdLead.findOneAndUpdate(
            { phone, clientId: client.clientId },
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
        const { generateSmartRecoveryMessage } = require('./smartCartRecovery');

        // Get lead for cart data
        const AdLead = require('../models/AdLead');
        const leadRecord = lead || await AdLead.findOne({ phone, clientId: client.clientId });

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
          const AdLead2 = require('../models/AdLead');
          await AdLead2.findOneAndUpdate(
            { phone, clientId: client.clientId },
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

    case "SEND_REVIEW_REQUEST": {
      try {
        const Order = require('../models/Order');
        const ReviewRequest = require('../models/ReviewRequest');
        const order = await Order.findOne({
          clientId: client.clientId,
          status: { $in: ['Delivered', 'delivered'] },
          $or: [{ customerPhone: phone }, { phone }]
        }).sort({ createdAt: -1 }).lean();
        
        const productName = order?.lineItems?.[0]?.title || node.data?.productName || 'your recent purchase';
        const reviewUrl   = node.data?.reviewUrl || client.nicheData?.storeUrl || '';

        const msgBody = node.data?.body
          ? replaceVariables(node.data.body, client, lead, convo)
          : `⭐ How was *${productName}*?\n\nYour feedback means the world to us! It takes just 10 seconds and helps other customers decide.\n\n👉 Leave your review: ${reviewUrl}`;

        await WhatsApp.sendText(client, phone, msgBody);

        // Keep review analytics and lifecycle in sync with flow-origin sends.
        await ReviewRequest.findOneAndUpdate(
          {
            clientId: client.clientId,
            phone,
            status: { $in: ['scheduled', 'sent'] }
          },
          {
            $set: {
              orderId: String(order?.orderId || order?._id || ''),
              orderNumber: String(order?.orderNumber || ''),
              productName,
              reviewUrl,
              status: 'sent',
              sentAt: new Date()
            },
            $setOnInsert: {
              clientId: client.clientId,
              phone,
              scheduledFor: new Date()
            }
          },
          { upsert: true, sort: { createdAt: -1 } }
        );
      } catch (err) {
        console.error('[NodeActions] SEND_REVIEW_REQUEST error:', err.message);
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

    case "LOG_REVIEW_POSITIVE": {
      try {
        const ReviewRequest = require('../models/ReviewRequest');
        // Find the most recent pending review request for this user
        const review = await ReviewRequest.findOne({ phone, clientId: client.clientId }).sort({ createdAt: -1 });
        if (review) {
          review.status = 'responded_positive';
          review.response = 'positive';
          await review.save();
        }
      } catch (err) {
        console.error('[NodeActions] LOG_REVIEW_POSITIVE error:', err.message);
      }
      break;
    }

    case "LOG_REVIEW_NEGATIVE": {
      try {
        const ReviewRequest = require('../models/ReviewRequest');
        const review = await ReviewRequest.findOne({ phone, clientId: client.clientId }).sort({ createdAt: -1 });
        if (review) {
          review.status = 'responded_negative';
          review.response = 'negative';
          await review.save();
          
          // Divert to Human
          const Conversation = require('../models/Conversation');
          await Conversation.findByIdAndUpdate(convo._id, { status: 'HUMAN_TAKEOVER', botPaused: true });
          const NotificationService = require('./notificationService');
          await NotificationService.createNotification(client.clientId, {
            type: 'alert',
            title: '⚠️ Negative Feedback Received',
            message: `Customer ${phone} gave negative feedback on order ${review.orderNumber}. Human intervention required.`,
            customerPhone: phone
          });
        }
      } catch (err) {
        console.error('[NodeActions] LOG_REVIEW_NEGATIVE error:', err.message);
      }
      break;
    }

    default:
      console.warn(`[NodeActions] Unknown action: ${action}`);
  }
}

module.exports = { handleNodeAction };
