"use strict";

const Client = require("../models/Client");
const Conversation = require("../models/Conversation");
const AdLead = require("../models/AdLead");
const MetaTemplate = require("../models/MetaTemplate");
const TemplateSendLog = require("../models/TemplateSendLog");
const WhatsApp = require('../utils/meta/whatsapp');
const { buildSendContext, buildMetaTemplateComponents, resolveTemplateVariables } = require("./templateVariableResolver");
const { resolveTemplateForSend, isSendableMeta } = require("./templateResolver");
const { renderBrandedEmail } = require("./mjmlEmailRenderer");
const log = require('../utils/core/logger')("TemplateSender");
const { getSlotById } = require("../constants/templateCatalog/catalog");
const {
  getSendMetaNameCandidates,
  normalizeCodPrepaidTemplateName,
  CONTEXT_DEFAULT_TRIGGER,
  ORDER_STATUS_SLOT_BY_KEY,
  COD_PREPAID_CANONICAL_META_NAME,
} = require("../constants/templateCatalog/sendPolicy");
const { getPrebuiltByKey } = require("../constants/prebuiltTemplateLibrary");
const {
  mergeSendOverrides,
  resolveHeaderImageUrl,
} = require("./templateBrandOverrides");
const CART_RECOVERY_SLOT_IDS = new Set([
  "cart_recovery_1",
  "cart_recovery_2",
  "cart_recovery_3",
  "wizard_cart_1",
  "wizard_cart_2",
]);

function isCartRecoveryAutomation({ slotId, contextType, trigger } = {}) {
  return (
    contextType === "abandoned_cart" ||
    trigger === "abandoned_cart" ||
    (slotId && CART_RECOVERY_SLOT_IDS.has(slotId))
  );
}

function resolveAutomationEmail(email, contextData) {
  const raw =
    email ||
    contextData?.email ||
    contextData?.lead?.email ||
    contextData?.extra?.email ||
    null;
  return raw ? String(raw).trim().toLowerCase() : null;
}

function whatsappSendFailed(result) {
  return !result?.whatsapp?.sent;
}

async function applyCartRecoveryEmailIfNeeded(result, opts) {
  if (!opts.isCartRecovery || !opts.resolvedEmail || result?.email?.sent) return result;
  if (!whatsappSendFailed(result)) return result;
  const emailFallback = await sendCartRecoveryEmailFallback({
    clientId: opts.clientId,
    phone: opts.phone,
    email: opts.resolvedEmail,
    contextData: opts.contextData,
    logMeta: opts.logMeta || {},
  });
  return {
    ...result,
    ...emailFallback,
    failureCode: emailFallback?.email?.sent
      ? SEND_FAILURE_CODES.SENT
      : result.failureCode,
  };
}

/** Email fallback when WhatsApp cart recovery cannot be delivered. */
async function sendCartRecoveryEmailFallback({
  clientId,
  phone,
  email,
  contextData = {},
  logMeta = {},
}) {
  const customerEmail = resolveAutomationEmail(email, contextData);
  if (!customerEmail) {
    return { email: { skipped: true, reason: "no_email" } };
  }

  const client = await Client.findOne({ clientId }).lean();
  if (!client) {
    return { email: { skipped: true, reason: "client_not_found" } };
  }

  let lead = contextData.lead || null;
  if (!lead && phone) {
    lead = await AdLead.findOne({ clientId, phoneNumber: phone }).lean();
  }
  if (!lead) {
    lead = await AdLead.findOne({ clientId, email: customerEmail }).lean();
  }
  if (lead?.optStatus === "opted_out") {
    return { email: { skipped: true, reason: "opted_out" } };
  }

  const cart = contextData.cart || {};
  const snap = lead?.cartSnapshot || {};
  const storeHost = client.shopDomain
    ? String(client.shopDomain).replace(/^https?:\/\//, "").split("/")[0]
    : "";
  const token = lead?.checkoutToken || snap?.checkoutToken || "";
  const recoverFromToken =
    storeHost && token ? `https://${storeHost}/cart/recover/${token}` : "";
  const cartLink =
    lead?.checkoutUrl ||
    snap?.checkoutUrl ||
    cart.checkout_url ||
    contextData.extra?.checkout_url ||
    recoverFromToken ||
    "";

  if (!cartLink) {
    return { email: { skipped: true, reason: "no_checkout_url" } };
  }

  const lineItems = snap?.items || cart.line_items || [];
  const items = lineItems.map((i) => ({
    name: i.title || i.name,
    title: i.title || i.name,
    quantity: i.quantity || 1,
    price: i.price || i.line_price,
  }));

  try {
    const { sendAbandonedCartEmail } = require("../utils/core/emailService");
    await sendAbandonedCartEmail(client, {
      customerEmail,
      customerName: lead?.name || contextData.extra?.name,
      cartLink,
      items,
    });
    await logTemplateSendAttempt({
      clientId,
      template: null,
      recipient: { clientId, phone, email: customerEmail },
      channel: "email",
      contextData,
      result: { email: { sent: true, mode: "abandoned_cart_fallback" } },
      logMeta: { ...logMeta, contextType: "abandoned_cart", channel: "email_fallback" },
    });
    return { email: { sent: true, mode: "abandoned_cart_fallback" } };
  } catch (err) {
    log.warn(`Cart recovery email fallback failed: ${err.message}`);
    return { email: { sent: false, error: err.message } };
  }
}

/** Phase 3 — structured failure codes for ops / dashboards. */
const SEND_FAILURE_CODES = {
  SENT: "sent",
  SKIPPED: "skipped",
  MISSING_TEMPLATE: "missing_template",
  NOT_APPROVED: "not_approved",
  NO_MAPPING: "no_mapping",
  MISSING_RECIPIENT: "missing_recipient",
  CLIENT_NOT_FOUND: "client_not_found",
  SEND_ERROR: "send_error",
  PREBUILT_NOT_APPROVED: "prebuilt_not_approved",
};

function isTemplateSendableOnClient(template, client) {
  if (!template) return false;
  const templateName = template.metaTemplateName || template.name;
  const synced = (client?.syncedMetaTemplates || []).find((t) => t.name === templateName);
  return (
    isSendableMeta(template) ||
    template.submissionStatus === "approved" ||
    (synced && String(synced.status || "").toUpperCase() === "APPROVED")
  );
}

async function logTemplateSendAttempt({
  clientId,
  template,
  recipient,
  channel,
  contextData,
  result,
  logMeta = {},
}) {
  const templateName = template?.metaTemplateName || template?.name || logMeta.resolvedMetaName || "";
  let failureCode = SEND_FAILURE_CODES.SENT;
  let status = "sent";
  let errorMessage = null;

  if (result?.whatsapp?.sent || result?.email?.sent) {
    failureCode = SEND_FAILURE_CODES.SENT;
    status = "sent";
  } else if (result?.whatsapp?.skipped) {
    const reason = result.whatsapp.reason || "";
    failureCode =
      reason === "missing_recipient"
        ? SEND_FAILURE_CODES.MISSING_RECIPIENT
        : reason === "client_not_found"
          ? SEND_FAILURE_CODES.CLIENT_NOT_FOUND
          : reason === "template_not_sendable" || reason === "template_not_approved_or_synced"
            ? SEND_FAILURE_CODES.NOT_APPROVED
            : reason === "no_template_for_trigger" || reason === "template_not_found"
              ? SEND_FAILURE_CODES.MISSING_TEMPLATE
              : SEND_FAILURE_CODES.SKIPPED;
    status = "skipped";
    errorMessage = reason;
  } else if (result?.whatsapp?.error) {
    failureCode = SEND_FAILURE_CODES.SEND_ERROR;
    status = "failed";
    errorMessage = result.whatsapp.error;
  } else {
    failureCode = logMeta.failureCode || SEND_FAILURE_CODES.SKIPPED;
    status = "skipped";
    errorMessage = result?.whatsapp?.reason || null;
  }

  await TemplateSendLog.create({
    clientId,
    templateId: template?._id || null,
    templateName,
    automationSlotId: logMeta.automationSlotId || null,
    contextType: logMeta.contextType || null,
    failureCode,
    channel,
    recipientPhone: recipient?.phone || "",
    recipientEmail: recipient?.email || "",
    contextData,
    resolvedVariables: logMeta.resolvedVariables || {},
    status,
    messageId: logMeta.messageId || result?.whatsapp?.messageId || null,
    errorMessage,
  }).catch(() => {});

  if (failureCode !== SEND_FAILURE_CODES.SENT) {
    log.warn(
      `[TemplateSend] ${clientId} ${failureCode} slot=${logMeta.automationSlotId || "-"} name=${templateName} ${errorMessage || ""}`
    );
  }

  return failureCode;
}

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
async function sendTemplatedMessage({
  template,
  recipient,
  channel = "whatsapp",
  contextData = {},
  logMeta = {},
}) {
  const { phone, email, clientId } = recipient || {};
  if (!clientId) {
    const result = { whatsapp: { skipped: true, reason: "missing_recipient" } };
    await logTemplateSendAttempt({
      clientId: clientId || "",
      template,
      recipient,
      channel,
      contextData,
      result,
      logMeta: { ...logMeta, failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT },
    });
    return result;
  }
  if (channel === "whatsapp" && !phone) {
    const result = { whatsapp: { skipped: true, reason: "no_phone" } };
    await logTemplateSendAttempt({
      clientId,
      template,
      recipient,
      channel,
      contextData,
      result,
      logMeta: { ...logMeta, failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT },
    });
    return result;
  }
  if (channel === "email" && !email) {
    const result = { email: { skipped: true, reason: "no_email" } };
    await logTemplateSendAttempt({
      clientId,
      template,
      recipient,
      channel,
      contextData,
      result,
      logMeta: { ...logMeta, failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT },
    });
    return result;
  }
  if (channel === "both" && !phone && !email) {
    const result = {
      whatsapp: { skipped: true, reason: "no_phone" },
      email: { skipped: true, reason: "no_email" },
    };
    await logTemplateSendAttempt({
      clientId,
      template,
      recipient,
      channel,
      contextData,
      result,
      logMeta: { ...logMeta, failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT },
    });
    return result;
  }

  const leadQuery =
    phone
      ? { clientId, phoneNumber: phone }
      : email
        ? { clientId, email: String(email).trim().toLowerCase() }
        : null;

  const [client, convo, lead] = await Promise.all([
    Client.findOne({ clientId }).lean(),
    phone ? Conversation.findOne({ clientId, phone }).lean() : Promise.resolve(null),
    leadQuery ? AdLead.findOne(leadQuery).lean() : Promise.resolve(null),
  ]);
  if (!client) {
    const result = { whatsapp: { skipped: true, reason: "client_not_found" } };
    await logTemplateSendAttempt({
      clientId,
      template,
      recipient,
      channel,
      contextData,
      result,
      logMeta: { ...logMeta, failureCode: SEND_FAILURE_CODES.CLIENT_NOT_FOUND },
    });
    return result;
  }

  const context =
    contextData._flatContext ||
    (await buildSendContext({
      client,
      phone,
      convo,
      lead,
      order: contextData.order || null,
      cart: contextData.cart || null,
      extra: contextData.extra || {},
    }));
  if (!contextData._flatContext) {
    context._clientDoc = client;
    context._leadDoc = lead;
  }

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

      if (contextData._metaComponents?.length) {
        const resp = await WhatsApp.sendTemplate(
          client,
          phone,
          templateName,
          template.language || "en",
          contextData._metaComponents
        );
        results.whatsapp = {
          sent: true,
          templateName,
          mode: "components_override",
          messageId: resp?.messages?.[0]?.id || null,
        };
      } else if (synced || template.components) {
        const headerImageUrl = resolveHeaderImageUrl(
          context,
          template,
          client,
          logMeta.automationSlotId
        );
        const components = await buildMetaTemplateComponents(metaPayload, context, {
          headerImageUrl,
        });
        const resp = await WhatsApp.sendTemplate(client, phone, templateName, template.language || "en", components);
        results.whatsapp = {
          sent: true,
          templateName,
          mode: "components",
          messageId: resp?.messages?.[0]?.id || null,
        };
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
        const smartHeader = resolveHeaderImageUrl(
          context,
          template,
          client,
          logMeta.automationSlotId
        );
        const resp = await WhatsApp.sendSmartTemplate(
          client,
          phone,
          templateName,
          vars,
          smartHeader,
          template.language || "en"
        );
        results.whatsapp = {
          sent: true,
          templateName,
          mode: "smart",
          messageId: resp?.messages?.[0]?.id || null,
        };
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
      const { sendEmail } = require('../utils/core/emailService');
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

  await logTemplateSendAttempt({
    clientId,
    template,
    recipient: { clientId, phone, email },
    channel,
    contextData,
    result: results,
    logMeta: {
      ...logMeta,
      resolvedVariables: { ...context },
      messageId: results.whatsapp?.messageId || null,
    },
  });

  if (results.whatsapp?.sent) {
    try {
      const { persistAutomationOutbound } = require('../utils/messaging/persistAutomationOutbound');
      let bodyPreview = `[Template: ${templateName || 'automation'}]`;
      if (template?.body) {
        bodyPreview = String(
          await resolveTemplateVariables(template.body, context)
        ).slice(0, 500);
      }
      await persistAutomationOutbound({
        clientId,
        phone,
        templateName,
        bodyPreview,
        messageId: results.whatsapp.messageId,
        metadata: {
          automationSlotId: logMeta.automationSlotId || null,
          automation_rule_id: logMeta.automationSlotId || logMeta.automationRuleId || null,
          contextType: logMeta.contextType || null,
          templateName: templateName || undefined,
        },
      });
    } catch (persistErr) {
      log.warn(`Inbox persist after template send failed: ${persistErr.message}`);
    }
  }

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
  if (trigger === "abandoned_cart") {
    return sendForAutomation({
      clientId,
      phone,
      slotId: "cart_recovery_1",
      metaName: templateName,
      contextType: "abandoned_cart",
      trigger,
      contextData,
      channel,
      email,
    });
  }
  const { getSlotByMetaName } = require("../constants/templateCatalog/catalog");
  const slot = templateName ? getSlotByMetaName(templateName) : null;
  return sendForAutomation({
    clientId,
    phone,
    slotId: slot?.id || null,
    metaName: templateName || null,
    contextType: "flow",
    trigger,
    contextData,
    channel,
    email,
  });
}

/**
 * Resolve by template name and send.
 */
async function sendByName({ clientId, phone, templateName, contextData = {}, channel = "whatsapp", email }) {
  const normalized = normalizeCodPrepaidTemplateName(templateName);
  if (normalized === COD_PREPAID_CANONICAL_META_NAME || templateName !== normalized) {
    return sendForAutomation({
      clientId,
      phone,
      slotId: "eco_cod_prepaid",
      metaName: templateName,
      contextType: "cod_prepaid",
      contextData,
      channel,
      email,
    });
  }
  const { getSlotByMetaName } = require("../constants/templateCatalog/catalog");
  const slot = getSlotByMetaName(templateName);
  return sendForAutomation({
    clientId,
    phone,
    slotId: slot?.id || null,
    metaName: templateName,
    contextType: "flow",
    contextData,
    channel,
    email,
  });
}

/**
 * Build send context from automation contextType + payload.
 */
async function buildContextForAutomation({ clientId, phone, contextType, contextData = {} }) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return null;

  const convo = await Conversation.findOne({ clientId, phone }).lean();
  const lead =
    contextData.lead ||
    (await AdLead.findOne({ clientId, phoneNumber: phone }).lean());

  if (contextType === "order") {
    const ctx = await buildSendContext({
      client,
      phone,
      convo,
      lead,
      order: contextData.order || null,
      extra: contextData.extra || {},
    });
    ctx._clientDoc = client;
    ctx._leadDoc = lead;
    return ctx;
  }

  if (contextType === "abandoned_cart") {
    const snap = lead?.cartSnapshot || contextData.cart?.line_items ? contextData.cart : {};
    const cart = {
      checkout_url:
        lead?.checkoutUrl ||
        lead?.cartSnapshot?.checkoutUrl ||
        contextData.cart?.checkout_url ||
        contextData.extra?.checkout_url ||
        "",
      total_price:
        snap?.totalPrice ??
        contextData.cart?.total_price ??
        lead?.cartValue,
      line_items: snap?.items || contextData.cart?.line_items || [],
    };
    const ctx = await buildSendContext({
      client,
      phone,
      convo,
      lead,
      cart,
      extra: { name: lead?.name, ...(contextData.extra || {}) },
    });
    ctx._clientDoc = client;
    ctx._leadDoc = lead;
    return ctx;
  }

  const ctx = await buildSendContext({
    client,
    phone,
    convo,
    lead,
    order: contextData.order || null,
    cart: contextData.cart || null,
    extra: contextData.extra || contextData || {},
  });
  ctx._clientDoc = client;
  ctx._leadDoc = lead;
  return ctx;
}

async function resolveSendableTemplateForAutomation(
  clientId,
  { slotId, metaName, trigger, contextType } = {}
) {
  const slot = slotId ? getSlotById(slotId) : null;
  const normalizedMeta = metaName ? normalizeCodPrepaidTemplateName(metaName) : null;
  const autoTrigger =
    trigger ||
    slot?.autoTrigger ||
    (contextType && CONTEXT_DEFAULT_TRIGGER[contextType]) ||
    null;

  const candidates = getSendMetaNameCandidates(slotId, normalizedMeta || metaName);

  for (const candidateName of candidates) {
    const prebuiltKey = slot?.prebuiltKey || candidateName;
    let resolved = await resolveTemplateForSend(clientId, {
      name: candidateName,
      templateKey: getPrebuiltByKey(prebuiltKey)?.key,
    });
    if (!resolved?.template && autoTrigger) {
      resolved = await resolveTemplateForSend(clientId, { trigger: autoTrigger, name: candidateName });
    }
    if (!resolved?.template) continue;

    const doc = mapTemplateDoc(resolved);
    const client = await Client.findOne({ clientId }).select("syncedMetaTemplates").lean();
    const sendable =
      isTemplateSendableOnClient(doc, client) || resolved.source === "synced_meta";

    return {
      resolved,
      doc,
      metaName: candidateName,
      slotId: slot?.id || slotId || null,
      sendable,
      prebuilt: resolved.prebuilt,
    };
  }

  return null;
}

/**
 * Phase 3 unified send entry — resolve catalog slot / name, registry variables, log failures.
 */
async function sendForAutomation({
  clientId,
  phone,
  slotId = null,
  metaName = null,
  contextType = "order",
  contextData = {},
  channel = "whatsapp",
  email = null,
  trigger = null,
  variableMappings = null,
}) {
  // NOTE (WS-2 fix, June 2026): the previous `sendEnvelope` short-circuit was
  // passing empty `components: []` to Meta, which silently rejected every
  // template that had body variables (i.e. all order + cart templates).
  // We now always run the full resolution path below — it builds components
  // from `variableMappings + flatContext` via `buildMetaTemplateComponents`
  // and calls `WhatsApp.sendTemplate` directly. Consent / idempotency /
  // rate-limit checks should be re-introduced as a pre-step (not a short
  // circuit) once they can accept the resolved components payload.

  const isCartRecovery = isCartRecoveryAutomation({ slotId, contextType, trigger });
  const resolvedEmail = resolveAutomationEmail(email, contextData);

  if (!clientId || (!phone && !(isCartRecovery && resolvedEmail))) {
    await logTemplateSendAttempt({
      clientId: clientId || "",
      template: null,
      recipient: { clientId, phone, email: resolvedEmail },
      channel,
      contextData,
      result: { whatsapp: { skipped: true, reason: "missing_recipient" } },
      logMeta: {
        automationSlotId: slotId,
        contextType,
        failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT,
      },
    });
    return {
      whatsapp: { skipped: true, reason: "missing_recipient", failureCode: SEND_FAILURE_CODES.MISSING_RECIPIENT },
      slotId,
      metaName,
    };
  }

  if (!phone && isCartRecovery && resolvedEmail) {
    const emailOnly = await sendCartRecoveryEmailFallback({
      clientId,
      phone: null,
      email: resolvedEmail,
      contextData,
      logMeta: { automationSlotId: slotId, contextType },
    });
    return {
      whatsapp: { skipped: true, reason: "no_phone_email_only" },
      ...emailOnly,
      slotId,
      metaName,
      failureCode: emailOnly?.email?.sent ? SEND_FAILURE_CODES.SENT : SEND_FAILURE_CODES.SKIPPED,
    };
  }

  const hit = await resolveSendableTemplateForAutomation(clientId, {
    slotId,
    metaName,
    trigger,
    contextType,
  });

  if (!hit) {
    const code = slotId || metaName ? SEND_FAILURE_CODES.MISSING_TEMPLATE : SEND_FAILURE_CODES.NO_MAPPING;
    await logTemplateSendAttempt({
      clientId,
      template: null,
      recipient: { clientId, phone, email },
      channel,
      contextData,
      result: { whatsapp: { skipped: true, reason: code } },
      logMeta: { automationSlotId: slotId, contextType, failureCode: code, resolvedMetaName: metaName },
    });
    return applyCartRecoveryEmailIfNeeded(
      {
        whatsapp: { skipped: true, reason: code, failureCode: code },
        slotId,
        metaName: metaName || null,
      },
      { isCartRecovery, resolvedEmail, clientId, phone, contextData, logMeta: { automationSlotId: slotId, contextType } }
    );
  }

  if (!hit.sendable && hit.resolved?.source === "prebuilt_definition") {
    await logTemplateSendAttempt({
      clientId,
      template: hit.doc,
      recipient: { clientId, phone, email },
      channel,
      contextData,
      result: { whatsapp: { skipped: true, reason: "prebuilt_not_approved" } },
      logMeta: {
        automationSlotId: hit.slotId,
        contextType,
        failureCode: SEND_FAILURE_CODES.PREBUILT_NOT_APPROVED,
        resolvedMetaName: hit.metaName,
      },
    });
    return applyCartRecoveryEmailIfNeeded(
      {
        whatsapp: {
          skipped: true,
          reason: "prebuilt_not_approved",
          failureCode: SEND_FAILURE_CODES.PREBUILT_NOT_APPROVED,
        },
        slotId: hit.slotId,
        metaName: hit.metaName,
      },
      {
        isCartRecovery,
        resolvedEmail,
        clientId,
        phone,
        contextData,
        logMeta: { automationSlotId: hit.slotId, contextType },
      }
    );
  }

  if (!hit.sendable) {
    await logTemplateSendAttempt({
      clientId,
      template: hit.doc,
      recipient: { clientId, phone, email },
      channel,
      contextData,
      result: { whatsapp: { skipped: true, reason: "not_approved" } },
      logMeta: {
        automationSlotId: hit.slotId,
        contextType,
        failureCode: SEND_FAILURE_CODES.NOT_APPROVED,
        resolvedMetaName: hit.metaName,
      },
    });
    return applyCartRecoveryEmailIfNeeded(
      {
        whatsapp: {
          skipped: true,
          reason: "not_approved",
          failureCode: SEND_FAILURE_CODES.NOT_APPROVED,
        },
        slotId: hit.slotId,
        metaName: hit.metaName,
      },
      {
        isCartRecovery,
        resolvedEmail,
        clientId,
        phone,
        contextData,
        logMeta: { automationSlotId: hit.slotId, contextType },
      }
    );
  }

  const slot = hit.slotId ? getSlotById(hit.slotId) : null;
  const prebuilt = getPrebuiltByKey(slot?.prebuiltKey || hit.metaName);
  const mergedMappings =
    variableMappings ||
    hit.doc.variableMappings ||
    prebuilt?.variableMappings ||
    null;

  const clientForOverrides = await Client.findOne({ clientId })
    .select("templateBrandOverrides brand businessName syncedMetaTemplates")
    .lean();

  let templatePayload = {
    ...hit.doc,
    name: hit.metaName,
    metaTemplateName: hit.metaName,
    variableMappings: mergedMappings,
  };
  templatePayload = mergeSendOverrides({
    templatePayload,
    slotId: hit.slotId,
    client: clientForOverrides,
  });

  if (templatePayload._sendDisabled) {
    await logTemplateSendAttempt({
      clientId,
      template: hit.doc,
      recipient: { clientId, phone, email },
      channel,
      contextData,
      result: { whatsapp: { skipped: true, reason: "slot_disabled" } },
      logMeta: {
        automationSlotId: hit.slotId,
        contextType,
        failureCode: SEND_FAILURE_CODES.SKIPPED,
        resolvedMetaName: hit.metaName,
      },
    });
    return applyCartRecoveryEmailIfNeeded(
      {
        whatsapp: { skipped: true, reason: "slot_disabled", failureCode: SEND_FAILURE_CODES.SKIPPED },
        slotId: hit.slotId,
        metaName: hit.metaName,
      },
      {
        isCartRecovery,
        resolvedEmail,
        clientId,
        phone,
        contextData,
        logMeta: { automationSlotId: hit.slotId, contextType },
      }
    );
  }

  const flatContext = await buildContextForAutomation({
    clientId,
    phone,
    contextType,
    contextData,
  });

  const result = await sendTemplatedMessage({
    template: templatePayload,
    recipient: { clientId, phone, email: resolvedEmail || email || contextData.email },
    channel,
    contextData: { ...contextData, _flatContext: flatContext },
    logMeta: {
      automationSlotId: hit.slotId,
      contextType,
      resolvedMetaName: hit.metaName,
    },
  });

  let merged = { ...result };
  if (
    isCartRecovery &&
    whatsappSendFailed(result) &&
    resolvedEmail
  ) {
    const emailFallback = await sendCartRecoveryEmailFallback({
      clientId,
      phone,
      email: resolvedEmail,
      contextData,
      logMeta: {
        automationSlotId: hit.slotId,
        contextType,
        resolvedMetaName: hit.metaName,
      },
    });
    merged = { ...merged, ...emailFallback };
  }

  const failureCode =
    merged?.whatsapp?.sent || merged?.email?.sent
      ? SEND_FAILURE_CODES.SENT
      : merged?.whatsapp?.reason === "template_not_sendable"
        ? SEND_FAILURE_CODES.NOT_APPROVED
        : SEND_FAILURE_CODES.SKIPPED;

  return {
    ...merged,
    slotId: hit.slotId,
    metaName: hit.metaName,
    failureCode,
  };
}

/** Order status helper — maps paid/shipped/delivered to eco slots. */
async function sendOrderStatusAutomation({
  clientId,
  phone,
  statusKey,
  order,
  trackingUrl,
  trackingNumber,
  nicheData,
}) {
  const { buildOrderContextForTemplate } = require("../utils/commerce/orderStatusTemplatePolicy");
  const mapKey = String(statusKey || "").toLowerCase();
  const slotId = ORDER_STATUS_SLOT_BY_KEY[mapKey] || null;
  const orderCtx = buildOrderContextForTemplate(order, { trackingUrl, trackingNumber, nicheData });

  return sendForAutomation({
    clientId,
    phone,
    slotId,
    contextType: "order",
    contextData: { order: orderCtx },
    channel: "whatsapp",
  });
}

module.exports = {
  SEND_FAILURE_CODES,
  sendTemplatedMessage,
  sendByTrigger,
  sendByName,
  sendForAutomation,
  sendOrderStatusAutomation,
  buildContextForAutomation,
  resolveSendableTemplateForAutomation,
  ORDER_STATUS_SLOT_BY_KEY,
  COD_PREPAID_CANONICAL_META_NAME,
};
