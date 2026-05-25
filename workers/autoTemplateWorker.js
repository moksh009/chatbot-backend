"use strict";

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('[AutoTemplateWorker] Connected to MongoDB'))
    .catch(err => console.error('[AutoTemplateWorker] MongoDB connection error:', err));
}

/**
 * Auto Template Worker — BullMQ workers for template generation, submission, and polling.
 * Requires autoTemplateQueues.js for queue instances.
 */
const { Worker } = require('bullmq');
const axios = require('axios');
const log = require('../utils/core/logger')('AutoTemplateWorker');
const {
  redisConnection,
  generationQueue,
  submissionSchedulerQueue,
  batchSubmitterQueue,
  statusPollerQueue,
  rescheduleSubmissionCheck,
  registerStatusPoller
} = require('./autoTemplateQueues');

const Client = require('../models/Client');
const MetaTemplate = require('../models/MetaTemplate');
const TemplateGenerationJob = require('../models/TemplateGenerationJob');
const SubmissionQueueItem = require('../models/SubmissionQueueItem');
const SubmissionLog = require('../models/SubmissionLog');
const { platformGenerateText } = require('../utils/core/gemini');
const { decrypt } = require('../utils/core/encryption');
const { PREBUILT_REQUIRED_TEMPLATES } = require('../constants/templateLifecycle');
const { getPrebuiltByKey } = require('../constants/prebuiltTemplateLibrary');
const {
  sanitizeMetaTemplateBodyForSubmission,
  validateMetaTemplateForSubmission,
} = require('../utils/meta/metaTemplateCompliance');
const { buildFormDataFromLibraryEntry } = require('../utils/meta/metaTemplateFormHydration');

function normalizeMetaLanguage(raw) {
  const v = String(raw || "").trim().toLowerCase().replace("-", "_");
  if (!v) return "en";
  if (v === "hinglish" || v === "guajarlish") return "en";
  if (v === "english") return "en";
  if (v === "hindi" || v === "hi_in") return "hi";
  if (v === "gujarati" || v === "gu_in") return "gu";
  return v;
}

// ─── FIXED TEMPLATE DEFINITIONS ───────────────────────────────────────────────
const FIXED_TEMPLATES = {
  welcome_with_logo: {
    category: 'UTILITY',
    purpose: 'Welcome first-time user and introduce support channels.',
    variables: { '1': 'Customer Name', '2': 'Brand Name' },
    bodyText: 'Hi {{1}}, welcome to {{2}}. We are here to help you with orders, support, and updates anytime.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Browse Products' }, { type: 'QUICK_REPLY', text: 'Talk to Support' }]
  },
  order_confirmed: {
    category: 'UTILITY',
    purpose: 'Confirm a new order has been received and is being processed. Include order number and total amount.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Order Total' },
    bodyText: 'Hi {{1}}, your order {{2}} has been confirmed! We are processing it now. Your total is {{3}}. Thank you — we will update you when it ships.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }]
  },
  shipping_update: {
    category: 'UTILITY',
    purpose: 'Notify the customer that their order has shipped. Include order number and tracking information.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Tracking URL' },
    bodyText: 'Hi {{1}}, good news! Your order {{2}} has shipped. Track your package here: {{3}} Reply here if the link does not open.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Package' }]
  },
  order_delivered: {
    category: 'UTILITY',
    purpose: 'Confirm successful delivery and ask for feedback or review.',
    variables: { '1': 'Customer Name', '2': 'Order Number' },
    bodyText: 'Hi {{1}}, your order {{2}} has been delivered. We hope you love it!',
    buttons: [{ type: 'QUICK_REPLY', text: 'Leave a Review' }, { type: 'QUICK_REPLY', text: 'Need Help' }]
  },
  order_cancelled: {
    category: 'UTILITY',
    purpose: 'Notify customer of cancellation & refund status.',
    variables: { '1': 'Customer Name', '2': 'Order Number' },
    bodyText: 'Hi {{1}}, your order {{2}} has been cancelled as requested. Any applicable refunds will be processed within 5-7 business days.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Contact Support' }]
  },
  cod_to_prepaid: {
    category: 'MARKETING',
    purpose: 'Offer a discount to convert Cash on Delivery to Prepaid.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Discount Amount', '4': 'Payment Link' },
    bodyText: 'Hi {{1}}, convert your COD order {{2}} to prepaid and get an instant {{3}} discount! Pay securely here: {{4}} Reply here if you need help.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Pay Now' }]
  },
  warranty_registration: {
    category: 'UTILITY',
    purpose: 'Send warranty activation link post-purchase.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Warranty Link' },
    bodyText: 'Hi {{1}}, protect your new purchase! Register your warranty for order {{2}} within the next 48 hours using this link: {{3}} Message us here with questions.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Register Warranty' }]
  },
  loyalty_points: {
    category: 'MARKETING',
    purpose: 'Update customer on points earned/balance.',
    variables: { '1': 'Customer Name', '2': 'Points Earned', '3': 'Total Points' },
    bodyText: 'Hi {{1}}, you have earned {{2}} loyalty points on your recent order! You now have a total of {{3}} points to redeem on your next purchase.',
    buttons: [{ type: 'QUICK_REPLY', text: 'View Rewards' }]
  },
  cart_recovery_1: {
    category: 'MARKETING',
    purpose: 'A polite first nudge sent 30 minutes after cart abandonment.',
    variables: { '1': 'Customer Name', '2': 'Product Name', '3': 'Cart Total', '4': 'Checkout URL' },
    bodyText: 'Hi {{1}}, you left {{2}} in your cart! Your total is {{3}}. Complete your order before it sells out here: {{4}} Thanks for shopping with us!',
    buttons: [{ type: 'QUICK_REPLY', text: 'Complete Order' }]
  },
  cart_recovery_2: {
    category: 'MARKETING',
    purpose: 'A second follow-up sent 24 hours after abandonment.',
    variables: { '1': 'Customer Name', '2': 'Product Name', '3': 'Checkout URL' },
    bodyText: 'Hi {{1}}, your {{2}} is still reserved! Complete your purchase today with a special discount using this link: {{3}} We are here if you need help.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }, { type: 'QUICK_REPLY', text: 'Help Me' }]
  },
  admin_human_alert: {
    category: 'UTILITY',
    purpose: 'Notify admin/support for urgent takeover events.',
    variables: { '1': 'Customer Name', '2': 'Customer Phone', '3': 'Issue Summary' },
    bodyText: 'Admin alert: {{1}} ({{2}}) needs urgent support. Context: {{3}} Please open the inbox in the dashboard.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Open Inbox' }]
  }
};

// ─── HELPER: Build a snake_case template name from product handle ──────────
function buildProductTemplateName(handle) {
  if (!handle) return `product_${Date.now()}`;
  return handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

// ─── HELPER: Find unique template name (collision loop) ────────────────────
async function getUniqueTemplateName(clientId, baseName) {
  const client = await Client.findOne({ clientId }).select("syncedMetaTemplates").lean();
  const synced = client?.syncedMetaTemplates || [];
  const onMeta = synced.some((t) => String(t.name || "").toLowerCase() === String(baseName).toLowerCase());
  if (onMeta) return baseName;

  const existing = await MetaTemplate.findOne({ clientId, name: baseName }).lean();
  if (!existing) return baseName;
  if (["approved", "pending_meta_review"].includes(existing.submissionStatus)) {
    return baseName;
  }
  // Reuse stable name for failed/draft retries — avoid cart_recovery_1_2 spam on Meta
  if (["submission_failed", "rejected", "draft", "generation_failed", "queued"].includes(existing.submissionStatus)) {
    return baseName;
  }

  let name = baseName;
  let suffix = 1;
  while (await MetaTemplate.findOne({
    clientId,
    name,
    _id: { $ne: existing._id },
    submissionStatus: { $nin: ["approved", "pending_meta_review"] },
  })) {
    suffix++;
    name = `${baseName.slice(0, 47)}_${suffix}`;
  }
  return name;
}

// ─── HELPER: Emit to frontend via Socket.io ────────────────────────────────
function emitToClient(clientId, event, data) {
  try {
    const { getIO } = require('../utils/core/socket');
    getIO().to(`client_${clientId}`).emit(event, data);
  } catch (e) { /* socket may not be initialized in worker context */ }
}

// ─── GENERATION: Fixed Templates ────────────────────────────────────────
async function generateFixedTemplate(templateId, ctx) {
  const { getPrebuiltByKey } = require('../constants/prebuiltTemplateLibrary');
  const lib = getPrebuiltByKey(templateId);
  const def = FIXED_TEMPLATES[templateId];
  if (!def && !lib) throw new Error(`Unknown fixed template: ${templateId}`);

  const body = lib?.bodyText || def.bodyText;
  const category = lib?.category || def.category;
  let headerType = 'TEXT';
  let headerValue = ctx.brandName;
  if (lib?.headerType === 'IMAGE') {
    headerType = 'IMAGE';
    headerValue = '';
  } else if (lib?.headerText) {
    headerValue = lib.headerText;
  }

  const legacyMap = def?.variables || {};
  const variableMappings = lib?.variableMappings || null;
  const variableMapping =
    variableMappings?.body
      ? Object.fromEntries(Object.entries(variableMappings.body).map(([k, v]) => [k, v]))
      : legacyMap;

  return {
    body,
    category,
    headerType,
    headerValue,
    buttons: lib?.buttons || def?.buttons,
    variableMapping,
    variableMappings,
    autoTrigger: lib?.autoTrigger || null,
    isPrebuilt: true,
    templateKey: lib?.key || templateId,
    metaName: lib?.metaName || templateId,
  };
}

// ─── AI GENERATION: single-line tagline for variable {{3}} on product templates ──
async function generateProductTagline(ctx) {
  const prompt = `Write ONE short line (max 70 characters) for a WhatsApp product card. Tone: ${ctx.tone}. Brand: ${ctx.brandName}.

Product: ${ctx.productName}
Price: ${ctx.currency}${ctx.productPrice}
Notes: ${(ctx.productDescription || '').slice(0, 160)}

Rules: no placeholders, no emojis overload (one max), no "click here/buy now", no ALL CAPS. Concrete benefit only.

Return only that line, nothing else.`;

  const line = await platformGenerateText(prompt, { maxTokens: 96, temperature: 0.65 });
  if (!line) throw new Error(`AI tagline returned null for product ${ctx.productName}`);
  return { tagline: line.trim().slice(0, 72) };
}

function cleanShortText(value, max = 100) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function isRequiredPrebuiltDraft(draft) {
  if (!draft) return false;
  if (draft.isPrebuilt) return true;
  const key = draft.templateKey || draft.autoGenProductId || "";
  if (PREBUILT_REQUIRED_TEMPLATES.includes(key)) return true;
  const lib = getPrebuiltByKey(key);
  return !!(lib && PREBUILT_REQUIRED_TEMPLATES.includes(lib.metaName));
}

/** Stop queued Meta submissions and return drafts to review state. */
async function cancelClientSubmissions(clientId) {
  await SubmissionQueueItem.deleteMany({ clientId, status: { $in: ["queued", "submitting"] } });
  await MetaTemplate.updateMany(
    { clientId, source: "auto_generated", submissionStatus: { $in: ["queued", "submitting"] } },
    { $set: { submissionStatus: "draft", queuePosition: null, updatedAt: new Date() } }
  );
  await TemplateGenerationJob.findOneAndUpdate(
    { clientId },
    {
      $set: {
        status: "drafts_ready",
        userSubmissionActive: false,
        pausedByUser: false,
        nextBatchCheckAt: null,
        updatedAt: new Date(),
      },
    }
  );
  log.info(`[AutoTemplate] Cancelled submission queue for ${clientId}`);
}

// ─── BUILD SUBMISSION QUEUE ────────────────────────────────────────────────
async function buildSubmissionQueue(clientId) {
  await SubmissionQueueItem.deleteMany({ clientId, status: { $in: ["queued", "submitting"] } });

  const drafts = await MetaTemplate.find({
    clientId,
    source: "auto_generated",
    submissionStatus: { $in: ["draft", "generation_failed"] },
  }).lean();

  const eligible = drafts.filter((d) => isRequiredPrebuiltDraft(d) && d.templateKind !== "product");
  eligible.sort((a, b) => {
    const aKey = getPrebuiltByKey(a.templateKey || a.autoGenProductId)?.metaName || a.name;
    const bKey = getPrebuiltByKey(b.templateKey || b.autoGenProductId)?.metaName || b.name;
    return PREBUILT_REQUIRED_TEMPLATES.indexOf(aKey) - PREBUILT_REQUIRED_TEMPLATES.indexOf(bKey);
  });

  const ordered = [];
  const skipped = [];

  for (let i = 0; i < eligible.length; i++) {
    const t = eligible[i];
    const full = await MetaTemplate.findById(t._id).lean();
    const check = validateMetaTemplateForSubmission(full);
    if (!check.valid) {
      skipped.push({ name: t.name, errors: check.errors });
      await MetaTemplate.findByIdAndUpdate(t._id, {
        $set: {
          submissionStatus: "draft",
          rejectionReason: `Not ready for Meta: ${check.errors.join(" ")}`,
          updatedAt: new Date(),
        },
      });
      continue;
    }
    if (check.sanitizedBody && check.sanitizedBody !== full.body) {
      await MetaTemplate.findByIdAndUpdate(t._id, { $set: { body: check.sanitizedBody, updatedAt: new Date() } });
    }
    ordered.push({ ...t, batchNumber: 1, queuePosition: ordered.length + 1 });
  }

  if (ordered.length === 0) {
    const err = new Error(
      skipped.length
        ? `No templates passed compliance checks. Fix drafts first (${skipped.length} blocked).`
        : "No eligible prebuilt drafts to submit."
    );
    err.skipped = skipped;
    throw err;
  }

  const bulkOps = ordered.map((t) => ({
    clientId,
    templateId: t._id,
    queuePosition: t.queuePosition,
    batchNumber: t.batchNumber,
    status: "queued",
  }));
  await SubmissionQueueItem.insertMany(bulkOps);

  for (const t of ordered) {
    await MetaTemplate.findByIdAndUpdate(t._id, {
      $set: { submissionStatus: "queued", queuePosition: t.queuePosition, updatedAt: new Date() },
    });
  }

  await TemplateGenerationJob.findOneAndUpdate(
    { clientId },
    {
      $set: {
        status: "submitting",
        userSubmissionActive: true,
        pausedByUser: false,
        updatedAt: new Date(),
      },
    }
  );

  await rescheduleSubmissionCheck(clientId, 0.1);
  log.info(`[AutoTemplate] User-initiated queue for ${clientId}: ${ordered.length} template(s)${skipped.length ? `, ${skipped.length} skipped` : ""}`);
  return { queued: ordered.length, skipped };
}

// ─── SUBMIT SINGLE TEMPLATE TO META ────────────────────────────────────────
async function submitSingleTemplate(client, templateId, clientId) {
  const template = await MetaTemplate.findById(templateId);
  if (!template) {
    log.error(`[Template Submit] Template ${templateId} not found`);
    return;
  }

  await SubmissionQueueItem.findOneAndUpdate(
    { clientId, templateId },
    { $set: { status: 'submitting', submittedAt: new Date() } }
  );
  template.submissionStatus = 'submitting';
  await template.save();

  // Build Meta API components
  const components = [];

  const ht = (template.headerType || 'TEXT').toUpperCase();
  if (ht === 'IMAGE' && template.headerValue) {
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_url: [template.headerValue] }
    });
  } else if (ht === 'TEXT' && template.headerValue) {
    components.push({ type: 'HEADER', format: 'TEXT', text: template.headerValue });
  }

  const safeBody = sanitizeMetaTemplateBodyForSubmission(template.body);
  if (safeBody !== template.body) {
    template.body = safeBody;
    await template.save().catch(() => {});
  }

  const bodyComponent = { type: 'BODY', text: safeBody };
  let vm = template.variableMapping;
  if (vm && !(vm instanceof Map)) {
    vm = new Map(Object.entries(vm));
  }
  if (vm instanceof Map && vm.size > 0) {
    const ordered = Array.from(vm.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, v]) => String(v));
    bodyComponent.example = { body_text: [ordered] };
  }
  components.push(bodyComponent);

  if (template.footerText) {
    components.push({ type: 'FOOTER', text: template.footerText });
  }

  if (template.buttons && template.buttons.length > 0) {
    const buttonComponents = template.buttons.map(btn => {
      if (btn.type === 'URL') return { type: 'url', text: btn.text, url: btn.url };
      if (btn.type === 'QUICK_REPLY') return { type: 'quick_reply', text: btn.text };
      return null;
    }).filter(Boolean);
    if (buttonComponents.length > 0) {
      components.push({ type: 'BUTTONS', buttons: buttonComponents });
    }
  }

  const compliance = validateMetaTemplateForSubmission(template);
  if (!compliance.valid) {
    template.submissionStatus = "submission_failed";
    template.rejectionReason = compliance.errors.join(" ");
    await template.save();
    await SubmissionQueueItem.findOneAndUpdate(
      { clientId, templateId },
      { $set: { status: "failed", failureReason: template.rejectionReason } }
    );
    await SubmissionLog.create({
      clientId,
      templateId: template._id,
      templateName: template.name,
      action: "blocked_validation",
      metaResponse: { errors: compliance.errors },
    });
    return;
  }

  const payload = {
    name: template.name,
    category: template.category,
    language: normalizeMetaLanguage(template.language),
    components
  };

  if (!client) {
    template.submissionStatus = 'submission_failed';
    template.rejectionReason = 'Client configuration not found during submission';
    await template.save();
    return;
  }

  const token = decrypt(client.whatsappToken) || client.whatsappToken;
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  if (!token || !wabaId) {
    template.submissionStatus = 'submission_failed';
    template.rejectionReason = 'Missing WhatsApp credentials for submission';
    await template.save();
    return;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      payload,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    template.submissionStatus = 'pending_meta_review';
    template.metaTemplateId = response.data.id;
    template.submittedAt = new Date();
    await template.save();

    await SubmissionQueueItem.findOneAndUpdate(
      { clientId, templateId }, { $set: { status: 'submitted' } }
    );
    await SubmissionLog.create({
      clientId, templateId: template._id, templateName: template.name,
      action: 'submitted', metaResponse: response.data
    });

    log.info(`[Template Submit] Submitted: ${template.name} for ${clientId}. Meta ID: ${response.data.id}`);
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const errorData = err.response.data?.error;

      if (status === 429) {
        log.warn(`[Template Submit] Rate limited for ${clientId}. Backing off 2 hours.`);
        template.submissionStatus = 'queued';
        await template.save();
        await SubmissionQueueItem.findOneAndUpdate({ clientId, templateId }, { $set: { status: 'queued' } });
        await rescheduleSubmissionCheck(clientId, 120); // 2 HOURS
        await SubmissionLog.create({ clientId, templateId: template._id, templateName: template.name, action: 'rate_limited', metaResponse: errorData });
        return;
      }

      if (errorData?.code === 190) {
        log.error(`[Template Submit] Token expired for ${clientId}`);
        emitToClient(clientId, 'metaTokenExpired', { message: 'Your Meta access token has expired. Please reconnect in Settings → Integrations.' });
        template.submissionStatus = 'submission_failed';
        template.rejectionReason = 'Meta access token expired';
        await template.save();
        return;
      }

      // Meta: content in this language already exists (duplicate submit)
      if (errorData?.error_subcode === 2388024 || /already exists/i.test(errorData?.error_user_msg || "")) {
        log.warn(`[Template Submit] ${template.name} already exists on Meta — marking pending review`);
        template.submissionStatus = "pending_meta_review";
        template.rejectionReason = null;
        template.metaApiError = "Already exists on Meta (synced)";
        await template.save();
        await SubmissionQueueItem.findOneAndUpdate(
          { clientId, templateId },
          { $set: { status: "submitted" } }
        );
        await SubmissionLog.create({
          clientId,
          templateId: template._id,
          templateName: template.name,
          action: "duplicate_language_skipped",
          metaResponse: errorData,
        });
        return;
      }

      log.error(`[Template Submit] Meta API error for ${template.name}:`, JSON.stringify(errorData));
      template.submissionStatus = 'submission_failed';
      template.rejectionReason = errorData?.message || 'Unknown Meta API error';
      await template.save();
      await SubmissionQueueItem.findOneAndUpdate({ clientId, templateId }, { $set: { status: 'failed', failureReason: template.rejectionReason } });
      await SubmissionLog.create({ clientId, templateId: template._id, templateName: template.name, action: 'failed', metaResponse: errorData });
    } else {
      log.error(`[Template Submit] Network error for ${template.name}:`, err.message);
      throw err; // Let Bull retry
    }
  }
}

// ─── STATUS POLLING ────────────────────────────────────────────────────────
async function pollWorkspaceTemplateStatuses(clientId) {
  const { pollPendingMetaTemplatesForClient } = require('../services/templateLifecycleBridge');
  const result = await pollPendingMetaTemplatesForClient(clientId);
  if (result.approved > 0) {
    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $inc: { approvedCount: result.approved } }
    );
  }
  if (result.rejected > 0) {
    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $inc: { rejectedCount: result.rejected } }
    );
  }
}


async function handleGenerationJob(data) {
  const {
    clientId, templateType, fixedTemplateId, productId, productHandle, productName,
    productDescription, productPrice, productPageUrl, productImageUrl
  } = data;
  try {
    const client = await Client.findOne({ clientId }).lean();
    const brandName = client.platformVars?.brandName || client.businessName || clientId;
    const currency = client.platformVars?.baseCurrency || '₹';
    const language = normalizeMetaLanguage(client.platformVars?.defaultLanguage || 'en');
    const tone = client.platformVars?.defaultTone || 'friendly and professional';

    let generatedBody, templateName, category, headerType, headerValue, footerText, buttons, variableMapping;
    let variableMappings = null;
    let isPrebuilt = false;
    let autoTrigger = null;
    let templateKey = fixedTemplateId || "";

    if (templateType === 'fixed') {
      const result = await generateFixedTemplate(fixedTemplateId, { brandName, currency, language, tone });
      generatedBody = result.body;
      templateName = result.metaName || fixedTemplateId;
      category = result.category;
      headerType = result.headerType;
      headerValue = result.headerValue;
      footerText = 'Reply STOP to Unsubscribe';
      buttons = result.buttons;
      variableMapping = result.variableMapping;
      variableMappings = result.variableMappings || null;
      isPrebuilt = !!result.isPrebuilt;
      autoTrigger = result.autoTrigger || null;
      templateKey = result.templateKey || fixedTemplateId;
    } else {
      const result = await generateProductTagline({
        brandName, currency, language, tone, productName,
        productDescription: (productDescription || '').slice(0, 200), productPrice, productPageUrl
      });
      const priceStr = `${currency}${Number(productPrice || 0).toLocaleString('en-IN')}`;
      const tag = result.tagline || `Trusted quality from ${brandName}.`;
      const safeName = cleanShortText(productName || 'Premium Product', 64);
      const safeTag = cleanShortText(tag, 110);
      generatedBody = `✨ *${safeName}*\n\nPrice: *${priceStr}*\n\n${safeTag}\n\nTap below to view details and place your order instantly.`;
      templateName = buildProductTemplateName(productHandle);
      category = 'MARKETING';
      if (productImageUrl && /^https?:\/\//i.test(String(productImageUrl))) {
        headerType = 'IMAGE';
        headerValue = String(productImageUrl).slice(0, 2048);
      } else {
        headerType = 'TEXT';
        headerValue = (productName || 'Product').slice(0, 60);
      }
      footerText = 'Reply STOP to unsubscribe';
      const safeUrl = productPageUrl && /^https?:\/\//i.test(String(productPageUrl)) ? String(productPageUrl).slice(0, 2000) : '';
      buttons = safeUrl
        ? [{ type: 'URL', text: 'Order Now', url: safeUrl }, { type: 'QUICK_REPLY', text: 'Talk to Agent' }]
        : [{ type: 'QUICK_REPLY', text: 'Talk to Agent' }];
      variableMapping = new Map();
    }

    templateName = await getUniqueTemplateName(clientId, templateName);

    const libEntry = templateType === 'fixed' ? getPrebuiltByKey(fixedTemplateId) : null;
    const hydrated =
      libEntry && templateType === 'fixed'
        ? buildFormDataFromLibraryEntry(libEntry, client)
        : null;
    const formData = hydrated?.formData || {
      variableType: 'Number',
      mediaSample: headerType === 'IMAGE' ? 'Image' : headerType === 'TEXT' ? 'None' : 'None',
      headerImageUrl: headerType === 'IMAGE' ? headerValue : null,
      headerText: headerType === 'TEXT' ? headerValue : null,
      bodyText: generatedBody,
      footerText,
      headerSamples: [],
      bodySamples: [],
      buttons: [],
    };
    if (!hydrated && variableMapping && typeof variableMapping === 'object') {
      const indices = [...String(generatedBody).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1]);
      formData.bodySamples = indices.map((_, i) => Object.values(variableMapping)[i] || 'Sample');
    }

    const { getSlotByMetaName } = require('../constants/templateCatalog/catalog');
    const catalogSlot = getSlotByMetaName(templateName);
    const template = await MetaTemplate.findOneAndUpdate(
      { clientId, source: 'auto_generated', autoGenProductId: productId || fixedTemplateId },
      {
        $set: {
          clientId, name: templateName, category, language,
          headerType, headerValue, body: generatedBody,
          footerText, buttons, variableMapping,
          formData,
          source: 'auto_generated', autoGenProductId: productId || fixedTemplateId,
          templateKey: templateKey || fixedTemplateId || templateName,
          catalogSlotId: catalogSlot?.id || null,
          templateKind: templateType === 'product' ? 'product' : 'prebuilt',
          variableMappings,
          isPrebuilt,
          autoTrigger,
          readinessRequired: true,
          productHandle: productHandle || '',
          productName: productName || '',
          productPrice: String(productPrice || ''),
          productPageUrl: productPageUrl || '',
          productImageUrl: productImageUrl || '',
          submissionStatus: 'draft', updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true, new: true }
    );

    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $inc: { generatedCount: 1 }, $set: { updatedAt: new Date() } }
    );

    const genJob = await TemplateGenerationJob.findOne({ clientId }).lean();
    emitToClient(clientId, 'templateGenerated', {
      templateId: template._id.toString(), templateName, generatedCount: genJob.generatedCount
    });

    if (genJob.generatedCount >= genJob.totalTemplates) {
      await TemplateGenerationJob.findOneAndUpdate(
        { clientId },
        { $set: { status: 'drafts_ready', updatedAt: new Date() } }
      );
      emitToClient(clientId, 'templateGenerationComplete', {
        clientId,
        draftsReady: true,
        message: 'Drafts are ready. Review them, then submit to Meta when you are ready.',
      });
    }
  } catch (err) {
    log.error(`[Template Generation] Failed for ${clientId}, type: ${templateType}:`, err.message);
    await MetaTemplate.findOneAndUpdate(
      { clientId, source: 'auto_generated', autoGenProductId: productId || fixedTemplateId },
      { $set: { submissionStatus: 'generation_failed', updatedAt: new Date() } }
    );
    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $inc: { generatedCount: 1, failedGenerationCount: 1 }, $set: { updatedAt: new Date() } }
    );
    const genJobAfterFail = await TemplateGenerationJob.findOne({ clientId }).lean();
    emitToClient(clientId, 'templateGenerationProgress', {
      clientId,
      generatedCount: genJobAfterFail?.generatedCount,
      totalTemplates: genJobAfterFail?.totalTemplates,
      error: err.message
    });
    if (genJobAfterFail && genJobAfterFail.generatedCount >= genJobAfterFail.totalTemplates) {
      await TemplateGenerationJob.findOneAndUpdate(
        { clientId },
        { $set: { status: 'drafts_ready', updatedAt: new Date() } }
      );
      emitToClient(clientId, 'templateGenerationComplete', { clientId, draftsReady: true });
    }
    return;
  }
}

async function handleSchedulerJob(data) {
  const { clientId } = data;
  const genJob = await TemplateGenerationJob.findOne({ clientId }).lean();
  if (!genJob) return;

  if (!genJob.userSubmissionActive) {
    log.warn(`[Scheduler] Blocked orphan run for ${clientId} — no user submit flag`);
    await cancelClientSubmissions(clientId);
    return;
  }

  if (genJob.pausedByUser) {
    log.info(`[Scheduler] Paused by user for ${clientId}. Rechecking in 30 min.`);
    await rescheduleSubmissionCheck(clientId, 30);
    return;
  }

  // THE CORE RULE — NEVER STACK ON PENDING
  const pendingCount = await MetaTemplate.countDocuments({ clientId, submissionStatus: 'pending_meta_review' });
  if (pendingCount > 0) {
    log.info(`[Scheduler] ${pendingCount} templates pending for ${clientId}. Waiting 30 min.`);
    const nextCheck = new Date(Date.now() + 30 * 60 * 1000);
    await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $set: { nextBatchCheckAt: nextCheck, updatedAt: new Date() } });
    emitToClient(clientId, 'submissionSchedulerStatus', { clientId, state: 'waiting_for_pending_clearance', pendingCount, nextCheckAt: nextCheck.toISOString() });
    await rescheduleSubmissionCheck(clientId, 30);
    return;
  }

  const nextBatchItems = await SubmissionQueueItem.find({ clientId, status: 'queued' }).sort({ queuePosition: 1 }).limit(5).lean();
  if (nextBatchItems.length === 0) {
    await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() } });
    emitToClient(clientId, 'submissionSchedulerStatus', { clientId, state: 'completed' });
    log.info(`[Scheduler] All templates submitted for ${clientId}`);
    return;
  }

  const templateIds = nextBatchItems.map(item => item.templateId.toString());
  
  if (batchSubmitterQueue) {
    await batchSubmitterQueue.add('submit', { clientId, templateIds, batchNumber: nextBatchItems[0].batchNumber }, { attempts: 3, backoff: { type: 'exponential', delay: 30000 } });
  } else {
    setTimeout(() => handleBatchJob({ clientId, templateIds, batchNumber: nextBatchItems[0].batchNumber }), 0);
  }
  
  log.info(`[Scheduler] Dispatched batch ${nextBatchItems[0].batchNumber} for ${clientId}. Templates: ${templateIds.length}`);
}

async function handleBatchJob(data) {
  const { clientId, templateIds } = data;
  const client = await Client.findOne({ clientId }).lean();
  if (!client) {
    for (const templateId of templateIds) {
      await MetaTemplate.findByIdAndUpdate(templateId, {
        $set: {
          submissionStatus: 'submission_failed',
          rejectionReason: 'Client not found while processing submission batch',
          updatedAt: new Date()
        }
      });
    }
    return;
  }

  for (const templateId of templateIds) {
    await submitSingleTemplate(client, templateId, clientId);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  await TemplateGenerationJob.findOneAndUpdate({ clientId }, {
    $inc: { submittedCount: templateIds.length },
    $set: { lastBatchSubmittedAt: new Date(), updatedAt: new Date() }
  });

  emitToClient(clientId, 'submissionSchedulerStatus', { clientId, state: 'batch_submitted', submittedCount: templateIds.length });
  await rescheduleSubmissionCheck(clientId, 30);
}

async function handlePollerJob() {
  const clientsWithPending = await MetaTemplate.distinct('clientId', { submissionStatus: 'pending_meta_review' });
  log.info(`[Status Poller] Checking ${clientsWithPending.length} workspaces`);
  for (const clientId of clientsWithPending) {
    await pollWorkspaceTemplateStatuses(clientId);
  }
}

// ─── WORKER INITIALIZATION ─────────────────────────────────────────────────
if (redisConnection) {
  const workerOpts = { connection: redisConnection };

  // WORKER 1: Template Generation
  const genWorker = new Worker('template-generation', async (job) => {
    return await handleGenerationJob(job.data);
  }, { ...workerOpts, concurrency: 3 });

  // WORKER 2: Submission Scheduler (The Conductor)
  const schedulerWorker = new Worker('template-submission-scheduler', async (job) => {
    return await handleSchedulerJob(job.data);
  }, { ...workerOpts, concurrency: 1 });

  // WORKER 3: Batch Submitter
  const batchWorker = new Worker('template-batch-submitter', async (job) => {
    return await handleBatchJob(job.data);
  }, { ...workerOpts, concurrency: 1 });

  // WORKER 4: Status Poller
  const pollerWorker = new Worker('template-status-poller', async (job) => {
    return await handlePollerJob();
  }, { ...workerOpts, concurrency: 5 });

  // Event listeners for all workers
  [
    { worker: genWorker, name: 'template-generation' },
    { worker: schedulerWorker, name: 'template-submission-scheduler' },
    { worker: batchWorker, name: 'template-batch-submitter' },
    { worker: pollerWorker, name: 'template-status-poller' }
  ].forEach(({ worker, name }) => {
    worker.on('completed', (job) => log.info(`[${name}] Job ${job.id} completed`));
    worker.on('failed', (job, err) => log.error(`[${name}] Job ${job?.id} failed:`, err.message));
    worker.on('stalled', (jobId) => log.warn(`[${name}] Job ${jobId} stalled`));
  });

  // Register repeatable poller and run startup recovery
  registerStatusPoller();

  (async function recoverAutoTemplateJobs() {
    try {
      const orphanSubmitting = await TemplateGenerationJob.find({
        status: "submitting",
        userSubmissionActive: { $ne: true },
      }).lean();
      for (const job of orphanSubmitting) {
        log.warn(`[Startup Recovery] Stopping orphan submission for ${job.clientId}`);
        await cancelClientSubmissions(job.clientId);
      }

      const activeSubmit = await TemplateGenerationJob.find({
        status: "submitting",
        userSubmissionActive: true,
        pausedByUser: { $ne: true },
      }).lean();
      for (const job of activeSubmit) {
        const queued = await SubmissionQueueItem.countDocuments({ clientId: job.clientId, status: "queued" });
        if (queued > 0) {
          log.info(`[Startup Recovery] Resuming user-initiated submission for ${job.clientId}`);
          await rescheduleSubmissionCheck(job.clientId, 2);
        } else {
          await TemplateGenerationJob.updateOne(
            { clientId: job.clientId },
            { $set: { status: "completed", userSubmissionActive: false, completedAt: new Date(), updatedAt: new Date() } }
          );
        }
      }
    } catch (err) {
      log.error("[Startup Recovery] Error:", err.message);
    }
  })();

  log.info('[AutoTemplate] ✅ All 4 workers initialized');
}

// Always stop orphan auto-submissions on process start (even without Redis workers).
(async function stopOrphanSubmissionsOnBoot() {
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    const orphanSubmitting = await TemplateGenerationJob.find({
      status: "submitting",
      userSubmissionActive: { $ne: true },
    }).lean();
    for (const job of orphanSubmitting) {
      await cancelClientSubmissions(job.clientId);
    }
  } catch (err) {
    log.error("[Boot] Orphan submission cleanup error:", err.message);
  }
})();

module.exports = {
  buildSubmissionQueue,
  cancelClientSubmissions,
  handleGenerationJob,
  handleSchedulerJob,
  handleBatchJob,
  handlePollerJob,
};
