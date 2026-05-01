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
    bodyText: 'Hi {{1}}, your order {{2}} has been confirmed! We are processing it now. Your total is {{3}}.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }]
  },
  shipping_update: {
    category: 'UTILITY',
    purpose: 'Notify the customer that their order has shipped. Include order number and tracking information.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Tracking URL' },
    bodyText: 'Hi {{1}}, good news! Your order {{2}} has shipped. Track your package here: {{3}}',
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
  review_request: {
    category: 'MARKETING',
    purpose: 'Ask for a review post-delivery.',
    variables: { '1': 'Customer Name', '2': 'Review Link' },
    bodyText: 'Hi {{1}}, we hope you are loving your recent purchase! Could you take a minute to leave a review? It helps us out a lot: {{2}}',
    buttons: [{ type: 'QUICK_REPLY', text: 'Leave Review' }]
  },
  cod_to_prepaid: {
    category: 'MARKETING',
    purpose: 'Offer a discount to convert Cash on Delivery to Prepaid.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Discount Amount', '4': 'Payment Link' },
    bodyText: 'Hi {{1}}, convert your COD order {{2}} to prepaid and get an instant {{3}} discount! Click here to pay securely: {{4}}',
    buttons: [{ type: 'QUICK_REPLY', text: 'Pay Now' }]
  },
  warranty_registration: {
    category: 'UTILITY',
    purpose: 'Send warranty activation link post-purchase.',
    variables: { '1': 'Customer Name', '2': 'Order Number', '3': 'Warranty Link' },
    bodyText: 'Hi {{1}}, protect your new purchase! Click here to register your warranty for order {{2}} within the next 48 hours: {{3}}',
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
    bodyText: 'Hi {{1}}, you left {{2}} in your cart! Your total is {{3}}. Click here to complete your order before it sells out: {{4}}',
    buttons: [{ type: 'QUICK_REPLY', text: 'Complete Order' }]
  },
  cart_recovery_2: {
    category: 'MARKETING',
    purpose: 'A second follow-up sent 24 hours after abandonment.',
    variables: { '1': 'Customer Name', '2': 'Product Name', '3': 'Checkout URL' },
    bodyText: 'Hi {{1}}, your {{2}} is still reserved! Complete your purchase today with a special discount: {{3}}',
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

// ─── GENERATION: Fixed Templates ────────────────────────────────────────
async function generateFixedTemplate(templateId, ctx) {
  const def = FIXED_TEMPLATES[templateId];
  if (!def) throw new Error(`Unknown fixed template: ${templateId}`);

  return {
    body: def.bodyText,
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
  const AUTO_SUBMIT_FIXED = ['order_confirmed', 'shipping_update', 'order_delivered', 'order_cancelled'];
  const fixed = [];
  const products = [];

  for (const d of drafts) {
    if (Object.keys(FIXED_TEMPLATES).includes(d.autoGenProductId)) {
      // ONLY push core utility templates into the auto-submission queue
      if (AUTO_SUBMIT_FIXED.includes(d.autoGenProductId)) {
        fixed.push(d);
      }
      // Sequence templates remain in 'draft' and are not queued
    } else {
      products.push(d);
    }
  }

  // Sort fixed templates in submission order
  fixed.sort((a, b) => AUTO_SUBMIT_FIXED.indexOf(a.autoGenProductId) - AUTO_SUBMIT_FIXED.indexOf(b.autoGenProductId));

  const ordered = [];
  // Batch 1: order_confirmed, shipping_update, order_delivered, order_cancelled
  const batch1 = fixed;
  batch1.forEach((t, i) => ordered.push({ ...t, batchNumber: 1, queuePosition: i + 1 }));

  // Batch 2: first 5 product templates
  const batch2Products = products.slice(0, 5);
  batch2Products.forEach((t, i) => ordered.push({ ...t, batchNumber: 2, queuePosition: ordered.length + i + 1 }));

  // Batch 3+: remaining product templates in groups of 5
  const remaining = products.slice(5);
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


async function handleGenerationJob(data) {
  const { clientId, templateType, fixedTemplateId, productId, productHandle, productName, productDescription, productPrice, productPageUrl } = data;
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
}

async function handleSchedulerJob(data) {
  const { clientId } = data;
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

module.exports = { buildSubmissionQueue, handleGenerationJob, handleSchedulerJob, handleBatchJob, handlePollerJob };
