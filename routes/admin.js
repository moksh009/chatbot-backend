const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/logger')('AdminAPI');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');
const { generateFlowForClient } = require('../utils/flowAutogen');
const { convertLegacyToVisual } = require('../utils/legacyConverter');
const { runFullMigration } = require('../scripts/phase9MigrationLogic');
const { getGeminiModel } = require('../utils/gemini');
const { validateAndCleanFlow } = require('../utils/aiFlowBuilder');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const shopifyAdminApiVersion = require('../utils/shopifyAdminApiVersion');
const { encrypt, decrypt } = require('../utils/encryption');
const { sanitizeMiddleware } = require('../utils/sanitize');
const { ensureClientForUser } = require('../utils/ensureClientForUser');
const { syncPersonaToFlows } = require('../utils/personaEngine');
const { getPrebuiltTemplates } = require('../utils/flowGenerator');
const WhatsApp = require('../utils/whatsapp');
const AuditLog = require('../models/AuditLog');
const WhatsAppFlow = require('../models/WhatsAppFlow');

router.post('/shopify/force-sync', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const { refreshShopifyToken } = require('../utils/shopifyHelper');
    const result = await refreshShopifyToken(client);

    if (result.success) {
      res.json({ success: true, message: 'Shopify connection re-synchronized' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to re-synchronize Shopify connection', error: result.error });
    }
  } catch (err) {
    log.error('Error forcing Shopify sync', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

const CLIENT_CODE_DIR = path.join(__dirname, 'clientcodes');

// Middleware to check if user is a Super Admin
const isSuperAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (user && user.role === 'SUPER_ADMIN') {
      next();
    } else {
      res.status(403).json({ message: 'Access denied: Super Admin only' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};
// --- TEST WHATSAPP CONNECTION ---
router.post('/test-whatsapp-send', protect, async (req, res) => {
  try {
    const { phone, phoneNumberId, wabaId, token } = req.body;
    
    if (!phone || !phoneNumberId || !wabaId || !token) {
      return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    const testMessage = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone.replace(/[^0-9]/g, ''),
      type: "text",
      text: {
        body: "👋 Hello! This is a test message from your TopEdge AI connection. Your WhatsApp API is configured correctly!"
      }
    };

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      testMessage,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    log.error('Test WhatsApp Send Failed', { error: err.response?.data || err.message });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send test message', 
      error: err.response?.data?.error?.message || err.message 
    });
  }
});

// --- WARRANTY MIGRATION REPORT ---
router.get('/warranty/migration-report', protect, async (req, res) => {
  try {
    const WarrantyRecord = require('../models/WarrantyRecord');
    const AdLead = require('../models/AdLead');
    const targetClientId =
      (req.user.role === 'SUPER_ADMIN' && req.query.clientId)
        ? String(req.query.clientId).trim()
        : req.user.clientId;

    if (!targetClientId) {
      return res.status(400).json({ success: false, message: 'Missing clientId' });
    }

    const [leadAgg, canonicalCount] = await Promise.all([
      AdLead.aggregate([
        { $match: { clientId: targetClientId } },
        {
          $project: {
            legacyCount: {
              $cond: [
                { $isArray: '$warrantyRecords' },
                { $size: '$warrantyRecords' },
                0
              ]
            }
          }
        },
        {
          $group: {
            _id: null,
            leadsWithLegacy: { $sum: { $cond: [{ $gt: ['$legacyCount', 0] }, 1, 0] } },
            legacyRecordCount: { $sum: '$legacyCount' }
          }
        }
      ]),
      WarrantyRecord.countDocuments({ clientId: targetClientId })
    ]);

    const legacy = leadAgg[0] || { leadsWithLegacy: 0, legacyRecordCount: 0 };
    const pendingEstimate = Math.max(0, Number(legacy.legacyRecordCount || 0) - Number(canonicalCount || 0));

    return res.json({
      success: true,
      clientId: targetClientId,
      report: {
        leadsWithLegacy: Number(legacy.leadsWithLegacy || 0),
        legacyRecordCount: Number(legacy.legacyRecordCount || 0),
        canonicalWarrantyRecordCount: Number(canonicalCount || 0),
        pendingMigrationEstimate: pendingEstimate
      },
      lastRun: (await Client.findOne({ clientId: targetClientId }).select('warrantyMigrationStatus').lean())?.warrantyMigrationStatus || null
    });
  } catch (err) {
    log.error('Warranty migration report failed', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --- RUN WARRANTY LEGACY MIGRATION (CLIENT SCOPED) ---
router.post('/warranty/migrate-legacy', protect, async (req, res) => {
  try {
    const AdLead = require('../models/AdLead');
    const Contact = require('../models/Contact');
    const WarrantyBatch = require('../models/WarrantyBatch');
    const WarrantyRecord = require('../models/WarrantyRecord');

    const targetClientId =
      (req.user.role === 'SUPER_ADMIN' && req.body?.clientId)
        ? String(req.body.clientId).trim()
        : req.user.clientId;
    if (!targetClientId) {
      return res.status(400).json({ success: false, message: 'Missing clientId' });
    }

    const toDate = (v) => {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? new Date() : d;
    };
    const makeKey = (orderId, productName, purchaseDate) =>
      `${String(orderId || '')}::${String(productName || '').toLowerCase()}::${toDate(purchaseDate).toISOString().slice(0, 10)}`;

    let batch = await WarrantyBatch.findOne({ clientId: targetClientId, status: 'active' }).sort({ createdAt: -1 });
    if (!batch) {
      batch = await WarrantyBatch.create({
        clientId: targetClientId,
        batchName: 'Legacy Warranty Migration',
        shopifyProductIds: [],
        durationMonths: 12,
        validFrom: new Date(),
        status: 'active',
      });
    }

    const leads = await AdLead.find({
      clientId: targetClientId,
      warrantyRecords: { $exists: true, $ne: [] },
    }).lean();

    let migrated = 0;
    let skipped = 0;
    let errors = 0;

    for (const lead of leads) {
      try {
        let contact = await Contact.findOne({ clientId: targetClientId, phoneNumber: lead.phoneNumber });
        if (!contact) {
          contact = await Contact.create({
            clientId: targetClientId,
            phoneNumber: lead.phoneNumber,
            name: lead.name || 'Customer',
            email: lead.email || '',
          });
        }

        const existing = await WarrantyRecord.find({ clientId: targetClientId, customerId: contact._id }).lean();
        const existingKeys = new Set(
          existing.map((r) => makeKey(r.shopifyOrderId, r.productName, r.purchaseDate))
        );

        for (const legacy of lead.warrantyRecords || []) {
          const key = makeKey(legacy.orderId, legacy.productName, legacy.purchaseDate || legacy.registeredAt);
          if (existingKeys.has(key)) {
            skipped += 1;
            continue;
          }
          const purchaseDate = toDate(legacy.purchaseDate || legacy.registeredAt || Date.now());
          const expiryDate = toDate(legacy.expiryDate || purchaseDate);
          const status = ['active', 'expired', 'terminated', 'void'].includes(String(legacy.status || '').toLowerCase())
            ? String(legacy.status).toLowerCase()
            : 'active';

          await WarrantyRecord.create({
            clientId: targetClientId,
            customerId: contact._id,
            shopifyOrderId: String(legacy.orderId || `legacy-${lead._id}-${Date.now()}`),
            productId: String(legacy.serialNumber || legacy.productName || 'legacy-product'),
            productName: String(legacy.productName || 'Registered Product'),
            purchaseDate,
            expiryDate,
            batchId: batch._id,
            status,
          });
          existingKeys.add(key);
          migrated += 1;
        }
      } catch (err) {
        errors += 1;
      }
    }

    const runSummary = {
      ranAt: new Date(),
      leadsScanned: leads.length,
      migrated,
      skipped,
      errors
    };
    await Client.updateOne(
      { clientId: targetClientId },
      { $set: { warrantyMigrationStatus: runSummary } }
    );

    return res.json({
      success: true,
      clientId: targetClientId,
      result: runSummary
    });
  } catch (err) {
    log.error('Warranty legacy migration failed', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});


// --- GET ALL CLIENTS ---
router.get('/clients', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const filter = { isActive: { $ne: false } };
    if (req.query.search) {
      filter.$or = [
        { businessName: { $regex: req.query.search, $options: 'i' } },
        { clientId: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const clients = await Client.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('clientId businessName name wabaId phoneNumberId whatsappToken shopifyAccessToken shopDomain storeType instagramConnected adminAlertEmail adminAlertWhatsapp emailUser emailAppPassword emailMethod googleConnected gmailAddress isActive createdAt config.wabaId config.phoneNumberId config.whatsappToken config.shopifyAccessToken config.shopDomain config.storeType')
      .lean();
    
    const total = await Client.countDocuments(filter);

    res.json({
      success: true,
      data: clients,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    log.error('Error fetching clients', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// --- RUN AUTOMATION MIGRATION (Super Admin) ---
// Temporarily public for easy browser execution (Add basic secret key param for safety)
router.get('/run-migration', async (req, res) => {
  try {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    const defaultAutomationFlows = [
      { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
      { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
      { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
    ];

    const defaultMessageTemplates = [
      {
        id: "cod_to_prepaid",
        body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
        buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
      },
      {
        id: "review_request",
        body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
        buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
      }
    ];

    const clients = await Client.find({});
    let updated = 0;

    for (const client of clients) {
        let isModified = false;

        // Seed default flow nodes if not already set
        if (!client.flowNodes || client.flowNodes.length === 0) {
          const niche = client.niche || client.businessType || 'other';
          const defaultFlow = getDefaultFlowForNiche(niche);
          client.flowNodes = defaultFlow.nodes;
          client.flowEdges = defaultFlow.edges;
          isModified = true;
        }

        if (!client.automationFlows || client.automationFlows.length === 0) {
            client.automationFlows = defaultAutomationFlows;
            isModified = true;
        } else {
             for (const defaultFlow of defaultAutomationFlows) {
                 if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                     client.automationFlows.push(defaultFlow);
                     isModified = true;
                 }
             }
        }

        if (!client.messageTemplates || client.messageTemplates.length === 0) {
             client.messageTemplates = defaultMessageTemplates;
             isModified = true;
        } else {
             for (const defaultTemp of defaultMessageTemplates) {
                 if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                     client.messageTemplates.push(defaultTemp);
                     isModified = true;
                 }
             }
        }

        if (isModified) {
            const setFields = {};
            if (client.flowNodes) setFields.flowNodes = client.flowNodes;
            if (client.flowEdges) setFields.flowEdges = client.flowEdges;
            if (client.automationFlows) setFields.automationFlows = client.automationFlows;
            if (client.messageTemplates) setFields.messageTemplates = client.messageTemplates;

            await Client.updateOne(
              { _id: client._id },
              { $set: setFields },
              { runValidators: false }
            );
            updated++;
        }
    }

    res.json({ success: true, message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROLE PROMOTION (EMERGENCY DEBUG) ---
router.get('/promote-me', async (req, res) => {
  try {
    const { email, role, secret } = req.query;
    if (secret !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?secret=topedge_secure_admin_123' });
    }
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.role = role || 'SUPER_ADMIN';
    await user.save();
    res.json({ success: true, message: `User ${email} promoted to ${user.role}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy Delitech migration routes removed.

// --- RUN GENERIC FOLDERIZATION (URL RUNNABLE) ---
router.get('/folderize-clients', async (req, res) => {
  try {
    const { key, target } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    // Default to the major ones we know lack the strict new folder structure,
    // or allow targeting a specific one via ?target=client_id
    const clientsToFix = target ? [target] : [];
    const results = [];
    
    const flowTemplates = require('../data/flowTemplates');

    for (const clientId of clientsToFix) {
      const client = await Client.findOne({ clientId });
      if (!client) {
          results.push(`Skipping ${clientId}: Client not found.`);
          continue;
      }

      // Determine template to apply based on businessType or niche
      const typeKey = client.businessType === 'salon' || client.niche === 'salon' || clientId.includes('salon') 
          ? 'salon' 
          : 'ecommerce';
          
      const template = flowTemplates[typeKey];

      if (!template) {
        results.push(`Skipping ${clientId}: No template available for type ${typeKey}`);
        continue;
      }

      // Build out variables for substitution
      const brandName = client.name || clientId.replace('_', ' ');
      const nicheData = client.nicheData || {};
      const storeUrl = nicheData.storeUrl || '';
      const buyUrl = nicheData.buyUrl || storeUrl;
      const products = nicheData.products || [];
      const productList = products.length
        ? products.map((p, i) => `${i + 1}. ${p.name || p.title} — ₹${p.price}`).join('\n')
        : 'Products coming soon!';

      const substituteVars = (str = '') =>
        str
          .replace(/{{brand_name}}/g, brandName)
          .replace(/{{store_url}}/g, storeUrl)
          .replace(/{{buy_url}}/g, buyUrl)
          .replace(/{{product_list}}/g, productList);

      const personalizedNodes = template.nodes.map(n => ({
        ...n,
        data: {
          ...n.data,
          body: substituteVars(n.data?.body || ''),
          header: substituteVars(n.data?.header || ''),
          text: substituteVars(n.data?.text || '')
        }
      }));

      // Fully overwrite the flow with the best-practice folder structure
      await Client.updateOne(
        { clientId }, 
        { $set: { flowNodes: personalizedNodes, flowEdges: template.edges } }
      );
      
      results.push(`Successfully re-templated and folderized ${clientId} using ${typeKey} structure.`);
    }

    res.json({ success: true, message: "Template injection and folderization complete", results });
  } catch (err) {
    res.status(500).json({ error: 'Folderization failed: ' + err.message });
  }
});

// --- GET CLIENT BY ID ---
router.get('/clients/:id', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json(client);
  } catch (err) {
    console.error('Error fetching client details:', err);
    res.status(500).json({ message: 'Server error fetching client details' });
  }
});

// --- CREATE NEW CLIENT ---
router.post('/clients', protect, isSuperAdmin, async (req, res) => {
  try {
    const {
      clientId, businessName, businessType, tier, phoneNumberId, 
      whatsappToken, verifyToken: webhookVerifyToken, wabaId,
      adminEmail // Admin can specify client's primary email
    } = req.body;

    // 1. Mandatory Validation
    if (!clientId || !businessName || !phoneNumberId) {
      return res.status(400).json({ message: 'clientId, businessName, and phoneNumberId are required' });
    }

    const existingClient = await Client.findOne({ clientId });
    if (existingClient) {
      return res.status(400).json({ message: 'Client ID already exists' });
    }

    // 2. Auto-generate System Prompt if missing
    let systemPrompt = req.body.systemPrompt;
    if (!systemPrompt) {
      const { generateText } = require('../utils/gemini');
      systemPrompt = await generateText(`Generate a professional personality system prompt for a WhatsApp business named "${businessName}". Business type is ${businessType || 'general'}. Keep it concise, helpful, and friendly.`);
    }

    const resolvedWebhookVerify =
      (webhookVerifyToken && String(webhookVerifyToken).trim()) ||
      `te_wa_${crypto.randomBytes(18).toString('hex')}`;

    // 3. Prepare Dual-Write Payload (Tier 2.5 Parallel Run)
    // Map incoming flat fields to the new modular sub-documents
    const clientData = {
      ...req.body,
      clientId: clientId.trim(),
      businessName,
      name: businessName, // Legacy sync
      verifyToken: resolvedWebhookVerify,
      systemPrompt: systemPrompt || 'You are a helpful assistant.',
      isActive: true,
      flowNodes: [],
      flowEdges: [],
      
      // -- NEW TIER 2.5 SUB-DOCUMENTS --
      brand: {
        businessName: businessName,
        niche: req.body.niche || 'other',
        businessType: businessType || 'other',
        adminPhone: req.body.adminPhone || '',
        googleReviewUrl: req.body.googleReviewUrl || ''
      },
      whatsapp: {
        phoneNumberId: phoneNumberId,
        wabaId: req.body.wabaId || '',
        accessToken: req.body.whatsappToken || '',
        verifyToken: resolvedWebhookVerify,
      },
      commerce: {
        storeType: req.body.storeType || 'shopify',
        shopify: {
          domain: req.body.shopDomain || '',
          accessToken: req.body.shopifyAccessToken || '',
          clientId: req.body.shopifyClientId || '',
          clientSecret: req.body.shopifyClientSecret || '',
          webhookSecret: req.body.shopifyWebhookSecret || ''
        }
      },
      ai: {
        geminiKey: req.body.geminiApiKey || '',
        openaiKey: req.body.openaiApiKey || '',
        systemPrompt: systemPrompt || 'You are a helpful assistant.',
        fallbackEnabled: req.body.isAIFallbackEnabled !== false
      },
      billing: {
        tier: req.body.tier || 'v1',
        plan: req.body.plan || 'CX Agent (V1)',
        trialActive: true,
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      social: {
        instagram: {
          pageId: req.body.instagramPageId || '',
          accessToken: req.body.instagramAccessToken || '',
          appSecret: req.body.instagramAppSecret || '',
          username: req.body.instagramUsername || ''
        },
        metaAds: {
          accountId: req.body.metaAdAccountId || '',
          accessToken: req.body.metaAdsToken || ''
        }
      }
    };

    // Note: Manual encryption loop removed. TopEdge AI Client Schema pre-save hooks 
    // now automatically encrypt all sensitive credentials (legacy + new sub-docs).
    const newClient = new Client(clientData);

    const savedClient = await newClient.save();

    // ── AUTOMATED USER PROVISIONING ──
    const generatedPassword = crypto.randomBytes(4).toString('hex'); // 8 chars
    const loginEmail = adminEmail || `${clientId.trim().toLowerCase()}@chatbot.com`;

    const newUser = new User({
      name: businessName,
      email: loginEmail,
      password: generatedPassword,
      role: 'CLIENT_ADMIN',
      clientId: clientId.trim(),
      business_type: businessType || 'ecommerce'
    });
    
    await newUser.save();

    // ── PHASE 10: Inject pre-built flow template if available ──────────────
    const flowTemplates = require('../data/flowTemplates');
    const template      = flowTemplates[businessType] || flowTemplates[niche];

    if (template) {
      const brandName   = newClient.name || 'us';
      const storeUrl    = (nicheData && nicheData.storeUrl)  || '';
      const buyUrl      = (nicheData && nicheData.buyUrl)    || storeUrl;
      const products    = (nicheData && nicheData.products)  || [];
      const productList = products.length
        ? products.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n')
        : 'Products coming soon!';

      const substituteVars = (str = '') =>
        str
          .replace(/{{brand_name}}/g,   brandName)
          .replace(/{{store_url}}/g,    storeUrl)
          .replace(/{{buy_url}}/g,      buyUrl)
          .replace(/{{product_list}}/g, productList);

      const personalizedNodes = template.nodes.map(n => ({
        ...n,
        data: {
          ...n.data,
          body:   substituteVars(n.data?.body   || ''),
          header: substituteVars(n.data?.header || '')
        }
      }));

      await Client.findByIdAndUpdate(savedClient._id, {
        $set: { flowNodes: personalizedNodes, flowEdges: template.edges }
      });
      log.success(`Pre-built flow template injected for: ${clientId} (type: ${businessType || niche})`);
    }

    // ── DEFAULT WELCOME FLOW: Auto-create if no niche template matched ──────
    // Ensures "Hi" always gets a response in WhatsAppFlow collection
    try {
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      const { createDefaultFlow } = require('../data/defaultFlow');
      const defaultFlow = createDefaultFlow(savedClient);
      
      await WhatsAppFlow.create({
        clientId: clientId.trim(),
        name: 'Customer Service Bot',
        status: 'PUBLISHED',
        nodes: defaultFlow.nodes,
        edges: defaultFlow.edges,
        publishedAt: new Date()
      });
      
      // Also sync to legacy fields if no template was applied
      if (!template) {
        await Client.findByIdAndUpdate(savedClient._id, {
          $set: { flowNodes: defaultFlow.nodes, flowEdges: defaultFlow.edges }
        });
      }
      
      log.success(`Default welcome flow auto-created for: ${clientId}`);
    } catch (flowErr) {
      log.warn(`Default flow creation failed for ${clientId}:`, flowErr.message);
    }

    log.success(`New client provisioned: ${clientId} | Plan: ${tier || 'Growth'}`);
    res.status(201).json({ 
      ...savedClient.toObject(), 
      flowReady: !!template,
      credentials: {
        email: loginEmail,
        password: generatedPassword
      }
    });

  } catch (err) {
    log.error('Error creating client', { error: err.message });
    res.status(500).json({ message: 'Server error creating client', error: err.message });
  }
});

// --- RESET CLIENT PASSWORD ---
router.put('/clients/:clientId/reset-password', protect, isSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const crypto = require('crypto');
    const newPassword = crypto.randomBytes(4).toString('hex');

    const user = await User.findOne({ clientId, role: 'CLIENT_ADMIN' });
    if (!user) return res.status(404).json({ message: 'Client Admin user not found' });

    user.password = newPassword;
    await user.save();

    log.success(`Password reset for client: ${clientId}`);
    res.json({
      success: true,
      message: 'Password reset successful',
      credentials: {
        email: user.email,
        password: newPassword
      }
    });
  } catch (err) {
    log.error('Password reset failed', { error: err.message });
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

// Legacy Delitech repair routes removed.

// --- UPDATE CLIENT ---
router.put('/clients/:id', protect, isSuperAdmin, async (req, res) => {
  try {
    log.info(`Updating client: ${req.params.id}`);
    const {
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken,
      verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData,
      automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword,
      razorpayKeyId, razorpaySecret, adminPhone,
      cashfreeAppId, cashfreeSecretKey, activePaymentGateway,
      stripePublishableKey, stripeSecretKey, payuMerchantKey, payuMerchantSalt,
      phonepeMerchantId, phonepeSaltKey, phonepeSaltIndex,
      shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl,
      trialActive, trialEndsAt,
      wizardCompleted, onboardingCompleted, onboardingStep
    } = req.body;

    // Recursively strip any _id fields that are not strings (prevents CastErrors/Buffer crashes)
    const deepCleanIds = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(deepCleanIds);
      
      const newObj = { ...obj };
      if (newObj._id && typeof newObj._id !== 'string') {
        delete newObj._id;
      }
      // Also handle MongoDB Extended JSON $oid format
      if (newObj.$oid) return undefined; 

      for (const key in newObj) {
        if (typeof newObj[key] === 'object') {
          newObj[key] = deepCleanIds(newObj[key]);
        }
      }
      return newObj;
    };

    let cleanAutomationFlows = automationFlows ? deepCleanIds(automationFlows) : undefined;
    let cleanMessageTemplates = messageTemplates ? deepCleanIds(messageTemplates) : undefined;
    let cleanNicheData = nicheData ? deepCleanIds(nicheData) : undefined;
    let cleanFlowData = flowData ? deepCleanIds(flowData) : undefined;

    // --- Dual-Write Construction for Parallel Run ---
    const updateData = {
      name, businessType, niche, plan, isGenericBot, phoneNumberId,
      whatsappToken, verifyToken: webhookVerifyToken, 
      googleCalendarId, openaiApiKey, 
      nicheData: cleanNicheData, 
      flowData: cleanFlowData,
      automationFlows: cleanAutomationFlows, 
      messageTemplates: cleanMessageTemplates, 
      wabaId, emailUser, 
      emailAppPassword, razorpayKeyId, razorpaySecret, adminPhone,
      cashfreeAppId, cashfreeSecretKey, activePaymentGateway,
      stripePublishableKey, stripeSecretKey, payuMerchantKey, payuMerchantSalt,
      phonepeMerchantId, phonepeSaltKey, phonepeSaltIndex, shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl
    };

    // Tier 2.5 Sub-document dual-writes
    if (name) updateData['brand.businessName'] = name;
    if (niche) updateData['brand.niche'] = niche;
    if (businessType) updateData['brand.businessType'] = businessType;
    if (adminPhone !== undefined) updateData['brand.adminPhone'] = adminPhone;
    if (googleReviewUrl !== undefined) updateData['brand.googleReviewUrl'] = googleReviewUrl;
    
    if (phoneNumberId !== undefined) updateData['whatsapp.phoneNumberId'] = phoneNumberId;
    if (wabaId !== undefined) updateData['whatsapp.wabaId'] = wabaId;
    if (whatsappToken !== undefined) updateData['whatsapp.accessToken'] = whatsappToken;
    if (webhookVerifyToken !== undefined) updateData['whatsapp.verifyToken'] = webhookVerifyToken;
    
    if (shopDomain !== undefined) updateData['commerce.shopify.domain'] = shopDomain;
    if (shopifyAccessToken !== undefined) updateData['commerce.shopify.accessToken'] = shopifyAccessToken;
    if (shopifyWebhookSecret !== undefined) updateData['commerce.shopify.webhookSecret'] = shopifyWebhookSecret;
    
    if (openaiApiKey !== undefined) updateData['ai.openaiKey'] = openaiApiKey;
    if (plan !== undefined) {
      updateData['billing.plan'] = plan;
      // Master tier sync for UI PlanGate and Sidebar locks
      if (plan === 'CX Agent (V2)' || plan === 'enterprise') {
        updateData.tier = 'v2';
      } else if (plan === 'CX Agent (V1)' || plan === 'v1' || plan === 'starter') {
        updateData.tier = 'v1';
      }
    }

    if (trialActive !== undefined) {
      updateData.trialActive = trialActive;
      updateData['billing.trialActive'] = trialActive;
    }
    if (trialEndsAt !== undefined) {
      updateData.trialEndsAt = new Date(trialEndsAt);
      updateData['billing.trialEndsAt'] = new Date(trialEndsAt);
    }

    if (wizardCompleted !== undefined) {
      updateData.wizardCompleted = !!wizardCompleted;
      if (wizardCompleted) updateData.wizardCompletedAt = new Date();
      else updateData.wizardCompletedAt = null;
    }
    if (onboardingCompleted !== undefined) {
      updateData.onboardingCompleted = !!onboardingCompleted;
    }
    if (onboardingStep !== undefined && onboardingStep !== null) {
      updateData.onboardingStep = Number(onboardingStep);
    }

    let query = {};
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      query = { _id: req.params.id };
    } else {
      query = { clientId: req.params.id };
    }

    const updatedClient = await Client.findOneAndUpdate(
      query,
      { $set: updateData },
      { new: true, runValidators: false }
    );

    if (!updatedClient) {
      log.warn(`Update client not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Client not found' });
    }

    log.success(`Client updated: ${updatedClient.clientId}`);
    res.json(updatedClient);
  } catch (err) {
    log.error('Error updating client', { error: err.message });
    res.status(500).json({ message: 'Server error updating client', error: err.message });
  }
});

// --- DELETE CLIENT (Soft Delete) ---
router.delete('/clients/:id', protect, isSuperAdmin, async (req, res) => {
  try {
    const deletedClient = await Client.findByIdAndUpdate(
      req.params.id, 
      { $set: { isActive: false } },
      { new: true }
    );
    if (!deletedClient) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json({ message: 'Client deactivated successfully (Soft Deleted)' });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- CLIENT SELF-SERVICE: Update own nicheData/flowData ---
// Any authenticated user can update their OWN client's editable fields
router.get('/my-settings', protect, sanitizeMiddleware, async (req, res) => {
  try {
    await ensureClientForUser(req.user);

    const { clientId } = req.query;
    
    // 1. Resolve Target Client ID with Fallback
    // Priority: Query Param (SuperAdmin only) > User Object > "unknown"
    let targetClientId = (req.user?.role === 'SUPER_ADMIN' && clientId) ? clientId : req.user?.clientId;

    if (!targetClientId) {
      log.warn('Settings access attempted without clientId', { user: req.user?.email });
      return res.status(400).json({ 
        success: false, 
        message: 'Identity mismatch: No target clientId established.' 
      });
    }

    log.info('Fetching settings stream', { targetClientId, requester: req.user?.email });

    // 2. Fetch with simple retry logic (via await)
    const client = await Client.findOne({ clientId: targetClientId })
      .select('-flowNodes -flowEdges -visualFlows -messageTemplates -automationFlows -nicheData')
      .maxTimeMS(5000); // 5s timeout
    
    if (!client) {
      log.warn('Client registry missing', { targetClientId });
      return res.status(404).json({ 
        success: false, 
        message: `No configuration payload found for id: ${targetClientId}` 
      });
    }

    // 3. Return payload (sanitized via middleware)
    res.json(client);

  } catch (err) {
    log.error('Critical Settings Failure (500)', { 
      error: err.message, 
      stack: err.stack,
      user: req.user?.email 
    });

    // Handle generic server errors vs database timeouts
    const isTimeout = err.name === 'MongooseError' && err.message.includes('timeout');
    
    res.status(500).json({ 
      success: false,
      message: isTimeout ? 'Database connection timed out. Please retry.' : 'Persistent internal server error',
      error: err.message 
    });
  }
});

router.patch('/my-settings', protect, async (req, res) => {
  try {
    const { 
      nicheData, flowData, automationFlows, messageTemplates, flowNodes, flowEdges, 
      skuAutomations,
      simpleSettings, clientId, isAIFallbackEnabled, flowFolders, visualFlows,
      /** Lightweight auto-save merge: PATCH { flowDraft: { flowId, nodes, edges, syncLiveGraph? } } */
      flowDraft,
      wabaId, phoneNumberId, whatsappToken, verifyToken,
      shopDomain, shopifyClientId, shopifyClientSecret, shopifyAccessToken, shopifyWebhookSecret, shopifyConnectionStatus,
      facebookCatalogId, shopifyStorefrontToken,
      storeType,
      instagramConnected, instagramPageId, instagramAccessToken, instagramAppSecret,
      googleReviewUrl, adminPhone, adminEmail,
      adminAlertEmail, adminAlertWhatsapp, adminAlertPreferences, metaAppId,
      // Phase SMTP: Email credentials
      emailUser, emailAppPassword,
      // Phase 20: Razorpay
      razorpayKeyId, razorpaySecret,
      cashfreeAppId, cashfreeSecretKey, activePaymentGateway,
      stripePublishableKey, stripeSecretKey,
      payuMerchantKey, payuMerchantSalt,
      phonepeMerchantId, phonepeSaltKey, phonepeSaltIndex,
      // Phase 20: System prompt / AI
      systemPrompt, geminiApiKey,
      // Phase 29: AI Persona
      ai,
      loyaltyConfig,
      businessName,
      businessLogo,
      authorizedSignature,
      warrantyEmailEnabled,
      warrantyWhatsappEnabled,
      warrantyDuration,
      warrantyPolicy,
      warrantySupportPhone,
      warrantySupportEmail,
      warrantyClaimUrl
    } = req.body;
    
    // If Super Admin and clientId provided, use that. Otherwise use user's own.
    let targetClientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && clientId) {
      targetClientId = clientId;
    }

    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }

    // ── SaaS: server-side WhatsApp validation (do not trust UI-only checks) ─────────
    let _waVerifySnapshot = null;
    const waPatchRequested =
      wabaId !== undefined ||
      phoneNumberId !== undefined ||
      (whatsappToken !== undefined &&
        whatsappToken !== '••••••••' &&
        String(whatsappToken).trim() !== '');

    if (waPatchRequested) {
      const existing = await Client.findOne({ clientId: targetClientId })
        .select('phoneNumberId wabaId whatsappToken clientId name platformVars')
        .lean();

      if (!existing) {
        return res.status(404).json({ success: false, message: 'Client not found' });
      }

      const effPid =
        phoneNumberId !== undefined
          ? String(phoneNumberId).trim()
          : String(existing.phoneNumberId || '').trim();

      let effTok = '';
      if (
        whatsappToken !== undefined &&
        whatsappToken !== '••••••••' &&
        String(whatsappToken).trim() !== ''
      ) {
        effTok = String(whatsappToken).trim();
      } else {
        try {
          effTok = decrypt(existing.whatsappToken || '') || '';
        } catch (_) {
          effTok = '';
        }
      }

      const effWaba =
        wabaId !== undefined ? String(wabaId).trim() : String(existing.wabaId || '').trim();

      if (!effPid || !effTok) {
        return res.status(400).json({
          success: false,
          message:
            'WhatsApp: Phone Number ID and permanent access token are both required. Paste a fresh system user token if you rotated it.',
        });
      }

      if (!effWaba) {
        return res.status(400).json({
          success: false,
          message: 'WhatsApp Business Account ID (WABA ID) is required so we can verify ownership.',
        });
      }

      const { validateWhatsAppCloudCredentials } = require('../utils/whatsappMetaValidate');
      const v = await validateWhatsAppCloudCredentials({
        phoneNumberId: effPid,
        whatsappToken: effTok,
        wabaId: effWaba,
      });

      if (!v.ok) {
        return res.status(400).json({
          success: false,
          message: v.message,
          code: v.code,
        });
      }

      const dup = await Client.findOne({
        phoneNumberId: effPid,
        clientId: { $ne: targetClientId },
      })
        .select('clientId name')
        .lean();

      if (dup) {
        return res.status(409).json({
          success: false,
          message: `This WhatsApp number is already linked to another workspace (${dup.name || dup.clientId}). Each Cloud API number can only map to one tenant here.`,
        });
      }
      _waVerifySnapshot = v;
    }

    const updateFields = {};
    if (nicheData !== undefined) updateFields.nicheData = nicheData;
    if (flowData !== undefined) updateFields.flowData = flowData;
    if (automationFlows !== undefined) updateFields.automationFlows = automationFlows;
    if (skuAutomations !== undefined) updateFields.skuAutomations = skuAutomations;
    if (messageTemplates !== undefined) updateFields.messageTemplates = messageTemplates;
    if (flowNodes !== undefined) updateFields.flowNodes = flowNodes;
    if (flowEdges !== undefined) updateFields.flowEdges = flowEdges;
    if (simpleSettings !== undefined) updateFields.simpleSettings = simpleSettings;
    if (isAIFallbackEnabled !== undefined) updateFields.isAIFallbackEnabled = isAIFallbackEnabled;
    if (flowFolders !== undefined) updateFields.flowFolders = flowFolders;
    if (visualFlows !== undefined) updateFields.visualFlows = visualFlows;

    // Partial flow graph merge (autosave) — avoids sending full visualFlows payloads
    if (flowDraft && flowDraft.flowId) {
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      const { flowId, nodes = [], edges = [], syncLiveGraph } = flowDraft;
      const wfExisting = await WhatsAppFlow.findOne({ clientId: targetClientId, flowId }).lean();
      const flowName = wfExisting?.name || 'Automation';

      await WhatsAppFlow.findOneAndUpdate(
        { clientId: targetClientId, flowId },
        {
          $set: {
            clientId: targetClientId,
            flowId,
            name: flowName,
            platform: wfExisting?.platform || 'whatsapp',
            folderId: wfExisting?.folderId || '',
            nodes,
            edges,
          },
          $setOnInsert: {
            status: 'DRAFT',
            version: 1,
            publishedNodes: [],
            publishedEdges: [],
          },
        },
        { upsert: true, new: true }
      );

      const prevClient = await Client.findOne({ clientId: targetClientId }).lean();
      const vf = [...(prevClient.visualFlows || [])];
      const ix = vf.findIndex((f) => String(f.id) === String(flowId));
      const patchFlow = {
        ...(ix >= 0 ? vf[ix] : {}),
        id: flowId,
        name: ix >= 0 ? vf[ix].name : flowName,
        platform: ix >= 0 ? vf[ix].platform : wfExisting?.platform || 'whatsapp',
        folderId: ix >= 0 ? vf[ix].folderId : wfExisting?.folderId || '',
        isActive: ix >= 0 ? !!vf[ix].isActive : false,
        nodes,
        edges,
        updatedAt: new Date(),
      };
      if (ix >= 0) vf[ix] = patchFlow;
      else vf.push(patchFlow);
      updateFields.visualFlows = vf;

      if (syncLiveGraph) {
        updateFields.flowNodes = nodes;
        updateFields.flowEdges = edges;
      }
    }

    // Commercial & Meta Fields
    if (wabaId !== undefined) {
      updateFields.wabaId = wabaId;
      updateFields['whatsapp.wabaId'] = wabaId;
    }
    if (phoneNumberId !== undefined) {
      updateFields.phoneNumberId = phoneNumberId;
      updateFields['whatsapp.phoneNumberId'] = phoneNumberId;
    }
    if (verifyToken !== undefined) {
      const v = String(verifyToken || '').trim();
      if (v.length > 0) {
        if (v.length < 6) {
          return res.status(400).json({
            success: false,
            message: 'Webhook verify token must be at least 6 characters.',
          });
        }
        if (v.length > 256) {
          return res.status(400).json({
            success: false,
            message: 'Webhook verify token is too long (max 256).',
          });
        }
        updateFields.verifyToken = v;
        updateFields['whatsapp.verifyToken'] = v;
      }
    }
    if (whatsappToken !== undefined && whatsappToken !== '••••••••' && whatsappToken.trim() !== '') {
      updateFields.whatsappToken = whatsappToken;
      updateFields['whatsapp.accessToken'] = whatsappToken;
    }

    if (waPatchRequested && _waVerifySnapshot && _waVerifySnapshot.ok) {
      updateFields['platformVars.whatsappLastVerifiedAt'] = new Date();
      updateFields['platformVars.whatsappVerifiedDisplayNumber'] =
        _waVerifySnapshot.display_phone_number || '';
    }

    if (shopDomain !== undefined) {
      updateFields.shopDomain = shopDomain;
      updateFields['commerce.shopify.domain'] = shopDomain;
    }
    if (shopifyClientId !== undefined) {
      updateFields.shopifyClientId = shopifyClientId;
      updateFields['commerce.shopify.clientId'] = shopifyClientId;
    }
    if (shopifyClientSecret !== undefined) {
      const emptyCs =
        shopifyClientSecret === null ||
        (typeof shopifyClientSecret === 'string' && shopifyClientSecret.trim() === '');
      if (emptyCs) {
        updateFields.shopifyClientSecret = '';
        updateFields['commerce.shopify.clientSecret'] = '';
      } else if (shopifyClientSecret !== '••••••••' && String(shopifyClientSecret).trim() !== '') {
        updateFields.shopifyClientSecret = shopifyClientSecret;
        updateFields['commerce.shopify.clientSecret'] = shopifyClientSecret;
      }
    }
    if (shopifyAccessToken !== undefined) {
      const emptyTok =
        shopifyAccessToken === null ||
        (typeof shopifyAccessToken === 'string' && shopifyAccessToken.trim() === '');
      if (emptyTok) {
        updateFields.shopifyAccessToken = '';
        updateFields['commerce.shopify.accessToken'] = '';
        updateFields.shopifyRefreshToken = '';
        updateFields['commerce.shopify.refreshToken'] = '';
      } else if (shopifyAccessToken !== '••••••••' && String(shopifyAccessToken).trim() !== '') {
        updateFields.shopifyAccessToken = shopifyAccessToken;
        updateFields['commerce.shopify.accessToken'] = shopifyAccessToken;
      }
    }
    if (shopifyWebhookSecret !== undefined) {
      const emptyWh =
        shopifyWebhookSecret === null ||
        (typeof shopifyWebhookSecret === 'string' && shopifyWebhookSecret.trim() === '');
      if (emptyWh) {
        updateFields.shopifyWebhookSecret = '';
        updateFields['commerce.shopify.webhookSecret'] = '';
      } else if (shopifyWebhookSecret !== '••••••••' && String(shopifyWebhookSecret).trim() !== '') {
        updateFields.shopifyWebhookSecret = shopifyWebhookSecret;
        updateFields['commerce.shopify.webhookSecret'] = shopifyWebhookSecret;
      }
    }
    if (shopifyConnectionStatus !== undefined) {
      updateFields.shopifyConnectionStatus = shopifyConnectionStatus;
    }

    if (facebookCatalogId !== undefined) {
      updateFields.facebookCatalogId = String(facebookCatalogId || '').trim();
    }
    const { metaCatalogAccessToken } = req.body;
    if (
      metaCatalogAccessToken !== undefined &&
      metaCatalogAccessToken !== '••••••••' &&
      String(metaCatalogAccessToken).trim() !== ''
    ) {
      updateFields.metaCatalogAccessToken = String(metaCatalogAccessToken).trim();
    }
    if (shopifyStorefrontToken !== undefined && shopifyStorefrontToken !== '••••••••' && String(shopifyStorefrontToken).trim() !== '') {
      updateFields.shopifyStorefrontToken = String(shopifyStorefrontToken).trim();
    }

    if (storeType !== undefined) {
      updateFields.storeType = storeType;
      updateFields['commerce.storeType'] = storeType;
    }

    if (instagramConnected !== undefined) {
      updateFields.instagramConnected = instagramConnected;
      updateFields['social.instagram.connected'] = instagramConnected;
    }
    if (instagramPageId !== undefined) {
      updateFields.instagramPageId = instagramPageId;
      updateFields['social.instagram.pageId'] = instagramPageId;
    }
    if (instagramAccessToken !== undefined && instagramAccessToken !== '••••••••' && instagramAccessToken.trim() !== '') {
      updateFields.instagramAccessToken = instagramAccessToken;
      updateFields['social.instagram.accessToken'] = instagramAccessToken;
    }
    if (instagramAppSecret !== undefined && instagramAppSecret !== '••••••••' && instagramAppSecret.trim() !== '') {
      updateFields.instagramAppSecret = instagramAppSecret;
      updateFields['social.instagram.appSecret'] = instagramAppSecret;
    }

    if (googleReviewUrl !== undefined) {
      updateFields.googleReviewUrl = googleReviewUrl;
      updateFields['brand.googleReviewUrl'] = googleReviewUrl;
    }
    if (adminPhone !== undefined) {
      updateFields.adminPhone = adminPhone;
      updateFields['brand.adminPhone'] = adminPhone;
    }
    if (adminEmail !== undefined) updateFields.adminEmail = adminEmail;
    if (adminAlertEmail !== undefined) updateFields.adminAlertEmail = adminAlertEmail;
    if (adminAlertWhatsapp !== undefined) updateFields.adminAlertWhatsapp = adminAlertWhatsapp;
    if (adminAlertPreferences === 'whatsapp' || adminAlertPreferences === 'email' || adminAlertPreferences === 'both') {
      updateFields.adminAlertPreferences = adminAlertPreferences;
    }
    if (metaAppId !== undefined) updateFields.metaAppId = metaAppId;
    if (businessName !== undefined) {
      updateFields.businessName = businessName;
      updateFields['brand.businessName'] = businessName;
    }
    if (businessLogo !== undefined) updateFields.businessLogo = businessLogo;
    if (authorizedSignature !== undefined) updateFields.authorizedSignature = authorizedSignature;
    if (warrantyEmailEnabled !== undefined) {
      updateFields['brand.warrantyEmailEnabled'] = !!warrantyEmailEnabled;
    }
    if (warrantyWhatsappEnabled !== undefined) {
      updateFields['brand.warrantyWhatsappEnabled'] = !!warrantyWhatsappEnabled;
    }
    if (warrantyDuration !== undefined) {
      const val = String(warrantyDuration || '');
      updateFields['platformVars.warrantyDuration'] = val;
      updateFields['brand.warrantyDefaultDuration'] = val;
      updateFields['wizardFeatures.warrantyDuration'] = val;
    }
    if (warrantyPolicy !== undefined) updateFields['policies.warrantyPolicy'] = String(warrantyPolicy || '');
    if (warrantySupportPhone !== undefined) {
      const val = String(warrantySupportPhone || '');
      updateFields['brand.warrantySupportPhone'] = val;
      updateFields['wizardFeatures.warrantySupportPhone'] = val;
    }
    if (warrantySupportEmail !== undefined) {
      const val = String(warrantySupportEmail || '');
      updateFields['wizardFeatures.warrantySupportEmail'] = val;
      updateFields['platformVars.supportEmail'] = val;
    }
    if (warrantyClaimUrl !== undefined) {
      const val = String(warrantyClaimUrl || '');
      updateFields['brand.warrantyClaimUrl'] = val;
      updateFields['wizardFeatures.warrantyClaimUrl'] = val;
    }
    if (loyaltyConfig !== undefined) {
      updateFields.loyaltyConfig = loyaltyConfig;
      if (loyaltyConfig?.isEnabled !== undefined || loyaltyConfig?.enabled !== undefined) {
        const isEnabled = loyaltyConfig?.isEnabled ?? loyaltyConfig?.enabled;
        updateFields['wizardFeatures.enableLoyalty'] = !!isEnabled;
      }
      const silverThreshold = Number(loyaltyConfig?.tierThresholds?.silver);
      const goldThreshold = Number(loyaltyConfig?.tierThresholds?.gold);
      if (Number.isFinite(silverThreshold)) {
        updateFields['wizardFeatures.loyaltySilverThreshold'] = silverThreshold;
      }
      if (Number.isFinite(goldThreshold)) {
        updateFields['wizardFeatures.loyaltyGoldThreshold'] = goldThreshold;
      }
    }

    if (emailUser !== undefined) updateFields.emailUser = emailUser;
    if (emailAppPassword !== undefined && emailAppPassword !== '••••••••' && emailAppPassword.trim() !== '') {
      updateFields.emailAppPassword = emailAppPassword;
    }

    if (activePaymentGateway !== undefined) updateFields.activePaymentGateway = activePaymentGateway;
    if (razorpayKeyId !== undefined && razorpayKeyId.trim() !== '') updateFields.razorpayKeyId = razorpayKeyId;
    if (razorpaySecret !== undefined && razorpaySecret !== '••••••••' && razorpaySecret.trim() !== '') updateFields.razorpaySecret = razorpaySecret;
    if (cashfreeAppId !== undefined && cashfreeAppId.trim() !== '') updateFields.cashfreeAppId = cashfreeAppId;
    if (cashfreeSecretKey !== undefined && cashfreeSecretKey !== '••••••••' && cashfreeSecretKey.trim() !== '') updateFields.cashfreeSecretKey = cashfreeSecretKey;
    if (stripePublishableKey !== undefined && stripePublishableKey.trim() !== '') updateFields.stripePublishableKey = stripePublishableKey;
    if (stripeSecretKey !== undefined && stripeSecretKey !== '••••••••' && stripeSecretKey.trim() !== '') updateFields.stripeSecretKey = stripeSecretKey;
    if (payuMerchantKey !== undefined && payuMerchantKey.trim() !== '') updateFields.payuMerchantKey = payuMerchantKey;
    if (payuMerchantSalt !== undefined && payuMerchantSalt !== '••••••••' && payuMerchantSalt.trim() !== '') updateFields.payuMerchantSalt = payuMerchantSalt;
    if (phonepeMerchantId !== undefined && phonepeMerchantId.trim() !== '') updateFields.phonepeMerchantId = phonepeMerchantId;
    if (phonepeSaltKey !== undefined && phonepeSaltKey !== '••••••••' && phonepeSaltKey.trim() !== '') updateFields.phonepeSaltKey = phonepeSaltKey;
    if (phonepeSaltIndex !== undefined && phonepeSaltIndex.trim() !== '') updateFields.phonepeSaltIndex = phonepeSaltIndex;

    // Phase 20: AI / System Prompt
    if (systemPrompt !== undefined) {
      updateFields.systemPrompt = systemPrompt;
      updateFields['ai.systemPrompt'] = systemPrompt;
    }
    if (geminiApiKey !== undefined && geminiApiKey !== '••••••••' && geminiApiKey.trim() !== '') {
      updateFields.geminiApiKey = geminiApiKey;
      updateFields['ai.geminiKey'] = geminiApiKey;
    }
    
    if (ai?.persona !== undefined) {
      updateFields['ai.persona'] = ai.persona;
    }

    const updated = await Client.findOneAndUpdate(
      { clientId: targetClientId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    // Auto Template: Emit metaConnected when wabaId is saved for the first time
    if (wabaId && wabaId.trim()) {
      try {
        const { getIO } = require('../utils/socket');
        const TemplateGenerationJob = require('../models/TemplateGenerationJob');
        const existingJob = await TemplateGenerationJob.findOne({ clientId: targetClientId }).lean();
        // Only emit if no generation job exists yet (first-time connection)
        if (!existingJob) {
          getIO().to(`client_${targetClientId}`).emit('metaConnected', { clientId: targetClientId });
        }
      } catch (socketErr) { /* non-fatal */ }
    }

    // PHASE: Migrate and Sync visualFlows to the new WhatsAppFlow schema
    if (visualFlows !== undefined && Array.isArray(visualFlows)) {
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      for (const f of visualFlows) {
        await WhatsAppFlow.findOneAndUpdate(
          { flowId: f.id, clientId: targetClientId },
          {
            $set: {
              name: f.name || 'Untitled Flow',
              platform: f.platform || 'whatsapp',
              folderId: f.folderId || null,
              status: f.isActive ? 'PUBLISHED' : 'DRAFT',
              nodes: f.nodes || [],
              edges: f.edges || []
            }
          },
          { upsert: true }
        );
      }
    }

    log.success(`${req.user.role} updated settings for: ${targetClientId}`);
    
    // PHASE 3: Trigger AI Node Sync asynchronously
    if (ai && ai.persona) {
      syncPersonaToFlows(targetClientId, ai.persona).catch(err => {
        console.error('[PersonaSync] Async Exception:', err);
      });
    }

    res.json({ 
      success: true, 
      nicheData: updated.nicheData, 
      flowData: updated.flowData,
      automationFlows: updated.automationFlows,
      messageTemplates: updated.messageTemplates,
      flowFolders: updated.flowFolders,
      visualFlows: updated.visualFlows
    });
  } catch (err) {
    log.error('Settings update error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});
// --- GET PRESET FLOW BY BUSINESS TYPE ---
const flowPresets = require('../utils/flowPresets');

router.get('/flow/preset/:type', protect, async (req, res) => {
  const { type } = req.params;
  const preset = flowPresets.getPreset(type);
  
  if (!preset) {
    return res.status(404).json({ success: false, message: "Preset not found" });
  }
  
  return res.json({ success: true, ...preset });
});

// --- GET AND UPDATE CLIENT SPECIFIC SETTINGS (Like AI Persona) ---
router.get('/client/settings', protect, async (req, res) => {
  try {
    await ensureClientForUser(req.user);

    const targetClientId = req.user.clientId;
    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }

    const client = await Client.findOne({ clientId: targetClientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    // Send the settings required by the frontend client/settings route
    res.json({ 
      ai: client.ai, 
      faq: client.faq, 
      websiteUrl: client.websiteUrl,
      businessHours: client.config?.businessHours
    });
  } catch (err) {
    log.error('Client settings fetch error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/client/settings', protect, async (req, res) => {
  try {
    await ensureClientForUser(req.user);
    const targetClientId = req.user.clientId;
    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }
    
    const aiBody = req.body.ai;
    if (aiBody) {
      const hasPersona =
        aiBody.persona &&
        typeof aiBody.persona === 'object' &&
        Object.keys(aiBody.persona).length > 0;
      const hasPrompt =
        aiBody.systemPrompt !== undefined &&
        aiBody.systemPrompt !== null &&
        String(aiBody.systemPrompt).trim() !== '';
      if (hasPersona || hasPrompt) {
        const { syncPersonaAcrossSystem } = require('../utils/personaEngine');
        await syncPersonaAcrossSystem(targetClientId, hasPersona ? aiBody.persona : {}, {
          systemPrompt: hasPrompt ? aiBody.systemPrompt : undefined,
        });
      }
    }

    const updateFields = {};
    if (aiBody) {
       if (aiBody.fallbackEnabled !== undefined) updateFields['ai.fallbackEnabled'] = aiBody.fallbackEnabled;
       if (aiBody.languages) updateFields['ai.languages'] = aiBody.languages;
       if (aiBody.translationConfig) updateFields['ai.translationConfig'] = aiBody.translationConfig;
       if (aiBody.negotiationSettings) updateFields['ai.negotiationSettings'] = aiBody.negotiationSettings;
       if (aiBody.orderTaking) updateFields['ai.orderTaking'] = aiBody.orderTaking;
       if (aiBody.geminiKey) updateFields['ai.geminiKey'] = aiBody.geminiKey;
    }

    if (req.body.faq !== undefined) updateFields.faq = req.body.faq;
    if (req.body.websiteUrl !== undefined) updateFields.websiteUrl = req.body.websiteUrl;
    if (req.body.businessHours !== undefined) updateFields['config.businessHours'] = req.body.businessHours;

    if (Object.keys(updateFields).length > 0) {
      await Client.findOneAndUpdate(
        { clientId: targetClientId },
        { $set: updateFields },
        { new: true }
      );
    }

    const updated = await Client.findOne({ clientId: targetClientId });
    if (!updated) return res.status(404).json({ message: 'Client not found' });

    res.json({ success: true, ai: updated.ai });
  } catch (err) {
    log.error('Client settings update error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   POST /api/admin/persona/sync
// @desc    Manually push global AI persona to all Flow Builder nodes
// @access  Private
router.post('/persona/sync', protect, async (req, res) => {
  try {
    await ensureClientForUser(req.user);
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const { syncPersonaToFlows } = require('../utils/personaEngine');
    await syncPersonaToFlows(clientId, client.ai?.persona || {});

    res.json({ success: true, message: 'AI Persona pushed to all flows successfully.' });
  } catch (error) {
    log.error('Persona sync error:', error);
    res.status(500).json({ message: 'Failed to synchronize flows', error: error.message });
  }
});

// --- GET SETTINGS BY CLIENTID (Super Admin) ---
router.get('/settings/:clientId', protect, isSuperAdmin, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    
    res.json({
      clientId: client.clientId,
      businessType: client.businessType,
      niche: client.niche,
      nicheData: client.nicheData,
      flowData: client.flowData,
      automationFlows: client.automationFlows,
      messageTemplates: client.messageTemplates,
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      plan: client.plan,
      isAIFallbackEnabled: client.isAIFallbackEnabled,
      flowFolders: client.flowFolders || [],
      visualFlows: client.visualFlows || []
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
// --- RUN AUTOMATION MIGRATION (Super Admin) ---
router.get('/run-automation-migration', protect, isSuperAdmin, async (req, res) => {
  try {
      const defaultAutomationFlows = [
        { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
        { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
        { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
      ];

      const defaultMessageTemplates = [
        {
          id: "cod_to_prepaid",
          body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
          buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
        },
        {
          id: "review_request",
          body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
          buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
        }
      ];

      const clients = await Client.find({});
      let updated = 0;

      for (const client of clients) {
          let isModified = false;

          if (!client.automationFlows || client.automationFlows.length === 0) {
              client.automationFlows = defaultAutomationFlows;
              isModified = true;
          } else {
               for (const defaultFlow of defaultAutomationFlows) {
                   if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                       client.automationFlows.push(defaultFlow);
                       isModified = true;
                   }
               }
          }

          if (!client.messageTemplates || client.messageTemplates.length === 0) {
               client.messageTemplates = defaultMessageTemplates;
               isModified = true;
          } else {
               for (const defaultTemp of defaultMessageTemplates) {
                   if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                       client.messageTemplates.push(defaultTemp);
                       isModified = true;
                   }
               }
          }

          if (isModified) {
              const setFields = {};
              if (client.automationFlows) setFields.automationFlows = client.automationFlows;
              if (client.messageTemplates) setFields.messageTemplates = client.messageTemplates;
              await Client.updateOne(
                { _id: client._id },
                { $set: setFields },
                { runValidators: false }
              );
              updated++;
          }
      }

      res.json({ message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (err) {
      log.error('Migration failed via API', { error: err.message });
      res.status(500).json({ message: 'Migration Failed', error: err.message });
  }
});

// --- AI FLOW GENERATION (Gemini) ---
router.post('/generate-flow', protect, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    let model = getGeminiModel(apiKey);

    const systemPrompt = `You are a WhatsApp chatbot flow designer. Given a business description, generate a JSON object with "nodes" and "edges" arrays for a ReactFlow diagram.
    
    The flow must ALWAYS start with a "trigger" node (id: "node_0").
    Connect nodes logically. For interactive buttons/lists, use source handles that match the item ID (e.g. "opt_1", "opt_2").
    
    Node Types and Schema (all data must be inside the 'data' object of the node):
    1. "trigger": { id: "...", type: "trigger", position: {x: 0, y: 0}, data: { label: "Start", keyword: "hi" } }
    2. "message": { id: "...", type: "message", position: {x: 0, y: 0}, data: { label: "Msg", body: "Hello!", imageUrl: "", footer: "" } }
    3. "interactive": { 
         id: "...", type: "interactive", position: {x: 0, y: 0}, 
         data: { 
           label: "Menu",
           interactiveType: "button", 
           header: "Welcome", 
           body: "Choose an option", 
           buttonsList: [{id: "opt_1", title: "Option 1"}],
           imageUrl: "", 
           footer: "" 
         }
       }
    4. "image": { id: "...", type: "image", position: {x: 0, y: 0}, data: { label: "Img", imageUrl: "...", body: "caption" } }
    5. "template": { id: "...", type: "template", position: {x: 0, y: 0}, data: { label: "Tpl", metaTemplateName: "...", languageCode: "en" } }
    
    Visual Layout:
    Position nodes logically with enough spacing (dx=350, dy=250) roughly in a tree left-to-right.
    
    Business description: ${prompt}
    
    Return ONLY valid JSON. No markdown. Start with { and end with }.`;

    console.log('[generate-flow] Calling Gemini API...');
    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      console.error('[generate-flow] Flash failed, falling back to Pro:', apiErr.message);
      model = getGeminiModel(apiKey);
      result = await model.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    console.log('[generate-flow] Gemini raw response (first 500 chars):', rawText.slice(0, 500));

    // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Extract the outermost JSON object
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[generate-flow] No JSON found in response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'AI did not return valid JSON', raw: rawText.slice(0, 300) });
    }

    let flow;
    try {
      flow = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[generate-flow] JSON parse error:', parseErr.message, '| raw:', jsonMatch[0].slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message, raw: jsonMatch[0].slice(0, 200) });
    }

    if (!flow.nodes || !flow.edges) {
      return res.status(500).json({ error: 'AI response missing nodes or edges', flow });
    }

    const cleanedGraph = validateAndCleanFlow({ nodes: flow.nodes || [], edges: flow.edges || [] }, 0);
    console.log('[generate-flow] Success — nodes:', cleanedGraph.nodes.length, '| edges:', cleanedGraph.edges.length);
    res.json({ success: true, nodes: cleanedGraph.nodes, edges: cleanedGraph.edges });
  } catch (err) {
    console.error('[generate-flow] FATAL:', err.message, err.stack?.slice(0, 500));
    res.status(500).json({ 
      error: 'AI Generation Failed: ' + err.message,
      suggestion: 'Check your GEMINI_API_KEY or try again.' 
    });
  }
});

// --- AI SMART FIX AUTOMATION ---
router.post('/flow/fix', protect, async (req, res) => {
  try {
    const { diagnostics, nodes, edges } = req.body;
    if (!diagnostics || !nodes || !edges) return res.status(400).json({ error: 'Missing diagnostic or graph data' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    let model = getGeminiModel(apiKey);

    const systemPrompt = `You are a WhatsApp chatbot flow engineer debugging a ReactFlow JSON graph.
    You will receive the current graph (nodes and edges) and a list of diagnostic errors.
    Your task is to fix the errors by intelligently modifying the "nodes" or "edges" array.
    
    Diagnostics:
    ${JSON.stringify(diagnostics, null, 2)}
    
    Current Nodes:
    ${JSON.stringify(nodes, null, 2)}
    
    Current Edges:
    ${JSON.stringify(edges, null, 2)}
    
    Return ONLY valid JSON with exactly two properties: "nodes" and "edges".
    DO NOT DELETE nodes unless absolutely necessary. Just fix the broken edges or properties.
    The response MUST be a valid JSON object. Do not add markdown formatting or explanations.`;

    console.log('[flow/fix] Calling Gemini API for smart fix...');
    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      console.warn('[flow/fix] Flash failed, falling back to Pro:', apiErr.message);
      model = getGeminiModel(apiKey);
      result = await model.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[flow/fix] No JSON found in response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'AI did not return valid JSON' });
    }

    let fixedGraph;
    try {
      fixedGraph = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message });
    }

    if (!fixedGraph.nodes || !fixedGraph.edges) {
      return res.status(500).json({ error: 'AI output missing nodes/edges' });
    }

    const cleanedGraph = validateAndCleanFlow({
      nodes: fixedGraph.nodes || nodes || [],
      edges: fixedGraph.edges || edges || []
    }, 0);

    console.log('[flow/fix] Success - Returning fixed graph.');
    res.json({ success: true, nodes: cleanedGraph.nodes, edges: cleanedGraph.edges });
  } catch (err) {
    console.error('[flow/fix] FATAL:', err.message);
    res.status(500).json({ error: 'AI Auto-Fix Failed: ' + err.message });
  }
});

// --- GEMINI KEY PROBE (no auth — for diagnostics) ---
router.get('/test-gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not set' });
  try {
    let model = getGeminiModel(apiKey);
    let result;
    try {
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    } catch (apiErr) {
        console.warn('[test-gemini] Flash failed, testing Pro:', apiErr.message);
        model = getGeminiModel(apiKey);
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    }
    const text = result.response.text().trim();
    res.json({ ok: true, raw: text.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- MANUAL SEEDING ROUTE (Admin Only) ---
router.post('/seed-niche-data', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            const defaults = (client.businessType === 'ecommerce' || client.niche === 'ecommerce') ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
            let wasUpdated = false;

            if (!client.nicheData) {
                client.nicheData = { ...defaults };
                wasUpdated = true;
            } else {
                // Merge missing fields
                for (const [k, v] of Object.entries(defaults)) {
                    if (client.nicheData[k] === undefined || client.nicheData[k] === "") {
                        client.nicheData[k] = v;
                        wasUpdated = true;
                    }
                }
            }

            if (wasUpdated) {
                client.markModified('nicheData');
                await client.save();
                updated++;
            }
        }
        res.json({ success: true, message: `${updated} clients seeded with default data.` });
    } catch (err) {
        res.status(500).json({ error: 'Seeding failed: ' + err.message });
    }
});

// --- REVENUE STATS AGGREGATION ---
router.get('/revenue-stats/:clientId?', protect, async (req, res) => {
  try {
    const DailyStat = require('../models/DailyStat');
    const targetClientId = req.params.clientId || req.user.clientId;
    const stats = await DailyStat.find({ clientId: targetClientId });
    
    const totals = stats.reduce((acc, s) => ({
        browseRecovered: acc.browseRecovered + (s.browseAbandonedCount || 0),
        cartMessages: acc.cartMessages + (s.cartRecoveryMessagesSent || 0),
        cartRevenue: acc.cartRevenue + (s.cartRevenueRecovered || 0),
        upsellCount: acc.upsellCount + (s.upsellConvertedCount || 0),
        upsellRevenue: acc.upsellRevenue + (s.upsellRevenue || 0),
        codConverted: acc.codConverted + (s.codConvertedCount || 0)
    }), { browseRecovered: 0, cartMessages: 0, cartRevenue: 0, upsellCount: 0, upsellRevenue: 0, codConverted: 0 });

    res.json({
        success: true,
        stats: [
            { label: 'Browse Recovery', value: totals.browseRecovered > 0 ? "12%" : "0%", sub: `${totals.browseRecovered} nudges sent`, color: 'blue' },
            { label: 'Cart Recovery', value: totals.cartRevenue > 0 ? "18%" : "0%", sub: `₹${totals.cartRevenue.toLocaleString()} recovered`, color: 'emerald' },
            { label: 'AI Upsell Rate', value: totals.upsellCount > 0 ? '4%' : '0%', sub: `${totals.upsellCount} conversions`, color: 'amber' },
            { label: 'COD Converted', value: totals.codConverted > 0 ? '22%' : '0%', sub: `₹${(totals.codConverted * 800).toLocaleString()} saved`, color: 'violet' }
          ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BROWSER-BASED SEEDING (GET) ---
// Paste this in browser: [BACKEND_URL]/api/admin/seed-now
router.get('/seed-now', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            if (!client.nicheData || Object.keys(client.nicheData).length === 0) {
                client.nicheData = (client.businessType === 'ecommerce' || client.clientId.includes('smarthomes')) ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
                await client.save();
                updated++;
            }
        }
        res.send(`<h1>Seeding Complete</h1><p>${updated} clients were updated with default niche data.</p><a href="/admin/settings">Back to Dashboard</a>`);
    } catch (err) {
        res.status(500).send(`<h1>Seeding Failed</h1><p>${err.message}</p>`);
    }
});

// --- PHASE 9: META TEMPLATE SYNC ---
router.get('/templates/sync/:clientId', protect, async (req, res) => {
    try {
        let { clientId } = req.params;
        const { key } = req.query;

        // Robustness: strip leading colon if user copy-pasted literally
        if (clientId.startsWith(':')) clientId = clientId.substring(1);

        // Allow bypass with secure key (for legacy/admin tools) or regular auth (handled by protect)
        const isSecureKey = key === 'topedge_secure_admin_123';
        if (!isSecureKey && !req.user) {
            return res.status(401).json({ message: "Not authorized. Provide key or login." });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        
        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing templates for ${clientId} via Meta API...`);
        const token = decrypt(client.whatsappToken);
        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        const approvedTemplates = response.data.data.filter(t => t.status === 'APPROVED');
        client.syncedMetaTemplates = approvedTemplates;
        await client.save();
        
        res.json({ success: true, count: approvedTemplates.length, data: approvedTemplates });
    } catch (err) {
        log.error('Template Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYNC META FLOWS ---
router.get('/flows/sync/:clientId', protect, async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing flows for ${clientId}...`);
        const token = decrypt(client.whatsappToken);
        const url = `https://graph.facebook.com/v21.0/${client.wabaId}/flows?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        
        const flows = response.data.data || [];
        client.syncedMetaFlows = flows;
        await client.save();
        
        res.json({ success: true, count: flows.length, flows });
    } catch (err) {
        log.error('Flow Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYSTEM MIGRATION (BROWSER-READY) ---
router.get('/run-full-migration', async (req, res) => {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
        return res.status(401).send('<h1>Access Denied</h1><p>Invalid migration key.</p>');
    }

    try {
        const clients = await Client.find({});
        let updated = 0;
        
        // Define missing defaults
        const defaultAutomationFlows = [
            { id: 'abandoned_cart', isActive: false },
            { id: 'cod_to_prepaid', isActive: false },
            { id: 'review_collection', isActive: false }
        ];

        for (const client of clients) {
            let isModified = false;
            
            // 1. Ensure automationFlows exists
            if (!client.automationFlows || client.automationFlows.length === 0) {
                client.automationFlows = defaultAutomationFlows;
                isModified = true;
            }

            // 2. Ensure simpleSettings exists
            if (!client.simpleSettings) {
                client.simpleSettings = { keywordFallbacks: [], variableMap: {}, welcomeStartNodeId: 'node_1' };
                isModified = true;
            }

            if (isModified) {
                await client.save();
                updated++;
            }
        }
        
        res.send(`<h1>Migration Successful</h1><p>Processed ${clients.length} clients. Updated ${updated} clients with new features.</p>`);
    } catch (err) {
        log.error('Migration failed', err.message);
        res.status(500).send(`<h1>Migration Error</h1><p>${err.message}</p>`);
    }
});


// --- PHASE 9/10: AI FLOW AUTO-GENERATION ---
router.post('/flow/autogen/:clientId', protect, async (req, res) => {
    try {
        const { prompt, flowNodes, flowEdges } = req.body;
        const client = await Client.findOne({ clientId: req.params.clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const existingFlow = (flowNodes && flowNodes.length > 0) ? { nodes: flowNodes, edges: flowEdges } : null;
        const aiFlow = await generateFlowForClient(client, prompt, existingFlow);
        if (!aiFlow) return res.status(500).json({ error: 'Failed to generate flow with AI. Please try again or provide more details.' });

        client.flowNodes = aiFlow.nodes;
        client.flowEdges = aiFlow.edges;
        if (prompt) client.systemPrompt = prompt;

        await client.save();
        res.json({ success: true, nodes: aiFlow.nodes, edges: aiFlow.edges });
    } catch (err) {
        log.error('Manual Auto-gen failed', { error: err.message });
        res.status(500).json({ error: 'Failed to generate flow: ' + err.message });
    }
});

// --- CONVERT LEGACY JS FLOW TO VISUAL FLOW (AI) ---
router.post('/flow/convert-legacy/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Map clientId to legacy file
        let fileName = (clientId === 'ved') ? 'delitech_smarthomes.js' : `${clientId}.js`;

        const filePath = path.join(CLIENT_CODE_DIR, fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(400).json({ error: `Legacy file not found: ${fileName}` });
        }

        const fileCode = fs.readFileSync(filePath, 'utf8');
        log.info(`Converting legacy flow for ${clientId}...`);

        const flowJson = await convertLegacyToVisual(clientId, fileCode);
        
        client.flowNodes = flowJson.nodes || [];
        client.flowEdges = flowJson.edges || [];
        client.isGenericBot = true; // Switch to generic hub engine after conversion
        await client.save();

        res.json({ success: true, message: `Migrated ${flowJson.nodes.length} nodes from legacy file.` });
    } catch (err) {
        log.error('Conversion Error', err.message);
        res.status(500).json({ error: 'Conversion failed: ' + err.message });
    }
});

// --- PHASE 13: MASTER MIGRATION (URL RUNNABLE) ---
/**
 * URL: [BASE_URL]/api/admin/phase13-migration?key=topedge_phase13_secure_99
 * Purpose: Transition all records to Phase 13 (Omnichannel + Gemini + Stability)
 */
router.get('/phase13-migration', async (req, res) => {
  const { key } = req.query;
  if (key !== 'topedge_phase13_secure_99') {
    return res.status(401).send("Unauthorized. Use ?key=topedge_phase13_secure_99");
  }

  const Conversation = require('../models/Conversation');
  const Message = require('../models/Message');
  const Order = require('../models/Order');

  const report = {
    clients: { total: 0, updated: 0 },
    conversations: { total: 0, updated: 0, lastStepFixed: 0 },
    messages: { total: 0, updated: 0 },
    orders: { total: 0, updated: 0 }
  };

  try {
    // 1. Update Clients
    const clients = await Client.find({});
    report.clients.total = clients.length;
    for (const client of clients) {
      let changed = false;
      
      // Default storeType to shopify for legacy
      if (!client.storeType) {
        client.storeType = "shopify";
        changed = true;
      }
      
      // Sync geminiApiKey from openaiApiKey if missing
      if (!client.geminiApiKey && client.openaiApiKey) {
        client.geminiApiKey = client.openaiApiKey;
        changed = true;
      }

      if (changed) {
        await client.save({ validateBeforeSave: false });
        report.clients.updated++;
      }
    }

    // 2. Update Conversations (Bulk)
    // - Add channel: whatsapp
    // - Fix lastStepId (if it's a phone number, set to null)
    const allConvs = await Conversation.find({});
    report.conversations.total = allConvs.length;
    
    // Check for phone numbers in lastStepId (crude regex check for 10+ digits)
    const phoneRegex = /^\+?[0-9]{10,15}$/;
    
    // We do sequential for lastStepId fix to be safe, or use updateMany for channel
    await Conversation.updateMany(
      { channel: { $exists: false } },
      { $set: { channel: "whatsapp" } }
    );
    
    for (const conv of allConvs) {
      if (conv.lastStepId && phoneRegex.test(conv.lastStepId)) {
        conv.lastStepId = null;
        await conv.save();
        report.conversations.lastStepFixed++;
      }
    }
    report.conversations.updated = await Conversation.countDocuments({ channel: "whatsapp" });

    // 3. Update Messages (Bulk)
    const msgResult = await Message.updateMany(
      { channel: { $exists: false } },
      { $set: { channel: "whatsapp" } }
    );
    report.messages.updated = msgResult.nModified;

    // 4. Update Orders
    // Ensure all existing orders have a source and handle codNudgePendingAt
    const orderResult = await Order.updateMany(
      { source: { $exists: false } },
      { $set: { source: "shopify" } }
    );
    report.orders.updated = orderResult.nModified;

    const resultMsg = `
      <h1>🚀 Phase 13 Migration Complete</h1>
      <pre>${JSON.stringify(report, null, 2)}</pre>
      <p><b>Clients:</b> ${report.clients.updated}/${report.clients.total} updated (StoreType & Gemini Keys)</p>
      <p><b>Conversations:</b> fixed ${report.conversations.lastStepFixed} corrupted states.</p>
      <p><b>Messages:</b> ${report.messages.updated} records moved to 'whatsapp' channel.</p>
      <p>Status: SUCCESS</p>
    `;
    res.send(resultMsg);

  } catch (err) {
    console.error("[Migration P13] ERROR:", err);
    res.status(500).send(`<h1>❌ Migration Failed</h1><pre>${err.message}</pre>`);
  }
});
// --- PHASE 18: PUBLISH FLOW (Sync draft to live) ---
router.post('/flow/publish/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { nodes = [], edges = [], note, flowId, forcePublish = false } = req.body;

    // Strict publish preflight (same gate as canonical /api/flow/publish)
    const { preflightValidateFlowGraph } = require('../utils/flowPublishPreflight');
    const preflight = preflightValidateFlowGraph({
      nodes,
      edges,
      client: client.toObject ? client.toObject() : client,
    });
    if (!preflight.valid && !forcePublish) {
      return res.status(400).json({
        success: false,
        error: 'Flow publish blocked: validation failed.',
        errors: preflight.errors,
        warnings: preflight.warnings,
      });
    }
    if (!preflight.valid && forcePublish) {
      log.warn(`[Publish Override] ${clientId} forced publish with ${preflight.errors.length} error(s).`);
    }
    
    // 1. Identify Templates used in the flow
    const { normalizeNodeType } = require('../utils/flowNodeContract');
    const templateNodes = nodes.filter(n => normalizeNodeType(n.type) === 'template');
    const templateNames = [...new Set(templateNodes.map(n => n.data?.templateName).filter(Boolean))];

    log.info(`[Publish] ${clientId} attempting to publish flow with ${templateNames.length} unique templates.`);

    // 2. Generate Template Payloads using Enterprise localization logic
    // We rebuild wizard-style data from modular client sub-docs
    const wizardData = {
      businessName: client.brand?.businessName || client.businessName,
      shopDomain: client.commerce?.shopify?.domain || client.shopDomain,
      businessLogo: client.businessLogo,
      currency: client.brand?.currency || "₹",
      products: client.products || []
    };
    
    const allSystemTemplates = getPrebuiltTemplates(wizardData);
    const templatesToSync = allSystemTemplates.filter(t => templateNames.includes(t.name));

    // 3. Register used templates with Meta Cloud API
    const syncResults = [];
    for (const tpl of templatesToSync) {
      try {
        log.info(`[Publish] Syncing template ${tpl.name} for ${clientId}...`);
        const syncRes = await WhatsApp.submitMetaTemplate(client, {
          name: tpl.name,
          category: tpl.category,
          language: tpl.language,
          components: tpl.components
        });
        syncResults.push({ name: tpl.name, status: syncRes.status || 'SYNCED', success: syncRes.success });
      } catch (err) {
        log.error(`[Publish] Failed to sync ${tpl.name}:`, err.message);
        syncResults.push({ name: tpl.name, status: 'FAILED', error: err.message });
      }
    }

    // 4. Update Client State & Versioning
    if (!client.flowHistory) client.flowHistory = [];
    client.flowHistory.push({
      version: client.flowHistory.length + 1,
      nodes: nodes,
      edges: edges,
      savedAt: new Date(),
      note: note || 'Manual publish'
    });

    client.flowNodes = nodes;
    client.flowEdges = edges;
    await client.save();
    
    // 5. Sync to WhatsAppFlow Collection
    const activeFlow = client.visualFlows?.find(f => f.isActive) || client.visualFlows?.[0];
    const targetFlowId = flowId || (activeFlow ? activeFlow.id : null);
    
    if (targetFlowId) {
       // Mark all others DRAFT, make this one PUBLISHED
       await WhatsAppFlow.updateMany({ clientId, platform: 'whatsapp' }, { $set: { status: 'DRAFT', isActive: false } });
       await WhatsAppFlow.findOneAndUpdate(
           { clientId, flowId: targetFlowId },
           {
               $set: {
                   status: 'PUBLISHED',
                   isActive: true,
                   publishedNodes: nodes,
                   publishedEdges: edges,
                   nodes: nodes,
                   edges: edges,
               }
           },
           { upsert: true }
       );
    }

    // 5b. Clear trigger cache so new keywords are immediately active
    try {
      const { clearTriggerCache } = require('../utils/triggerEngine');
      clearTriggerCache(clientId);
    } catch (_) {}

    // 6. Detailed Audit Logging
    await AuditLog.create({
      clientId,
      user_id: req.user.id,
      action_type: 'PUBLISH_FLOW',
      target_resource: targetFlowId || 'main',
      payload: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        templatesSynced: syncResults,
        version: client.flowHistory.length
      }
    });

    res.json({ 
      success: true, 
      message: 'Automation published successfully.', 
      version: client.flowHistory.length,
      syncResults,
      preflight,
      publishOverride: !!forcePublish
    });
  } catch (err) {
    log.error('[Publish] Critical failure:', err.message);
    res.status(500).json({ error: 'Failed to publish flow: ' + err.message });
  }
});

// --- PHASE 18: UNANSWERED QUESTIONS ---
router.get('/unanswered-questions/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ success: true, unansweredQuestions: client.unansweredQuestions || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET AUDIT LOGS (Client Admin or Super Admin) ---
router.get('/audit-logs', protect, authorize('SUPER_ADMIN', 'CLIENT_ADMIN'), async (req, res) => {
  try {
    const AuditLog = require('../models/AuditLog');
    
    // For SUPER_ADMIN, allow filtering by clientId query param. Otherwise default to nothing or everything?
    // Let's allow SUPER_ADMIN to see all if no clientId provided, or filter if provided.
    // For CLIENT_ADMIN, force filter by their own clientId.
    
    let query = {};
    if (req.user.role === 'SUPER_ADMIN') {
        if (req.query.clientId) {
            query.clientId = req.query.clientId;
        }
        // If no clientId, they see everything from all clients
    } else {
        query.clientId = req.user.clientId;
    }

    const logs = await AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(200) // Increased limit for audit trail
      .populate('user_id', 'name email');
    
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Error fetching audit logs', { error: err.message });
    res.status(500).json({ message: 'Server error fetching audit logs' });
  }
});

// ── ONBOARDING: Connection Test Endpoints ─────────────────────────────────────
// Pre-save credential validation for the onboarding wizards and settings page.

// POST /admin/test-whatsapp — Validates Meta Graph API credentials (phone + optional WABA ownership)
router.post('/test-whatsapp', protect, async (req, res) => {
  try {
    const { phoneNumberId, whatsappToken, wabaId } = req.body;
    if (!phoneNumberId || !whatsappToken) {
      return res.status(400).json({ success: false, message: 'Phone Number ID and Access Token are required.' });
    }

    const { validateWhatsAppCloudCredentials } = require('../utils/whatsappMetaValidate');
    const v = await validateWhatsAppCloudCredentials({
      phoneNumberId,
      whatsappToken,
      wabaId: wabaId || '',
    });

    if (!v.ok) {
      return res.status(400).json({
        success: false,
        message: v.message,
        code: v.code,
      });
    }

    res.json({
      success: true,
      phone: v.display_phone_number,
      name: v.verified_name || null,
      qualityRating: v.quality_rating || null,
      message: `Connected to ${v.display_phone_number}`,
    });
  } catch (err) {
    const metaError = err.response?.data?.error;
    const code = metaError?.code || err.response?.status;
    const msg = metaError?.message || err.message;

    log.warn('WhatsApp test failed', { code, msg });
    res.status(err.response?.status || 500).json({
      success: false,
      message: msg,
      code,
      subcode: metaError?.error_subcode
    });
  }
});

// GET /admin/whatsapp-webhook-instructions — per-workspace Callback URL + verify token for Meta BYOA webhooks
router.get('/whatsapp-webhook-instructions', protect, async (req, res) => {
  try {
    const {
      getWhatsAppWebhookPublicConfig,
      getMasterVerifyToken,
    } = require('../utils/whatsappWebhookPublic');
    const { buildWebhookDashboardStatus } = require('../utils/whatsappWebhookLifecycle');

    const clientId = req.user.clientId;
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'No clientId on session' });
    }

    const cfgShared = getWhatsAppWebhookPublicConfig();
    const origin = cfgShared.origin;
    const encClientId = encodeURIComponent(clientId);
    const callbackUrlTenant = `${origin}/api/client/${encClientId}/webhook`;

    let client = await Client.findOne({ clientId })
      .select('phoneNumberId wabaId clientId verifyToken whatsapp.phoneNumberId whatsapp.wabaId whatsapp.verifyToken platformVars')
      .lean();

    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const vtWa = String(client.whatsapp?.verifyToken || '').trim();
    const vtRoot = String(client.verifyToken || '').trim();
    let tenantVerifyToken = vtWa || vtRoot;

    if (!tenantVerifyToken) {
      tenantVerifyToken = `te_wa_${crypto.randomBytes(18).toString('hex')}`;
      await Client.updateOne(
        { clientId },
        { $set: { verifyToken: tenantVerifyToken, 'whatsapp.verifyToken': tenantVerifyToken } }
      );
    } else if (vtRoot && !vtWa) {
      await Client.updateOne({ clientId }, { $set: { 'whatsapp.verifyToken': vtRoot } });
    } else if (vtWa && !vtRoot) {
      await Client.updateOne({ clientId }, { $set: { verifyToken: vtWa } });
    }

    const fresh = await Client.findOne({ clientId })
      .select('phoneNumberId wabaId whatsapp.phoneNumberId whatsapp.wabaId platformVars verifyToken whatsapp.verifyToken')
      .lean();

    const phoneNumberId =
      fresh?.phoneNumberId || fresh?.whatsapp?.phoneNumberId || '';
    const wabaId = fresh?.wabaId || fresh?.whatsapp?.wabaId || '';
    const tenantVt =
      String(fresh?.whatsapp?.verifyToken || '').trim() ||
      String(fresh?.verifyToken || '').trim() ||
      tenantVerifyToken;

    const status = buildWebhookDashboardStatus(fresh?.platformVars || {}, phoneNumberId);

    res.json({
      success: true,
      origin,
      routingModel: 'per_workspace_url',
      callbackUrlTenant,
      /** Same as callbackUrlTenant — use this in Meta */
      callbackUrlPrimary: callbackUrlTenant,
      verifyToken: tenantVt,
      verifyTokenTenant: tenantVt,
      /** Legacy: one Meta app + one server META_APP_SECRET; not suitable when each tenant has their own Meta app */
      sharedWebhookRoot: cfgShared.callbackUrlPrimary,
      sharedWebhookAlternate: cfgShared.callbackUrlAlternate,
      verifyTokenShared: getMasterVerifyToken(),
      metaAppSecretConfigured: cfgShared.metaAppSecretConfigured,
      recommendedWebhookFields: cfgShared.recommendedWebhookFields,
      clientId,
      clientPhoneNumberId: phoneNumberId || null,
      clientWabaId: wabaId || null,
      ...status,
      checklist: [
        'Meta for Developers → your app → WhatsApp → Configuration.',
        `Callback URL — paste exactly (includes your workspace id):\n${callbackUrlTenant}`,
        'Verify token — paste from below (must match exactly). Click “Verify and save” in Meta.',
        'Required for inbound chats: in the same Meta app, open Webhooks → WhatsApp Business Account → Manage → turn ON “messages”. If “messages” is off, customer replies never reach TopEdge.',
        'Optional: subscribe “message_template_status_update” if you use Meta-approved templates.',
      ],
      multiTenantNote:
        'Each workspace uses its own URL path (/api/client/{your_id}/webhook) and its own verify token stored in TopEdge. Deploy with SERVER_URL or PUBLIC_WEBHOOK_BASE_URL set to your public API origin.',
      postUsesSignature: cfgShared.metaAppSecretConfigured
        ? 'Shared root URLs (/ and /whatsapp-webhook) verify X-Hub-Signature-256 with META_APP_SECRET — only when that secret matches your Meta app. Per-workspace URLs do not use that check (required for BYOA).'
        : 'META_APP_SECRET is not set on this server — signature verification is not enforced on shared root URLs.',
    });
  } catch (err) {
    log.warn('whatsapp-webhook-instructions failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/whatsapp-webhook-ack — user confirms they pasted URL/token in Meta (optional hint for status)
router.post('/whatsapp-webhook-ack', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'No clientId on session' });
    }
    await Client.updateOne(
      { clientId },
      { $set: { 'platformVars.whatsappWebhookSetupAckAt': new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    log.warn('whatsapp-webhook-ack failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /admin/test-shopify — Validates Shopify Admin API credentials
router.post('/test-shopify', protect, async (req, res) => {
  try {
    const { shopDomain, shopifyAccessToken } = req.body;
    if (!shopDomain || !shopifyAccessToken) {
      return res.status(400).json({ success: false, message: 'Shop domain and access token are required.' });
    }

    const cleanDomain = shopDomain.replace('https://', '').replace('http://', '').split('/')[0];

    const response = await axios.get(
      `https://${cleanDomain}/admin/api/${shopifyAdminApiVersion}/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken },
        timeout: 10000
      }
    );

    if (response.data?.shop) {
      res.json({
        success: true,
        shopName: response.data.shop.name,
        domain: response.data.shop.domain,
        plan: response.data.shop.plan_display_name,
        message: `Connected to ${response.data.shop.name}`
      });
    } else {
      res.json({ success: false, message: 'Unexpected response from Shopify. Check your domain and token.' });
    }
  } catch (err) {
    const status = err.response?.status;
    let msg = err.message;

    if (status === 401) msg = 'Invalid Shopify Admin API token. Make sure you\'re using an Admin API token (not Storefront) with the required scopes.';
    else if (status === 404) msg = 'Store not found. Double-check your .myshopify.com domain.';
    else if (status === 403) msg = 'Access denied. Your API token may lack the required scopes (read_products, read_orders).';

    log.warn('Shopify test failed', { status, msg });
    res.status(status || 500).json({ success: false, message: msg });
  }
});

// POST /admin/test-email — Validates SMTP email credentials
router.post('/test-email', protect, async (req, res) => {
  try {
    const { emailUser, emailAppPassword } = req.body;
    if (!emailUser || !emailAppPassword) {
      return res.status(400).json({ success: false, message: 'Email address and app password are required.' });
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailAppPassword },
      connectionTimeout: 8000,
    });

    await transporter.verify();
    res.json({ success: true, message: `SMTP connection verified for ${emailUser}` });
  } catch (err) {
    log.warn('Email test failed', { error: err.message });

    let msg = 'SMTP authentication failed.';
    if (err.code === 'EAUTH') msg = 'Invalid email or app password. For Gmail, make sure you\'re using an App Password (not your regular password).';
    else if (err.code === 'ESOCKET') msg = 'Could not connect to the email server. Check your network and try again.';

    res.status(400).json({ success: false, message: msg });
  }
});

module.exports = router;
