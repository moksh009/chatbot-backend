"use strict";

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const MetaTemplate = require('../models/MetaTemplate');
const TemplateGenerationJob = require('../models/TemplateGenerationJob');
const SubmissionQueueItem = require('../models/SubmissionQueueItem');
const SubmissionLog = require('../models/SubmissionLog');
const { generationQueue, rescheduleSubmissionCheck } = require('../workers/autoTemplateQueues');
const { withShopifyRetry } = require('../utils/shopifyHelper');
const { decrypt } = require('../utils/encryption');
const { tenantClientId } = require('../utils/queryHelpers');
const { PREBUILT_REQUIRED_TEMPLATES } = require('../constants/templateLifecycle');
const { getTemplateReadiness, migrateLegacyClientTemplatesToMeta } = require('../services/templateLifecycleService');

function resolveClientId(req) {
  return tenantClientId(req);
}

function isStuckInProgressJob(job) {
  if (!job) return false;
  if (!['generating', 'submitting', 'generation_complete'].includes(job.status)) return false; // drafts_ready is intentional idle
  const updatedAt = new Date(job.updatedAt || job.startedAt || Date.now()).getTime();
  const ageMs = Date.now() - updatedAt;
  return ageMs > 5 * 60 * 1000; // 5 minutes without progress
}

// ─── GET /api/auto-templates/status ───────────────────────────────────────
router.get('/status', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const job = await TemplateGenerationJob.findOne({ clientId }).lean();
    if (!job) return res.json({ success: true, job: null, counts: null });

    const stuck = isStuckInProgressJob(job);
    if (stuck) {
      await TemplateGenerationJob.updateOne(
        { _id: job._id },
        { $set: { status: 'idle', pausedByUser: false, updatedAt: new Date() } }
      );
      return res.json({
        success: true,
        job: { ...job, status: 'idle' },
        counts: {},
        staleDetected: true,
        message: 'Detected stale generation/submission job and reset it to idle.'
      });
    }

    const counts = await MetaTemplate.aggregate([
      { $match: { clientId, source: 'auto_generated' } },
      { $group: { _id: '$submissionStatus', count: { $sum: 1 } } }
    ]);

    const statusMap = {};
    counts.forEach(c => { statusMap[c._id] = c.count; });

    res.json({ success: true, job, counts: statusMap });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/drafts ───────────────────────────────────────
router.get('/drafts', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const templates = await MetaTemplate.find({ clientId, source: 'auto_generated' })
      .sort({ queuePosition: 1, createdAt: 1 })
      .lean();

    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/start ───────────────────────────────────────
router.post('/start', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    // Idempotency: if already running, return current state
    const existingJob = await TemplateGenerationJob.findOne({ clientId });
    if (existingJob && ['generating', 'submitting', 'generation_complete', 'drafts_ready'].includes(existingJob.status)) {
      if (isStuckInProgressJob(existingJob)) {
        await TemplateGenerationJob.updateOne(
          { _id: existingJob._id },
          { $set: { status: 'idle', pausedByUser: false, updatedAt: new Date() } }
        );
      } else {
      return res.json({ success: true, message: 'Generation already in progress', job: existingJob });
      }
    }

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Check Meta connection
    const wabaId = client.wabaId || client.whatsapp?.wabaId;
    const token = client.whatsappToken || client.whatsapp?.accessToken;
    if (!wabaId || !token) {
      return res.status(400).json({ success: false, message: 'Meta WhatsApp Business Account not connected' });
    }

    // Fetch products from Shopify (if connected)
    let products = [];
    if (client.shopDomain && client.shopifyAccessToken) {
      try {
        products = await withShopifyRetry(clientId, async (shop) => {
          // Fetching up to 250 products per Shopify API max limit
          const response = await shop.get('/products.json?limit=250&status=active');
          return (response.data.products || []).map(p => ({
            id: p.id.toString(),
            handle: p.handle,
            title: p.title,
            price: p.variants?.[0]?.price || '0',
            image: p.image?.src || null,
            description: p.body_html ? p.body_html.replace(/<[^>]*>/g, '').slice(0, 200) : '',
            url: `https://${client.shopDomain}/products/${p.handle}`
          }));
        });
      } catch (shopifyErr) {
        console.warn(`[AutoTemplates] Shopify fetch failed for ${clientId}:`, shopifyErr.message);
        // Continue without products — fixed templates will still generate
      }
    }

    // Required prebuilt only (product templates intentionally disabled).
    const totalTemplates = PREBUILT_REQUIRED_TEMPLATES.length;

    // Create or reset job tracker
    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      {
        $set: {
          status: 'generating',
          totalTemplates,
          generatedCount: 0,
          submittedCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          failedGenerationCount: 0,
          pausedByUser: false,
          startedAt: new Date(),
          completedAt: null,
          nextBatchCheckAt: null,
          lastBatchSubmittedAt: null,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true, new: true }
    );

    // Clear old drafts for this client (regeneration support)
    await MetaTemplate.deleteMany({ clientId, source: 'auto_generated', submissionStatus: { $in: ['draft', 'generation_failed'] } });
    await SubmissionQueueItem.deleteMany({ clientId, status: 'queued' });

    // Enqueue required prebuilt template generation jobs
    const fixedIds = PREBUILT_REQUIRED_TEMPLATES;
    for (const fixedId of fixedIds) {
      if (generationQueue) {
        await generationQueue.add('generate', {
          clientId,
          templateType: 'fixed',
          fixedTemplateId: fixedId,
          productId: fixedId
        }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
      } else {
        const { handleGenerationJob } = require('../workers/autoTemplateWorker');
        setTimeout(() => {
          handleGenerationJob({ clientId, templateType: 'fixed', fixedTemplateId: fixedId, productId: fixedId })
            .catch(e => console.error('[Inline Generation] Fixed error:', e));
        }, 0);
      }
    }

    res.json({
      success: true,
      message: `Generation started for ${totalTemplates} templates (${PREBUILT_REQUIRED_TEMPLATES.length} prebuilt)`,
      totalTemplates
    });
  } catch (err) {
    console.error('[AutoTemplates] Start error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/auto-templates/dismiss ────────────────────────────────────
router.patch('/dismiss', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $set: { dismissedAt: new Date(), autoDismissed: true, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/auto-templates/pause-toggle ───────────────────────────────
router.patch('/pause-toggle', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const job = await TemplateGenerationJob.findOne({ clientId });
    if (!job) return res.status(404).json({ success: false, message: 'No generation job found' });

    const newPausedState = !job.pausedByUser;
    job.pausedByUser = newPausedState;
    job.status = newPausedState ? 'paused' : 'submitting';
    job.updatedAt = new Date();
    await job.save();

    // If unpausing, trigger scheduler check immediately
    if (!newPausedState) {
      await rescheduleSubmissionCheck(clientId, 0.1);
    }

    res.json({ success: true, paused: newPausedState });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/drafts/:id ───────────────────────────────────────
router.get('/drafts/:id', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const template = await MetaTemplate.findOne({ _id: req.params.id, clientId, source: 'auto_generated' }).lean();
    if (!template) return res.status(404).json({ success: false, message: 'Draft not found' });

    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/auto-templates/drafts/:id ───────────────────────────────────────
router.put('/drafts/:id', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const { name, category, language, components } = req.body;
    const safeComponents = Array.isArray(components) ? components : [];
    
    // Validate it's still in a modifiable state
    const existing = await MetaTemplate.findOne({ _id: req.params.id, clientId, source: 'auto_generated' });
    if (!existing) return res.status(404).json({ success: false, message: 'Draft not found' });
    
    if (!['draft', 'queued', 'generation_failed', 'approved', 'rejected', 'pending_meta_review'].includes(existing.submissionStatus)) {
      return res.status(400).json({ success: false, message: `Cannot edit template in status: ${existing.submissionStatus}` });
    }

    // Parse components back into schema fields
    const headerComp = safeComponents.find(c => c.type === 'HEADER');
    const bodyComp = safeComponents.find(c => c.type === 'BODY');
    const footerComp = safeComponents.find(c => c.type === 'FOOTER');
    const buttonsComp = safeComponents.find(c => c.type === 'BUTTONS');

    const updateFields = {
      name,
      category,
      language,
      headerType: headerComp?.format || 'TEXT',
      headerValue: headerComp?.text || headerComp?.example?.header_handle?.[0] || '',
      body: bodyComp?.text || '',
      footerText: footerComp?.text || null,
      buttons: buttonsComp?.buttons || [],
      updatedAt: new Date()
    };

    // If it was failed, approved, rejected or pending, reset to draft so it can be re-submitted
    if (['generation_failed', 'approved', 'rejected', 'pending_meta_review'].includes(existing.submissionStatus)) {
      updateFields.submissionStatus = 'draft';
    }

    const template = await MetaTemplate.findOneAndUpdate(
      { _id: req.params.id, clientId },
      { $set: updateFields },
      { new: true }
    );

    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/regenerate ──────────────────────────────────
router.post('/regenerate', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    // Delete unsubmitted drafts and queue items
    await MetaTemplate.deleteMany({ clientId, source: 'auto_generated', submissionStatus: { $in: ['draft', 'generation_failed', 'queued'] } });
    await SubmissionQueueItem.deleteMany({ clientId, status: 'queued' });

    // Reset the job tracker to idle so /start can re-trigger
    await TemplateGenerationJob.findOneAndUpdate(
      { clientId },
      { $set: { status: 'idle', updatedAt: new Date() } }
    );

    res.json({ success: true, message: 'Old drafts cleared. Call /start to regenerate.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/submit-to-meta ─────────────────────────────
// Explicit user action: queue drafts for Meta approval (never auto-fired after generation).
router.post('/submit-to-meta', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const draftCount = await MetaTemplate.countDocuments({
      clientId,
      source: 'auto_generated',
      submissionStatus: { $in: ['draft', 'generation_failed'] },
    });
    if (draftCount === 0) {
      return res.status(400).json({ success: false, message: 'No drafts ready to submit. Generate templates first.' });
    }

    const pendingCount = await MetaTemplate.countDocuments({ clientId, submissionStatus: 'pending_meta_review' });
    if (pendingCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Wait until ${pendingCount} pending template(s) are reviewed by Meta before submitting more.`,
        pendingCount,
      });
    }

    const { buildSubmissionQueue } = require('../workers/autoTemplateWorker');
    await buildSubmissionQueue(clientId);

    res.json({
      success: true,
      message: `Submitting ${draftCount} template(s) to Meta for approval. Review can take 24–48 hours.`,
      draftCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/library ─────────────────────────────────────
router.get('/library', protect, async (req, res) => {
  try {
    const { PREBUILT_TEMPLATE_LIBRARY } = require('../constants/prebuiltTemplateLibrary');
    const clientId = resolveClientId(req);
    const drafts = clientId
      ? await MetaTemplate.find({ clientId, isPrebuilt: true }).select('name templateKey submissionStatus autoTrigger isActive totalSends').lean()
      : [];
    res.json({ success: true, library: PREBUILT_TEMPLATE_LIBRARY, clientPrebuilts: drafts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/library/preview ────────────────────────────
router.post('/library/preview', protect, async (req, res) => {
  try {
    const { PREBUILT_TEMPLATE_LIBRARY } = require('../constants/prebuiltTemplateLibrary');
    const { resolveTemplateVariables } = require('../services/templateVariableResolver');
    const { key } = req.body || {};
    const clientId = resolveClientId(req);
    if (!key) return res.status(400).json({ success: false, message: 'Missing template key' });

    const entry = PREBUILT_TEMPLATE_LIBRARY.find((t) => t.key === key || t.metaName === key);
    if (!entry) return res.status(404).json({ success: false, message: 'Template not in library' });

    const client = clientId
      ? await Client.findOne({ clientId }).select('businessName brandName nicheData').lean()
      : null;
    const brand = client?.businessName || client?.brandName || 'Your Store';

    const sampleContext = {
      first_name: 'Priya',
      order_id: '#TE-1042',
      order_items: 'Wireless Earbuds Pro',
      order_total: '₹2,499',
      shipping_address: '12 MG Road, Bangalore 560001',
      brand_name: brand,
      cart_total: '₹1,999',
      checkout_url: 'https://checkout.example.com/cart/abc123',
      tracking_url: 'https://track.example.com/TE-1042',
      estimated_delivery: '3–5 business days',
      loyalty_points: '450',
      loyalty_cash_value: '₹45',
      loyalty_expiry_date: '30 Jun 2026',
      google_review_url: 'https://g.page/r/example/review',
      warranty_duration: '12 months',
      order_date: '16 May 2026',
      first_product_image: client?.nicheData?.businessLogo || 'https://via.placeholder.com/400x200?text=Product',
    };

    const resolvedBody = await resolveTemplateVariables(entry.bodyText, sampleContext);
    let clientStatus = null;
    if (clientId) {
      const doc = await MetaTemplate.findOne({
        clientId,
        $or: [{ templateKey: entry.key }, { name: entry.metaName }],
      })
        .select('submissionStatus name totalSends')
        .lean();
      clientStatus = doc
        ? { name: doc.name, status: doc.submissionStatus, totalSends: doc.totalSends || 0 }
        : null;
    }

    res.json({
      success: true,
      entry,
      preview: {
        body: resolvedBody,
        headerText: entry.headerText || null,
        headerType: entry.headerType,
        buttons: entry.buttons || [],
        sampleContext,
      },
      clientStatus,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/trigger-next-batch ──────────────────────────
router.post('/trigger-next-batch', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    // HARD CHECK: Never Stack on Pending — server-side enforcement
    const pendingCount = await MetaTemplate.countDocuments({ clientId, submissionStatus: 'pending_meta_review' });
    if (pendingCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot submit while ${pendingCount} template(s) are pending Meta review`,
        pendingCount
      });
    }

    await rescheduleSubmissionCheck(clientId, 0.1); // Trigger immediately
    res.json({ success: true, message: 'Next batch triggered' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/retry/:templateId ───────────────────────────
router.post('/retry/:templateId', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const { templateId } = req.params;
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const template = await MetaTemplate.findById(templateId);
    if (!template || template.clientId !== clientId) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    if (!['submission_failed', 'rejected', 'generation_failed'].includes(template.submissionStatus)) {
      return res.status(400).json({ success: false, message: 'Template cannot be retried in its current state' });
    }

    if (template.submissionStatus === 'generation_failed') {
      // Re-generate via queue
      template.submissionStatus = 'draft';
      await template.save();
      if (generationQueue) {
        await generationQueue.add('generate', {
          clientId,
          templateType: template.autoGenProductId && !PREBUILT_REQUIRED_TEMPLATES.includes(template.autoGenProductId) ? 'product' : 'fixed',
          fixedTemplateId: template.autoGenProductId,
          productId: template.autoGenProductId
        }, { attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
      } else {
        const { handleGenerationJob } = require('../workers/autoTemplateWorker');
        setTimeout(() => {
          handleGenerationJob({
            clientId,
            templateType: template.autoGenProductId && !PREBUILT_REQUIRED_TEMPLATES.includes(template.autoGenProductId) ? 'product' : 'fixed',
            fixedTemplateId: template.autoGenProductId,
            productId: template.autoGenProductId
          }).catch(e => console.error('[Inline Generation] Retry error:', e));
        }, 0);
      }
    } else {
      // Re-submit: reset to queued
      template.submissionStatus = 'queued';
      template.rejectionReason = null;
      template.metaRetryCount = (template.metaRetryCount || 0) + 1;
      await template.save();

      // Create a new queue item at the front
      await SubmissionQueueItem.create({
        clientId,
        templateId: template._id,
        queuePosition: 0,
        batchNumber: 0,
        status: 'queued'
      });

      await rescheduleSubmissionCheck(clientId, 0.5);
    }

    res.json({ success: true, message: 'Retry initiated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/submission-log ───────────────────────────────
router.get('/submission-log', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const total = await SubmissionLog.countDocuments({ clientId });
    const logs = await SubmissionLog.find({ clientId })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ success: true, logs, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/commerce-check ───────────────────────────────
router.get('/commerce-check', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });

    const client = await Client.findOne({ clientId }).select('shopDomain shopifyAccessToken shopifyConnectionStatus').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const isConnected = !!(client.shopDomain && client.shopifyAccessToken);
    res.json({
      success: true,
      shopifyConnected: isConnected,
      shopifyStatus: client.shopifyConnectionStatus || 'unknown'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/auto-templates/migrate-legacy ──────────────────────────────
router.post('/migrate-legacy', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });
    const result = await migrateLegacyClientTemplatesToMeta(clientId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/auto-templates/readiness ────────────────────────────────────
router.get('/readiness', protect, async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'Missing clientId' });
    const readiness = await getTemplateReadiness(clientId);
    return res.json({ success: true, ...readiness });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
