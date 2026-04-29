"use strict";

/**
 * Auto Template Worker — BullMQ workers for template generation, submission, and polling.
 * Requires autoTemplateQueues.js for queue instances.
 */
const { Worker } = require('bullmq');
const axios = require('axios');
const log = require('../utils/logger')('AutoTemplateWorker');
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
const { platformGenerateText } = require('../utils/gemini');
const { decrypt } = require('../utils/encryption');

// ─── FIXED TEMPLATE DEFINITIONS ───────────────────────────────────────────────
const FIXED_TEMPLATES = {
  order_confirmed: {
    category: 'UTILITY',
    purpose: 'Confirm a new order has been received and is being processed. Include order number and total amount.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Order Total' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }]
  },
  shipping_update: {
    category: 'UTILITY',
    purpose: 'Notify the customer that their order has shipped. Include order number and tracking information.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Tracking URL' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Package' }]
  },
  order_delivered: {
    category: 'UTILITY',
    purpose: 'Confirm successful delivery and ask for feedback or review.',
    variables: { '1': 'Customer Name', '2': 'Order Number' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Leave a Review' }, { type: 'QUICK_REPLY', text: 'Need Help' }]
  },
  cart_recovery_1: {
    category: 'MARKETING',
    purpose: 'A polite first nudge sent 30 minutes after cart abandonment. Remind the customer of what they left behind without being pushy.',
    variables: { '1': 'Customer Name', '2': 'Product Name', '3': 'Cart Total', '4': 'Checkout URL' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Complete Order' }]
  },
  cart_recovery_2: {
    category: 'MARKETING',
    purpose: 'A second follow-up sent 24 hours after abandonment. Create gentle desirability, mention the product is still reserved, offer to help with questions.',
    variables: { '1': 'Customer Name', '2': 'Product Name', '3': 'Checkout URL' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Shop Now' }, { type: 'QUICK_REPLY', text: 'Help Me' }]
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
  let name = baseName;
  let suffix = 1;
  while (await MetaTemplate.findOne({ clientId, name })) {
    suffix++;
    name = `${baseName.slice(0, 47)}_${suffix}`;
  }
  return name;
}

// ─── HELPER: Emit to frontend via Socket.io ────────────────────────────────
function emitToClient(clientId, event, data) {
  try {
    const { getIO } = require('../utils/socket');
    getIO().to(`client_${clientId}`).emit(event, data);
  } catch (e) { /* socket may not be initialized in worker context */ }
}

// ─── AI GENERATION: Fixed Templates ────────────────────────────────────────
async function generateFixedTemplate(templateId, ctx) {
  const def = FIXED_TEMPLATES[templateId];
  if (!def) throw new Error(`Unknown fixed template: ${templateId}`);

  const varList = Object.entries(def.variables)
    .map(([k, v]) => `{{${k}}} = ${v}`)
    .join(', ');

  const prompt = `You are writing WhatsApp Business message template copy for ${ctx.brandName}. Brand tone: ${ctx.tone}. Language: ${ctx.language}.

Write ONLY the message body text for a ${templateId.replace(/_/g, ' ')} template. Requirements: under 1024 characters, no markdown formatting, no HTML, use {{1}} {{2}} {{3}} notation for dynamic variables, write naturally as a brand representative would communicate.

Template purpose: ${def.purpose}

Variable placeholders to include: ${varList}

Return ONLY the body text. No explanation. No template name. No subject line.`;

  const body = await platformGenerateText(prompt, { maxTokens: 512, temperature: 0.7 });
  if (!body) throw new Error(`AI generation returned null for ${templateId}`);

  return {
    body: body.trim(),
    category: def.category,
    headerType: 'TEXT',
    headerValue: ctx.brandName,
    buttons: def.buttons,
    variableMapping: def.variables
  };
}

// ─── AI GENERATION: Product Templates ──────────────────────────────────────
async function generateProductTemplate(ctx) {
  const prompt = `You are writing a WhatsApp marketing message for a specific product sold by ${ctx.brandName}. Brand tone: ${ctx.tone}.

Product: ${ctx.productName}
Price: ${ctx.currency}${ctx.productPrice}
Description: ${ctx.productDescription}

Write a 2-3 sentence product marketing message. Rules: under 300 characters (WhatsApp marketing is short and punchy), no generic phrases like "amazing product" or "don't miss out", write as a knowledgeable friend recommending this, mention the product name and price naturally, create desirability not urgency, compatible with WhatsApp text formatting only.

Return ONLY the message body. Nothing else.`;

  const body = await platformGenerateText(prompt, { maxTokens: 256, temperature: 0.7 });
  if (!body) throw new Error(`AI generation returned null for product ${ctx.productName}`);

  return { body: body.trim() };
}

// ─── BUILD SUBMISSION QUEUE ────────────────────────────────────────────────
async function buildSubmissionQueue(clientId) {
  const drafts = await MetaTemplate.find({
    clientId, source: 'auto_generated', submissionStatus: 'draft'
  }).lean();

  // Separate fixed and product templates
  const fixedOrder = ['order_confirmed', 'shipping_update', 'order_delivered', 'cart_recovery_1', 'cart_recovery_2'];
  const fixed = [];
  const products = [];

  for (const d of drafts) {
    if (fixedOrder.includes(d.autoGenProductId)) {
      fixed.push(d);
    } else {
      products.push(d);
    }
  }

  // Sort fixed templates in submission order
  fixed.sort((a, b) => fixedOrder.indexOf(a.autoGenProductId) - fixedOrder.indexOf(b.autoGenProductId));

  const ordered = [];
  // Batch 1 (positions 1-3): order_confirmed, shipping_update, order_delivered
  const batch1 = fixed.filter(f => ['order_confirmed', 'shipping_update', 'order_delivered'].includes(f.autoGenProductId));
  batch1.forEach((t, i) => ordered.push({ ...t, batchNumber: 1, queuePosition: i + 1 }));

  // Batch 2 (positions 4-8): cart_1, cart_2, first 3 product templates
  const batch2Fixed = fixed.filter(f => ['cart_recovery_1', 'cart_recovery_2'].includes(f.autoGenProductId));
  const batch2Products = products.slice(0, 3);
  const batch2 = [...batch2Fixed, ...batch2Products];
  batch2.forEach((t, i) => ordered.push({ ...t, batchNumber: 2, queuePosition: ordered.length + i + 1 }));

  // Batch 3+: remaining product templates in groups of 5
  const remaining = products.slice(3);
  let batchNum = 3;
  for (let i = 0; i < remaining.length; i += 5) {
    const chunk = remaining.slice(i, i + 5);
    chunk.forEach((t, j) => ordered.push({ ...t, batchNumber: batchNum, queuePosition: ordered.length + j + 1 }));
    batchNum++;
  }

  // Create SubmissionQueueItem documents
  const bulkOps = ordered.map(t => ({
    clientId,
    templateId: t._id,
    queuePosition: t.queuePosition,
    batchNumber: t.batchNumber,
    status: 'queued'
  }));

  if (bulkOps.length > 0) {
    await SubmissionQueueItem.insertMany(bulkOps);
  }

  // Update queue positions on templates
  for (const t of ordered) {
    await MetaTemplate.findByIdAndUpdate(t._id, {
      $set: { submissionStatus: 'queued', queuePosition: t.queuePosition, updatedAt: new Date() }
    });
  }

  // Transition job to submitting and trigger first batch
  await TemplateGenerationJob.findOneAndUpdate(
    { clientId },
    { $set: { status: 'submitting', updatedAt: new Date() } }
  );

  await rescheduleSubmissionCheck(clientId, 0.1); // Check in ~6 seconds
  log.info(`[AutoTemplate] Submission queue built for ${clientId}: ${ordered.length} templates in ${batchNum - 1} batches`);
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

  if (template.headerType === 'TEXT' && template.headerValue) {
    components.push({ type: 'HEADER', format: 'TEXT', text: template.headerValue });
  }

  const bodyComponent = { type: 'BODY', text: template.body };
  if (template.variableMapping && template.variableMapping instanceof Map && template.variableMapping.size > 0) {
    bodyComponent.example = {
      body_text: [Array.from(template.variableMapping.values()).map(v => `[${v}]`)]
    };
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

  const payload = {
    name: template.name,
    category: template.category,
    language: template.language || 'en',
    components
  };

  const token = decrypt(client.whatsappToken) || client.whatsappToken;
  const wabaId = client.wabaId || client.whatsapp?.wabaId;

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
  const client = await Client.findOne({ clientId }).select('whatsappToken wabaId whatsapp').lean();
  const wabaId = client?.wabaId || client?.whatsapp?.wabaId;
  const rawToken = client?.whatsappToken || client?.whatsapp?.accessToken;
  if (!wabaId || !rawToken) return;

  const token = decrypt(rawToken) || rawToken;
  const pendingTemplates = await MetaTemplate.find({
    clientId, submissionStatus: 'pending_meta_review', metaTemplateId: { $ne: null }
  }).lean();

  for (const template of pendingTemplates) {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/v19.0/${template.metaTemplateId}?fields=name,status,rejected_reason`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );

      const metaStatus = response.data.status;
      let newStatus = template.submissionStatus;
      let updateFields = { lastPolledAt: new Date() };

      if (metaStatus === 'APPROVED') {
        newStatus = 'approved';
        updateFields.approvedAt = new Date();
        await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $inc: { approvedCount: 1 } });
      } else if (metaStatus === 'REJECTED') {
        newStatus = 'rejected';
        updateFields.rejectedAt = new Date();
        updateFields.rejectionReason = response.data.rejected_reason || 'No reason provided by Meta';
        await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $inc: { rejectedCount: 1 } });
      }

      if (newStatus !== template.submissionStatus) {
        await MetaTemplate.findByIdAndUpdate(template._id, { $set: { submissionStatus: newStatus, ...updateFields } });
        await SubmissionLog.create({ clientId, templateId: template._id, templateName: template.name, action: newStatus, metaResponse: response.data });
        emitToClient(clientId, 'templateStatusUpdated', {
          templateId: template._id.toString(), templateName: template.name,
          newStatus, rejectionReason: updateFields.rejectionReason || null
        });
      }
    } catch (err) {
      log.error(`[Status Poller] Failed to poll ${template.name} for ${clientId}:`, err.message);
    }
  }
}

// ─── WORKER INITIALIZATION ─────────────────────────────────────────────────
if (redisConnection) {
  const workerOpts = { connection: redisConnection };

  // WORKER 1: Template Generation
  const genWorker = new Worker('template-generation', async (job) => {
    const { clientId, templateType, fixedTemplateId, productId, productHandle, productName, productDescription, productPrice, productPageUrl } = job.data;
    try {
      const client = await Client.findOne({ clientId }).lean();
      const brandName = client.platformVars?.brandName || client.businessName || clientId;
      const currency = client.platformVars?.baseCurrency || '₹';
      const language = client.platformVars?.defaultLanguage || 'en';
      const tone = client.platformVars?.defaultTone || 'friendly and professional';

      let generatedBody, templateName, category, headerType, headerValue, footerText, buttons, variableMapping;

      if (templateType === 'fixed') {
        const result = await generateFixedTemplate(fixedTemplateId, { brandName, currency, language, tone });
        generatedBody = result.body;
        templateName = fixedTemplateId;
        category = result.category;
        headerType = result.headerType;
        headerValue = result.headerValue;
        footerText = 'Reply STOP to Unsubscribe';
        buttons = result.buttons;
        variableMapping = result.variableMapping;
      } else {
        const result = await generateProductTemplate({ brandName, currency, language, tone, productName, productDescription: (productDescription || '').slice(0, 200), productPrice, productPageUrl });
        generatedBody = result.body;
        templateName = buildProductTemplateName(productHandle);
        category = 'MARKETING';
        headerType = 'TEXT';
        headerValue = productName;
        footerText = null;
        buttons = [{ type: 'QUICK_REPLY', text: 'Buy Now' }];
        variableMapping = {};
      }

      templateName = await getUniqueTemplateName(clientId, templateName);

      const template = await MetaTemplate.findOneAndUpdate(
        { clientId, source: 'auto_generated', autoGenProductId: productId || fixedTemplateId },
        {
          $set: {
            clientId, name: templateName, category, language,
            headerType, headerValue, body: generatedBody,
            footerText, buttons, variableMapping,
            source: 'auto_generated', autoGenProductId: productId || fixedTemplateId,
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
        await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $set: { status: 'generation_complete', updatedAt: new Date() } });
        await buildSubmissionQueue(clientId);
        emitToClient(clientId, 'templateGenerationComplete', { clientId });
      }
    } catch (err) {
      log.error(`[Template Generation] Failed for ${clientId}, type: ${templateType}:`, err.message);
      await MetaTemplate.findOneAndUpdate(
        { clientId, source: 'auto_generated', autoGenProductId: productId || fixedTemplateId },
        { $set: { submissionStatus: 'generation_failed' } }
      );
      await TemplateGenerationJob.findOneAndUpdate({ clientId }, { $inc: { failedGenerationCount: 1 } });
      throw err;
    }
  }, { ...workerOpts, concurrency: 3 });

  // WORKER 2: Submission Scheduler (The Conductor)
  const schedulerWorker = new Worker('template-submission-scheduler', async (job) => {
    const { clientId } = job.data;
    const genJob = await TemplateGenerationJob.findOne({ clientId }).lean();
    if (!genJob) return;

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
    await batchSubmitterQueue.add('submit', { clientId, templateIds, batchNumber: nextBatchItems[0].batchNumber }, { attempts: 3, backoff: { type: 'exponential', delay: 30000 } });
    log.info(`[Scheduler] Dispatched batch ${nextBatchItems[0].batchNumber} for ${clientId}. Templates: ${templateIds.length}`);
  }, { ...workerOpts, concurrency: 1 });

  // WORKER 3: Batch Submitter
  const batchWorker = new Worker('template-batch-submitter', async (job) => {
    const { clientId, templateIds } = job.data;
    const client = await Client.findOne({ clientId }).lean();

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
  }, { ...workerOpts, concurrency: 1 });

  // WORKER 4: Status Poller
  const pollerWorker = new Worker('template-status-poller', async (job) => {
    const clientsWithPending = await MetaTemplate.distinct('clientId', { submissionStatus: 'pending_meta_review' });
    log.info(`[Status Poller] Checking ${clientsWithPending.length} workspaces`);
    for (const clientId of clientsWithPending) {
      await pollWorkspaceTemplateStatuses(clientId);
    }
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
      const inProgressJobs = await TemplateGenerationJob.find({ status: { $in: ['generating', 'submitting'] } }).lean();
      for (const job of inProgressJobs) {
        if (job.status === 'submitting') {
          log.info(`[Startup Recovery] Restarting submission scheduler for ${job.clientId}`);
          await rescheduleSubmissionCheck(job.clientId, 1);
        }
      }
    } catch (err) {
      log.error('[Startup Recovery] Error:', err.message);
    }
  })();

  log.info('[AutoTemplate] ✅ All 4 workers initialized');
}

module.exports = { buildSubmissionQueue };
