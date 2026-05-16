"use strict";

const Client = require("../models/Client");
const Conversation = require("../models/Conversation");
const AdLead = require("../models/AdLead");
const MetaTemplate = require("../models/MetaTemplate");
const TemplateSendLog = require("../models/TemplateSendLog");
const WhatsApp = require("../utils/whatsapp");
const { buildSendContext, buildMetaTemplateComponents, resolveTemplateVariables } = require("./templateVariableResolver");
const { resolveTemplateForSend, isSendableMeta } = require("./templateResolver");
const { renderBrandedEmail } = require("./mjmlEmailRenderer");
const log = require("../utils/logger")("TemplateSender");

function mapTemplateDoc(resolved) {
  const t = resolved?.template;
  if (!t) return null;
  return {
    ...t,
    _id: t._id,
    metaTemplateName: t.metaTemplateName || t.name,
    variableMappings: t.variableMappings || t.variableMapping || resolved.prebuilt?.variableMappings,
  };
}

/**
 * Single entry point for sending templated WhatsApp (and optional email) messages.
 */
async function sendTemplatedMessage({ template, recipient, channel = "whatsapp", contextData = {} }) {
  const { phone, email, clientId } = recipient || {};
  if (!clientId || !phone) {
    return { whatsapp: { skipped: true, reason: "missing_recipient" } };
  }

  const [client, convo, lead] = await Promise.all([
    Client.findOne({ clientId }).lean(),
    Conversation.findOne({ clientId, phone }).lean(),
    AdLead.findOne({ clientId, phoneNumber: phone }).lean(),
  ]);
  if (!client) return { whatsapp: { skipped: true, reason: "client_not_found" } };

  const context = await buildSendContext({
    client,
    phone,
    convo,
    lead,
    order: contextData.order || null,
    cart: contextData.cart || null,
    extra: contextData.extra || {},
  });
  context._clientDoc = client;
  context._leadDoc = lead;

  const results = { whatsapp: null, email: null };
  const templateName = template?.metaTemplateName || template?.name;
  const synced = (client.syncedMetaTemplates || []).find((t) => t.name === templateName);
  const canSendWa =
    isSendableMeta(template) ||
    synced ||
    template?.submissionStatus === "approved" ||
    (synced && String(synced.status || "").toUpperCase() === "APPROVED");

  if ((channel === "whatsapp" || channel === "both") && templateName && canSendWa) {
    try {
      const metaPayload = synced
        ? { ...synced, variableMappings: template.variableMappings || template.variableMapping }
        : template;

      if (synced || template.components) {
        const components = await buildMetaTemplateComponents(
          metaPayload,
          context,
          { headerImageUrl: context.first_product_image || context.brand_logo_url }
        );
        await WhatsApp.sendTemplate(client, phone, templateName, template.language || "en", components);
        results.whatsapp = { sent: true, templateName, mode: "components" };
      } else if (isSendableMeta(template) || template.submissionStatus === "approved") {
        const mappings = template.variableMappings || template.variableMapping || {};
        const bodyMap = mappings.body || mappings;
        const vars = Object.keys(bodyMap)
          .map(Number)
          .filter((n) => !Number.isNaN(n))
          .sort((a, b) => a - b)
          .map((pos) => {
            const key = bodyMap[String(pos)] || bodyMap[pos];
            return context[key] || "-";
          });
        await WhatsApp.sendSmartTemplate(
          client,
          phone,
          templateName,
          vars,
          context.first_product_image || null,
          template.language || "en"
        );
        results.whatsapp = { sent: true, templateName, mode: "smart" };
      } else {
        results.whatsapp = { skipped: true, reason: "template_not_approved_or_synced" };
      }
    } catch (err) {
      results.whatsapp = { sent: false, error: err.message };
      log.warn(`WhatsApp send failed ${templateName}: ${err.message}`);
    }
  } else if (channel === "whatsapp" || channel === "both") {
    results.whatsapp = { skipped: true, reason: "template_not_sendable" };
  }

  if ((channel === "email" || channel === "both") && email) {
    try {
      const { sendEmail } = require("../utils/emailService");
      const bodyText = template.body
        ? await resolveTemplateVariables(template.body, context)
        : `Update from ${context.brand_name || client.businessName || "your store"}`;
      const html = renderBrandedEmail({
        brandName: context.brand_name || client.businessName,
        title: template.displayName || templateName,
        bodyHtml: bodyText.replace(/\n/g, "<br/>"),
        ctaUrl: context.checkout_url || context.tracking_url || null,
        ctaLabel: context.checkout_url ? "Complete order" : "Track order",
      });
      await sendEmail(client, {
        to: email,
        subject: template.displayName || templateName || "Store update",
        html,
      });
      results.email = { sent: true };
    } catch (err) {
      results.email = { sent: false, error: err.message };
      log.warn(`Email send failed: ${err.message}`);
    }
  }

  await TemplateSendLog.create({
    clientId,
    templateId: template?._id,
    templateName: templateName || "",
    channel,
    recipientPhone: phone,
    recipientEmail: email || "",
    contextData,
    resolvedVariables: { ...context },
    status: results.whatsapp?.sent || results.email?.sent ? "sent" : results.whatsapp?.skipped ? "skipped" : "failed",
    errorMessage: results.whatsapp?.error || results.email?.error || results.whatsapp?.reason || null,
  }).catch(() => {});

  if (template?._id && (results.whatsapp?.sent || results.email?.sent)) {
    await MetaTemplate.findByIdAndUpdate(template._id, {
      $inc: { totalSends: 1 },
      $set: { lastSentAt: new Date() },
    }).catch(() => {});
  }

  return results;
}

/**
 * Resolve by autoTrigger (order_placed, abandoned_cart, …) and send.
 */
async function sendByTrigger({ clientId, phone, trigger, templateName, contextData = {}, channel = "whatsapp", email }) {
  const resolved = await resolveTemplateForSend(clientId, { trigger, name: templateName });
  if (!resolved?.template) {
    log.debug(`[sendByTrigger] no template for ${clientId} trigger=${trigger} name=${templateName || ""}`);
    return { whatsapp: { skipped: true, reason: "no_template_for_trigger" }, trigger };
  }
  const doc = mapTemplateDoc(resolved);
  if (!isSendableMeta(doc) && resolved.source === "prebuilt_definition") {
    return { whatsapp: { skipped: true, reason: "prebuilt_not_approved" }, trigger };
  }
  return sendTemplatedMessage({
    template: doc,
    recipient: { clientId, phone, email: email || contextData.email },
    channel,
    contextData,
  });
}

/**
 * Resolve by template name and send.
 */
async function sendByName({ clientId, phone, templateName, contextData = {}, channel = "whatsapp", email }) {
  const resolved = await resolveTemplateForSend(clientId, { name: templateName });
  if (!resolved?.template) {
    return { whatsapp: { skipped: true, reason: "template_not_found" }, templateName };
  }
  return sendTemplatedMessage({
    template: mapTemplateDoc(resolved),
    recipient: { clientId, phone, email: email || contextData.email },
    channel,
    contextData,
  });
}

module.exports = {
  sendTemplatedMessage,
  sendByTrigger,
  sendByName,
};
