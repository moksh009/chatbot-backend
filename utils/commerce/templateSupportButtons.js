"use strict";

const Conversation = require("../../models/Conversation");
const AdLead = require("../../models/AdLead");
const NotificationService = require("../core/notificationService");
const { sendWhatsAppText } = require("../meta/whatsapp");
const { buildReopenAttentionUpdate } = require("../core/supportConversationMetrics");
const { applyNeedHelpTag } = require("./needHelpTag");
const log = require("../core/logger")("TemplateSupportButtons");

/** Normalized labels from template QUICK_REPLY buttons that trigger admin handoff. */
const SUPPORT_BUTTON_LABELS = new Set([
  "contact support",
  "contact us",
  "need help",
  "help me",
  "talk to support",
  "talk to agent",
  "get help",
  "support",
]);

function normalizeSupportLabel(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isTemplateSupportButton(text) {
  const n = normalizeSupportLabel(text);
  return Boolean(n && SUPPORT_BUTTON_LABELS.has(n));
}

/**
 * Global handler for template "Contact support" taps — works without a merchant flow.
 */
async function handleTemplateSupportButtonTap({
  client,
  phone,
  convo,
  lead,
  io,
  inboundText,
}) {
  if (!client?.clientId || !phone || !convo?._id) return false;

  const userText = String(inboundText || "").trim();
  const DashboardLink = `https://dash.topedgeai.com/conversations?phone=${encodeURIComponent(phone)}`;
  const cartInfo =
    parseInt(lead?.addToCartCount, 10) > 0
      ? `Carts: ${lead.addToCartCount}`
      : "No carts yet";
  const orderInfo = lead?.isOrderPlaced
    ? `Orders: ${lead.ordersCount || 0} | Spent: ${lead.totalSpent || 0}`
    : "No orders yet";

  try {
    await NotificationService.sendAdminAlert(client, {
      customerPhone: phone,
      conversationId: convo._id,
      topic: "🙋 Customer requested support",
      triggerSource: `Template button: "${userText}"\n👤 ${lead?.name || "Customer"}\n🛒 ${cartInfo}\n📦 ${orderInfo}\n🔗 ${DashboardLink}`,
      channel: "both",
      customerQuery: userText,
    });
  } catch (err) {
    log.warn(`Admin alert failed for support button: ${err.message}`);
  }

  await Conversation.findByIdAndUpdate(
    convo._id,
    buildReopenAttentionUpdate({
      status: "HUMAN_TAKEOVER",
      attentionReason: `Customer tapped "${userText}"`,
      lastInteraction: new Date(),
    })
  );

  try {
    await AdLead.findOneAndUpdate(
      { phoneNumber: phone, clientId: client.clientId },
      { $set: { pendingSupport: true } }
    );
    await applyNeedHelpTag(client.clientId, phone);
  } catch (err) {
    log.warn(`Need-help tag failed: ${err.message}`);
  }

  if (io) {
    io.to(`client_${client.clientId}`).emit("attention_required", {
      phone,
      conversationId: String(convo._id),
      reason: "Customer tapped Contact support on a template",
      priority: "high",
    });
    io.to(`client_${client.clientId}`).emit("admin_alert", {
      type: "escalation",
      topic: "Customer requested support",
      priority: "high",
      phone,
      conversationId: String(convo._id),
      leadName: lead?.name || "Customer",
      timestamp: new Date(),
    });
  }

  const brandName =
    client.platformVars?.brandName || client.brand?.businessName || "our team";
  await sendWhatsAppText(
    client,
    phone,
    `Thanks for reaching out! 🙏\n\nA member of *${brandName}* has been notified and will reply here shortly.\n\nFor urgent orders, share your order ID if you have one.`
  );

  return true;
}

module.exports = {
  SUPPORT_BUTTON_LABELS,
  isTemplateSupportButton,
  handleTemplateSupportButtonTap,
};
