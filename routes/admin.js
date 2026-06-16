const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/core/logger')('AdminAPI');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { getDefaultFlowForNiche } = require('../utils/flow/defaultFlowNodes');
const { generateFlowForClient } = require('../utils/flow/flowAutogen');
const { runFullMigration } = require('../scripts/phase9MigrationLogic');
const { getGeminiModel } = require('../utils/core/gemini');
const { validateAndCleanFlow } = require('../utils/flow/aiFlowBuilder');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const shopifyAdminApiVersion = require('../utils/shopify/shopifyAdminApiVersion');
const { encrypt, decrypt } = require('../utils/core/encryption');
const { sanitizeMiddleware } = require('../utils/core/sanitize');
const { ensureClientForUser } = require('../utils/core/ensureClientForUser');
const { syncPersonaToFlows } = require('../utils/core/personaEngine');
const { getPrebuiltTemplates } = require('../utils/flow/flowGenerator');
const WhatsApp = require('../utils/meta/whatsapp');
const AuditLog = require('../models/AuditLog');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const LifecycleAutomationLog = require('../models/LifecycleAutomationLog');
const { sendSystemEmail } = require('../utils/core/emailService');
const { renderBrandedEmail } = require('../services/mjmlEmailRenderer');
const { formatInr } = require('../config/planCatalog');
const { sendPlatformWhatsAppTemplate } = require('../services/lifecycle/platformWelcomeWhatsApp');
const { normalizeIndianPhone } = require('../utils/core/normalizeIndianPhone');
const AdLead = require('../models/AdLead');
const Campaign = require('../models/Campaign');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { adminSensitiveLimiter } = require('../middleware/adminRateLimits');
const { requireAdminPermission } = require('../middleware/requireAdminPermission');
const {
  blockMasterTesterOnAdmin,
  requireAdminUser,
  applyClientScopeFilter,
  authorizeAdminScope,
  getAllowedClientIds,
} = require('../middleware/adminAccess');

function denyUnlessAdminClientAccess(req, res, clientId) {
  const allowed = getAllowedClientIds(req);
  const target = String(clientId || '').trim();
  if (allowed?.length && !allowed.includes(target)) {
    res.status(403).json({ success: false, message: 'Client not in your allowed list' });
    return false;
  }
  return true;
}

router.use(blockMasterTesterOnAdmin);

router.post('/shopify/force-sync', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const { refreshShopifyToken } = require('../utils/shopify/shopifyHelper');
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

const isSuperAdmin = requireAdminUser;
const MARKETING_DESK_MAX_CONTACTS = Number(process.env.MARKETING_DESK_MAX_CONTACTS || 500);
// --- TEST WHATSAPP CONNECTION ---
router.post('/test-whatsapp-send', protect, isSuperAdmin, async (req, res) => {
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


const { enrichClientsForList } = require('../utils/admin/clientListEnrichment');

function buildAdminClientListFilter(query = {}) {
  const filter = { isActive: { $ne: false }, deletedAt: { $exists: false }, isPlatformInternal: { $ne: true } };
  if (query.includeInternal === 'true') {
    delete filter.isPlatformInternal;
  }
  if (query.search) {
    filter.$or = [
      { businessName: { $regex: query.search, $options: 'i' } },
      { clientId: { $regex: query.search, $options: 'i' } },
      { name: { $regex: query.search, $options: 'i' } },
    ];
  }
  if (query.status === 'suspended') filter.suspendedAt = { $ne: null };
  if (query.status === 'vip') filter.isLifetimeAdmin = true;
  if (query.status === 'trial') {
    filter.trialActive = { $ne: false };
    filter.isLifetimeAdmin = { $ne: true };
    filter.suspendedAt = null;
  }
  if (query.status === 'trial_expired') {
    filter.trialEndsAt = { $lt: new Date() };
    filter.isLifetimeAdmin = { $ne: true };
    filter.isPaidAccount = { $ne: true };
  }
  if (query.status === 'paid') filter.isPaidAccount = true;
  if (query.plan && query.plan !== 'all') filter.plan = query.plan;
  if (query.store && query.store !== 'all') filter.storeType = query.store;
  if (query.channels === 'whatsapp') {
    filter.$and = (filter.$and || []).concat([
      { phoneNumberId: { $exists: true, $ne: '' } },
      { wabaId: { $exists: true, $ne: '' } },
    ]);
  }
  if (query.channels === 'instagram') filter.instagramConnected = true;
  return filter;
}

// --- GET ALL CLIENTS ---
router.get('/clients', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    if (req.query.check_id) {
      const taken = await Client.exists({
        clientId: String(req.query.check_id).trim(),
        isActive: { $ne: false },
      });
      return res.json({ success: true, checkIdTaken: !!taken });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const skip = (page - 1) * limit;
    const filter = applyClientScopeFilter(buildAdminClientListFilter(req.query), req);

    const [rawClients, total] = await Promise.all([
      Client.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'clientId businessName name plan tier wabaId phoneNumberId whatsappToken shopifyAccessToken shopDomain storeType instagramConnected adminEmail emailUser trialActive trialEndsAt isLifetimeAdmin isPaidAccount suspendedAt billing createdAt updatedAt geminiApiKey openaiApiKey config'
        )
        .lean(),
      Client.countDocuments(filter),
    ]);

    const data = await enrichClientsForList(rawClients);

    res.json({
      success: true,
      data,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    log.error('Error fetching clients', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// --- EXPORT CLIENTS CSV ---
router.get('/clients/export', protect, authorizeAdminScope('viewClients'), async (req, res) => {
  try {
    const filter = applyClientScopeFilter(buildAdminClientListFilter(req.query), req);
    const clients = await Client.find(filter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .select('clientId businessName name plan storeType trialActive trialEndsAt isLifetimeAdmin isPaidAccount suspendedAt createdAt')
      .lean();
    const header = 'clientId,businessName,plan,storeType,status,createdAt\n';
    const rows = clients
      .map((c) => {
        const name = (c.businessName || c.name || '').replace(/"/g, '""');
        return `"${c.clientId}","${name}","${c.plan || ''}","${c.storeType || ''}","${c.suspendedAt ? 'suspended' : 'active'}","${c.createdAt || ''}"`;
      })
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="topedge-clients.csv"');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const { requireAdminMigrationSecret } = require('../middleware/adminMigrationAuth');

// --- RUN AUTOMATION MIGRATION (Super Admin) ---
router.get('/run-migration', requireAdminMigrationSecret, async (req, res) => {
  try {

    const defaultAutomationFlows = [
      { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
      { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
    ];

    const defaultMessageTemplates = [
      {
        id: "cod_to_prepaid",
        body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
        buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
      },
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

// --- ROLE PROMOTION (EMERGENCY — migration secret + super admin) ---
router.get('/promote-me', requireAdminMigrationSecret, protect, isSuperAdmin, async (req, res) => {
  try {
    const { email, role } = req.query;
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
router.get('/folderize-clients', requireAdminMigrationSecret, protect, isSuperAdmin, async (req, res) => {
  try {
    const { target } = req.query;

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
function resolveAdminClientQuery(idParam) {
  const mongoose = require('mongoose');
  const raw = String(idParam || '').trim();
  if (!raw) return null;
  if (mongoose.Types.ObjectId.isValid(raw)) return { _id: raw };
  return { clientId: raw };
}

router.get('/clients/:id', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ message: 'Invalid client id' });

    const client = await Client.findOne(query).lean();
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const { getAccessForUserClient } = require('../utils/core/accessFlags');
    const access = await getAccessForUserClient(req.user, client);

    await AuditLog.create({
      clientId: client.clientId,
      category: 'admin',
      action_type: 'ADMIN_VIEWED_CLIENT_DETAIL',
      severity: 'info',
      actor: { type: 'super_admin', userId: req.user._id, source: 'admin_panel' },
      payload: { adminEmail: req.user.email },
    }).catch(() => {});

    res.json({
      ...client,
      workspaceAccess: access,
    });
  } catch (err) {
    console.error('Error fetching client details:', err);
    res.status(500).json({ message: 'Server error fetching client details' });
  }
});

router.get('/clients/:id/credentials', protect, isSuperAdmin, adminSensitiveLimiter, requireAdminPermission('viewSensitiveKeys'), async (req, res) => {
  try {
    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ message: 'Invalid client id' });

    const client = await Client.findOne(query).lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    await AuditLog.create({
      clientId: client.clientId,
      category: 'security',
      action_type: 'ADMIN_VIEWED_SENSITIVE_CREDENTIALS',
      severity: 'critical',
      actor: { type: 'super_admin', userId: req.user._id, source: 'admin_panel' },
      payload: { adminEmail: req.user.email },
    });

    const decryptField = (v) => {
      if (!v) return '';
      try {
        return decrypt(v) || v;
      } catch {
        return v;
      }
    };

    res.json({
      success: true,
      clientId: client.clientId,
      whatsappToken: decryptField(client.whatsappToken || client.config?.whatsappToken),
      shopifyAccessToken: decryptField(client.shopifyAccessToken || client.config?.shopifyAccessToken),
      geminiApiKey: client.geminiApiKey || '',
      openaiApiKey: client.openaiApiKey || '',
      emailAppPassword: client.emailAppPassword || '',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/admin/clients/:id/entitlements
 * Secure VIP grant / revoke — mirrors scripts/grantLifetimeAccess.js with audit trail.
 * Body: { action: 'grant'|'revoke', note?, grantUserLifetime?, suspend? }
 */
router.post('/clients/:id/entitlements', protect, isSuperAdmin, async (req, res) => {
  try {
    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ success: false, message: 'Invalid client id' });

    const existing = await Client.findOne(query).select('clientId name').lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Client not found' });

    const action = String(req.body?.action || 'grant').toLowerCase();
    const { grantFullWorkspaceAccess, revokeFullWorkspaceAccess } = require('../utils/core/entitlements');
    const { auditSecurity } = require('../middleware/securityAudit');
    const { getAccessForUserClient } = require('../utils/core/accessFlags');

    let client;
    if (action === 'revoke') {
      client = await revokeFullWorkspaceAccess(existing.clientId, {
        suspend: req.body?.suspend === true,
      });
      auditSecurity('ADMIN_ENTITLEMENT_REVOKE', {
        req,
        tenantId: existing.clientId,
        targetClientId: existing.clientId,
        reason: req.body?.note || 'admin_revoke',
      });
    } else if (action === 'grant') {
      client = await grantFullWorkspaceAccess(existing.clientId, {
        note: req.body?.note || 'Granted via Admin Dashboard',
        paymentSource: req.body?.paymentSource || 'paytm_offline',
        grantUserLifetime: req.body?.grantUserLifetime === true,
        plan: req.body?.plan,
        tier: req.body?.tier,
      });
      auditSecurity('ADMIN_ENTITLEMENT_GRANT', {
        req,
        tenantId: existing.clientId,
        targetClientId: existing.clientId,
        reason: req.body?.note || 'admin_grant',
      });
    } else if (action === 'suspend') {
      client = await Client.findOneAndUpdate(
        { clientId: existing.clientId },
        { $set: { suspendedAt: new Date() } },
        { new: true }
      );
      auditSecurity('ADMIN_CLIENT_SUSPENDED', { req, targetClientId: existing.clientId });
    } else if (action === 'unsuspend') {
      client = await Client.findOneAndUpdate(
        { clientId: existing.clientId },
        { $unset: { suspendedAt: '' } },
        { new: true }
      );
      auditSecurity('ADMIN_CLIENT_UNSUSPENDED', { req, targetClientId: existing.clientId });
    } else {
      return res.status(400).json({ success: false, message: 'action must be grant, revoke, suspend, or unsuspend' });
    }

    await AuditLog.create({
      action: `ENTITLEMENT_${action.toUpperCase()}`,
      performedBy: req.user._id,
      targetClientId: existing.clientId,
      details: {
        note: req.body?.note,
        grantUserLifetime: req.body?.grantUserLifetime,
        ip: req.ip,
      },
    }).catch(() => {});

    const access = await getAccessForUserClient(req.user, client);
    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(existing.clientId).catch(() => {});

    res.json({
      success: true,
      client,
      workspaceAccess: access,
      message:
        action === 'grant'
          ? `Full access granted for ${existing.clientId}`
          : action === 'revoke'
            ? `Access revoked for ${existing.clientId}`
            : `Client ${action} applied`,
    });
  } catch (err) {
    log.error('Entitlements action failed', { error: err.message });
    res.status(500).json({ success: false, message: err.message });
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
      const { generateText } = require('../utils/core/gemini');
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
    await AuditLog.create({
      clientId: clientId.trim(),
      category: 'admin',
      action_type: 'CLIENT_CREATED',
      severity: 'info',
      actorEmail: req.user?.email,
      userId: req.user?._id,
      payload: { plan: tier, businessName },
    }).catch(() => {});

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
      isLifetimeAdmin, isPaidAccount, paymentSource, offlinePaymentNote,
      suspendedAt, unsuspend,
      geminiApiKey, systemPrompt,
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
    if (isLifetimeAdmin !== undefined) {
      updateData.isLifetimeAdmin = !!isLifetimeAdmin;
    }
    if (isPaidAccount !== undefined) {
      updateData.isPaidAccount = !!isPaidAccount;
      updateData['billing.isPaidAccount'] = !!isPaidAccount;
      if (isPaidAccount) updateData['billing.paymentSource'] = paymentSource || 'offline';
    }
    if (offlinePaymentNote !== undefined) {
      updateData['billing.offlinePaymentNote'] = String(offlinePaymentNote || '');
    }
    if (geminiApiKey !== undefined) {
      updateData.geminiApiKey = geminiApiKey;
      updateData['ai.geminiKey'] = geminiApiKey;
    }
    if (systemPrompt !== undefined) {
      updateData.systemPrompt = systemPrompt;
      updateData['ai.persona.systemPrompt'] = systemPrompt;
    }
    if (unsuspend === true) {
      updateData.suspendedAt = null;
    } else if (suspendedAt !== undefined) {
      updateData.suspendedAt = suspendedAt ? new Date(suspendedAt) : null;
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

    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ message: 'Invalid client id' });

    const $unset = {};
    if (unsuspend === true || suspendedAt === null) {
      $unset.suspendedAt = '';
    }

    const updatedClient = await Client.findOneAndUpdate(
      query,
      Object.keys($unset).length ? { $set: updateData, $unset } : { $set: updateData },
      { new: true, runValidators: false }
    );

    if (!updatedClient) {
      log.warn(`Update client not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Client not found' });
    }

    const { clearClientCache } = require('../middleware/apiCache');
    await clearClientCache(updatedClient.clientId).catch(() => {});

    await AuditLog.create({
      action: 'ADMIN_CLIENT_UPDATE',
      performedBy: req.user._id,
      targetClientId: updatedClient.clientId,
      details: { fields: Object.keys(req.body || {}) },
    }).catch(() => {});

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
    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ message: 'Invalid client id' });

    const deletedClient = await Client.findOneAndUpdate(
      query,
      { $set: { isActive: false, deletedAt: new Date() } },
      { new: true }
    );
    if (!deletedClient) {
      return res.status(404).json({ message: 'Client not found' });
    }

    await AuditLog.create({
      clientId: deletedClient.clientId,
      category: 'admin',
      action_type: 'CLIENT_SOFT_DELETED',
      severity: 'critical',
      actor: { type: 'super_admin', userId: req.user._id, source: 'admin_panel' },
      payload: { adminEmail: req.user.email },
    });

    res.json({ message: 'Client deactivated successfully (Soft Deleted)' });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/clients/:id/permanent', protect, isSuperAdmin, adminSensitiveLimiter, requireAdminPermission('deleteClients'), async (req, res) => {
  try {
    const { confirmationToken, reason } = req.body || {};
    const expected = process.env.ADMIN_PERMANENT_DELETE_TOKEN || 'PERMANENT_DELETE_CONFIRM';
    if (confirmationToken !== expected) {
      return res.status(403).json({ message: 'Invalid confirmation token' });
    }

    const query = resolveAdminClientQuery(req.params.id);
    if (!query) return res.status(400).json({ message: 'Invalid client id' });

    const client = await Client.findOne(query).lean();
    if (!client) return res.status(404).json({ message: 'Client not found' });

    await User.deleteMany({ clientId: client.clientId });
    await Client.deleteOne({ _id: client._id });

    await AuditLog.create({
      clientId: client.clientId,
      category: 'admin',
      action_type: 'CLIENT_PERMANENTLY_DELETED',
      severity: 'critical',
      actor: { type: 'super_admin', userId: req.user._id, source: 'admin_panel' },
      payload: { adminEmail: req.user.email, reason: reason || '' },
    });

    res.json({ success: true, message: 'Client permanently deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- CLIENT SELF-SERVICE: Update own nicheData/flowData ---
// Any authenticated user can update their OWN client's editable fields
const { apiCache } = require('../middleware/apiCache');
const { getCachedClient } = require('../utils/core/clientCache');

const MY_SETTINGS_MAIN_SELECT =
  '-flowNodes -flowEdges -visualFlows -messageTemplates -automationFlows -nicheData';
const MY_SETTINGS_WIDGET_SELECT = 'websiteChatWidgetConfig visualFlows';

router.get('/my-settings', protect, sanitizeMiddleware, apiCache(90), async (req, res) => {
  try {
    const { clientId } = req.query;

    // Priority: Query Param (SuperAdmin only) > User Object
    const targetClientId =
      req.user?.role === 'SUPER_ADMIN' && clientId ? clientId : req.user?.clientId;

    if (!targetClientId) {
      log.warn('Settings access attempted without clientId', { user: req.user?.email });
      return res.status(400).json({
        success: false,
        message: 'Identity mismatch: No target clientId established.',
      });
    }

    setImmediate(() => {
      ensureClientForUser(req.user).catch(() => {});
    });

    const [clientLean, widgetLean] = await Promise.all([
      getCachedClient(targetClientId, MY_SETTINGS_MAIN_SELECT),
      getCachedClient(targetClientId, MY_SETTINGS_WIDGET_SELECT),
    ]);

    if (!clientLean) {
      log.warn('Client registry missing', { targetClientId });
      return res.status(404).json({
        success: false,
        message: `No configuration payload found for id: ${targetClientId}`,
      });
    }

    const { flattenClientForSettingsUI } = require('../utils/core/settingsSyncMapper');
    const { buildWebsiteWidgetSettingsBundle } = require('../utils/core/websiteWidgetDefaults');
    const flat = flattenClientForSettingsUI(clientLean);

    const origin = `${req.protocol}://${req.get('host')}`;
    const websiteWidgetBundle = buildWebsiteWidgetSettingsBundle(
      widgetLean || {},
      { clientId: targetClientId, origin }
    );

    res.json({
      ...clientLean,
      ...flat,
      websiteWidgetBundle,
    });
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
      /** Lightweight auto-save merge: PATCH { flowDraft: { flowId, nodes, edges } } */
      flowDraft,
      wabaId, phoneNumberId, whatsappToken, verifyToken,
      shopDomain, shopifyClientId, shopifyClientSecret, shopifyAccessToken, shopifyWebhookSecret, shopifyConnectionStatus,
      facebookCatalogId, metaCatalogAccessToken, shopifyStorefrontToken,
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
      businessName,
      botName,
      supportPhone,
      tone,
      botLanguage,
      businessLogo,
      businessDescription,
      industry,
      cartTiming,
      policies,
      returnPolicy,
      refundPolicy,
      shippingPolicy,
      shippingTime,
      returnsPolicyUrl,
      faqUrl,
      privacyUrl,
      termsUrl,
      authorizedSignature,
      commerceFlowPack,
      warrantyEmailEnabled,
      warrantyWhatsappEnabled,
      warrantyDuration,
      warrantyPolicy,
      warrantySupportPhone,
      warrantySupportEmail,
      warrantyClaimUrl,
      websiteChatWidgetConfig,
      audienceContext,
    } = req.body;
    
    // Tenant isolation: regular users always save to their JWT clientId only.
    let targetClientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && clientId) {
      targetClientId = clientId;
    } else if (
      clientId &&
      String(clientId).trim() &&
      String(clientId).trim() !== String(req.user.clientId || '')
    ) {
      return res.status(403).json({
        success: false,
        message: 'Cannot modify another workspace from this account',
      });
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

      const { validateWhatsAppCloudCredentials } = require('../utils/meta/whatsappMetaValidate');
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
    if (flowFolders !== undefined) {
      if (!Array.isArray(flowFolders)) {
        return res.status(400).json({ success: false, message: 'flowFolders must be an array' });
      }
      updateFields.flowFolders = flowFolders
        .filter((f) => f && typeof f === 'object' && String(f.id || '').trim())
        .slice(0, 50)
        .map((f) => ({
          id: String(f.id).trim().slice(0, 80),
          name: String(f.name || 'Folder').trim().slice(0, 120) || 'Folder',
          ...(f.color ? { color: String(f.color).slice(0, 32) } : {}),
        }));
    }
    if (visualFlows !== undefined) updateFields.visualFlows = visualFlows;
    if (websiteChatWidgetConfig !== undefined) {
      const { mergeWebsiteWidgetConfig } = require('../utils/core/websiteWidgetDefaults');
      updateFields.websiteChatWidgetConfig = mergeWebsiteWidgetConfig(websiteChatWidgetConfig);
    }

    if (audienceContext && typeof audienceContext === 'object') {
      const VALID_PLATFORMS = ['shopify', 'none', 'woocommerce', 'custom'];
      const VALID_THIRD_PARTY = [
        'shopify_native',
        'gokwik',
        'razorpay_magic',
        'cashfree',
        'shiprocket',
        'other_third_party',
        'unknown',
        'not_sure',
      ];
      const ac = audienceContext;
      if (ac.storePlatform && VALID_PLATFORMS.includes(ac.storePlatform)) {
        updateFields['audienceContext.storePlatform'] = ac.storePlatform;
        updateFields['audienceContext.manualOverrides.storePlatform'] = ac.storePlatform;
      }
      if (ac.thirdPartyCheckout && VALID_THIRD_PARTY.includes(ac.thirdPartyCheckout)) {
        updateFields['audienceContext.thirdPartyCheckout'] = ac.thirdPartyCheckout;
        updateFields['audienceContext.manualOverrides.thirdPartyCheckout'] = ac.thirdPartyCheckout;
      }
      if (ac.checkoutSignal) {
        updateFields['audienceContext.checkoutSignal'] = ac.checkoutSignal;
      }
      updateFields['audienceContext.updatedAt'] = new Date();
    }

    // Partial flow graph merge (autosave) — avoids sending full visualFlows payloads
    if (flowDraft && flowDraft.flowId) {
      const WhatsAppFlow = require('../models/WhatsAppFlow');
      const { flattenFlowNodes } = require('../utils/flow/flowGraphResolver');
      const { flowId, nodes = [], edges = [] } = flowDraft;
      const flatSteps = flattenFlowNodes(nodes).length;
      const linkCount = Array.isArray(edges) ? edges.length : 0;
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
        nodeCount: flatSteps,
        edgeCount: linkCount,
        updatedAt: new Date(),
      };
      if (ix >= 0) vf[ix] = patchFlow;
      else vf.push(patchFlow);
      updateFields.visualFlows = vf;

      // Autosave: invalidate stale cache only — never push draft nodes into runtime cache.
      try {
        const { invalidateFlowGraphCache } = require('../utils/flow/flowGraphCache');
        invalidateFlowGraphCache(targetClientId, flowId);
      } catch (cacheErr) {
        console.warn('[flowDraft] graph cache invalidate failed:', cacheErr.message);
      }
    }

    // Commercial & Meta Fields
    if (wabaId !== undefined) {
      updateFields.wabaId = wabaId;
      updateFields['whatsapp.wabaId'] = wabaId;
      updateFields['config.wabaId'] = wabaId;
    }
    if (phoneNumberId !== undefined) {
      updateFields.phoneNumberId = phoneNumberId;
      updateFields['whatsapp.phoneNumberId'] = phoneNumberId;
      updateFields['config.phoneNumberId'] = phoneNumberId;
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
      updateFields['config.whatsappToken'] = whatsappToken;
    }

    if (waPatchRequested) {
      updateFields.whatsappConnectionType = 'manual';
      updateFields.whatsappConnectionMethod = 'manual';
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
      if (String(shopifyConnectionStatus).toLowerCase() === 'disconnected') {
        updateFields.shopifyStores = [];
        updateFields.shopifyRefreshToken = '';
        updateFields['commerce.shopify.refreshToken'] = '';
        updateFields.shopifyTokenExpiresAt = null;
        updateFields.lastShopifyError = '';
      }
    }

    if (facebookCatalogId !== undefined) {
      updateFields.facebookCatalogId = String(facebookCatalogId || '').trim();
    }
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
    if (botName !== undefined) {
      updateFields['platformVars.agentName'] = String(botName || '').trim();
      updateFields['ai.persona.name'] = String(botName || '').trim();
    }
    if (supportPhone !== undefined) {
      updateFields['platformVars.supportWhatsapp'] = String(supportPhone || '').trim();
      updateFields['platformVars.supportPhone'] = String(supportPhone || '').trim();
    }
    if (tone !== undefined) {
      const { normalizePersonaTone } = require('../utils/core/personaEngine');
      const nt = normalizePersonaTone(tone) || String(tone || '').trim();
      if (nt) {
        updateFields['platformVars.defaultTone'] = nt;
        updateFields['ai.persona.tone'] = nt;
      }
    }
    if (botLanguage !== undefined) {
      updateFields['platformVars.defaultLanguage'] = String(botLanguage || '').trim();
      updateFields['ai.persona.language'] = String(botLanguage || '').trim();
    }
    if (businessLogo !== undefined) updateFields.businessLogo = businessLogo;
    if (typeof commerceFlowPack === 'boolean') updateFields.commerceFlowPack = commerceFlowPack;
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

    const { applySettingsSyncMirrors } = require('../utils/core/settingsSyncMapper');
    applySettingsSyncMirrors(updateFields, req.body);

    const updated = await Client.findOneAndUpdate(
      { clientId: targetClientId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    // Clear token probe cache when credentials change — forces immediate re-validation
    if (waPatchRequested || shopifyAccessToken !== undefined || updateFields.razorpayKeyId) {
      setImmediate(async () => {
        try {
          const { writeProbeCache } = require('../utils/security/connectionTokenProbe');
          if (waPatchRequested) await writeProbeCache(targetClientId, 'whatsapp', { tokenStatus: 'valid', ok: true, at: new Date().toISOString() });
          if (shopifyAccessToken !== undefined) await writeProbeCache(targetClientId, 'shopify', { tokenStatus: 'valid', ok: true, at: new Date().toISOString() });
        } catch (_) {}
      });
    }

    // Auto Template: Emit metaConnected when wabaId is saved for the first time
    if (wabaId && wabaId.trim()) {
      try {
        const { getIO } = require('../utils/core/socket');
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
        if (!f?.id) continue;
        const existing = await WhatsAppFlow.findOne({
          flowId: f.id,
          clientId: targetClientId,
        })
          .select('nodes edges publishedNodes publishedEdges')
          .lean();

        const incomingNodes = Array.isArray(f.nodes) ? f.nodes : [];
        const incomingEdges = Array.isArray(f.edges) ? f.edges : [];
        const metaCount = Number(f.nodeCount) || 0;

        let nodes = incomingNodes;
        let edges = incomingEdges;
        if (!nodes.length) {
          if (existing?.nodes?.length) nodes = existing.nodes;
          else if (existing?.publishedNodes?.length) nodes = existing.publishedNodes;
        }
        if (!edges.length) {
          if (existing?.edges?.length) edges = existing.edges;
          else if (existing?.publishedEdges?.length) edges = existing.publishedEdges;
        }
        if (!nodes.length && metaCount > 0) {
          continue;
        }

        // B8: settings save is draft-only — never promote to publishedNodes here.
        const setPayload = {
          name: f.name || 'Untitled Flow',
          platform: f.platform || 'whatsapp',
          folderId: f.folderId || null,
          status: 'DRAFT',
        };
        if (nodes.length) {
          setPayload.nodes = nodes;
          setPayload.edges = edges;
        }

        await WhatsAppFlow.findOneAndUpdate(
          { flowId: f.id, clientId: targetClientId },
          { $set: setPayload },
          { upsert: true }
        );
      }
    }

    log.success(`${req.user.role} updated settings for: ${targetClientId}`);
    
    const personaNeedsSync =
      ai?.persona ||
      botName !== undefined ||
      tone !== undefined ||
      botLanguage !== undefined;

    if (personaNeedsSync) {
      try {
        const { syncPersonaAcrossSystem } = require('../utils/core/personaEngine');
        const personaPatch = {
          ...(ai?.persona || {}),
          ...(botName !== undefined ? { name: String(botName || '').trim() } : {}),
          ...(tone !== undefined
            ? { tone: require('../utils/core/personaEngine').normalizePersonaTone(tone) || tone }
            : {}),
          ...(botLanguage !== undefined ? { language: String(botLanguage || '').trim() } : {}),
        };
        await syncPersonaAcrossSystem(targetClientId, personaPatch, {
          systemPrompt: updated.ai?.systemPrompt || updated.systemPrompt,
        });
      } catch (syncErr) {
        log.warn(`[Settings] Persona sync skipped: ${syncErr.message}`);
      }
    }

    try {
      const { clearClientCache } = require('../middleware/apiCache');
      const { invalidateBootstrapCache } = require('../utils/core/bootstrapCache');
      await clearClientCache(targetClientId);
      invalidateBootstrapCache(req.user?.id);
    } catch (cacheErr) {
      log.warn(`[Settings] Cache invalidation skipped: ${cacheErr.message}`);
    }

    try {
      const { emitToClient } = require('../utils/core/socket');
      const draftOnlyKeys = new Set(['flowDraft', 'clientId']);
      const bodyKeys = Object.keys(req.body || {}).filter((k) => req.body[k] !== undefined);
      const isFlowDraftOnly =
        flowDraft?.flowId && bodyKeys.length > 0 && bodyKeys.every((k) => draftOnlyKeys.has(k));
      emitToClient(targetClientId, 'client:config-updated', {
        clientId: targetClientId,
        source: isFlowDraftOnly ? 'flow-draft' : 'settings',
        at: new Date().toISOString(),
      });
    } catch (_) {}

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
// POST /api/admin/test-admin-alert — dry-run admin escalation to configured team contacts
router.post('/test-admin-alert', protect, async (req, res) => {
  try {
    const { clientId: bodyClientId } = req.body || {};
    let targetClientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && bodyClientId) {
      targetClientId = bodyClientId;
    } else if (
      bodyClientId &&
      String(bodyClientId).trim() &&
      String(bodyClientId).trim() !== String(req.user.clientId || '')
    ) {
      return res.status(403).json({ success: false, message: 'Cannot test alerts for another workspace' });
    }

    const client = await Client.findOne({ clientId: targetClientId }).lean();
    if (!client) {
      return res.status(404).json({ success: false, message: 'Workspace not found' });
    }

    const NotificationService = require('../utils/core/notificationService');
    const { resolveAdminAlertTemplateName } = require('../utils/core/notificationService');
    const templateName = resolveAdminAlertTemplateName(client);

    const results = await NotificationService.sendAdminAlert(client, {
      customerPhone: req.body?.customerPhone || client.supportPhone || client.adminPhone || '+919999999999',
      topic: 'Test admin alert — please confirm you received this',
      triggerSource: 'Settings test button',
      customerQuery: 'This is a test escalation from TopEdge AI settings.',
      skipDedup: true,
    });

    return res.json({
      success: true,
      templateApproved: !!templateName,
      templateName: templateName || 'admin_human_alert',
      results,
    });
  } catch (err) {
    log.error('test-admin-alert error', { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});
// --- GET PRESET FLOW BY BUSINESS TYPE ---
const flowPresets = require('../utils/flow/flowPresets');

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
        const { syncPersonaAcrossSystem } = require('../utils/core/personaEngine');
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

// @route   POST /api/admin/persona/sync — removed (AI Brain persona page retired)

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
      ];

      const defaultMessageTemplates = [
        {
          id: "cod_to_prepaid",
          body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
          buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
        },
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

// --- AI SMART FIX AUTOMATION (FB-P1-05 — single handler via flowFixController) ---
const { fixFlowWithAI } = require('../controllers/flowFixController');
router.post('/flow/fix', protect, fixFlowWithAI);

// --- GEMINI KEY PROBE (super admin only) ---
router.get('/test-gemini', protect, isSuperAdmin, async (req, res) => {
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
router.get('/run-full-migration', requireAdminMigrationSecret, protect, isSuperAdmin, async (req, res) => {

    try {
        const clients = await Client.find({});
        let updated = 0;
        
        // Define missing defaults
        const defaultAutomationFlows = [
            { id: 'abandoned_cart', isActive: false },
            { id: 'cod_to_prepaid', isActive: false },
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

// --- CONVERT LEGACY JS FLOW TO VISUAL FLOW (removed) ---
router.post('/flow/convert-legacy/:clientId', protect, isSuperAdmin, async (req, res) => {
    return res.status(410).json({
        error: 'Legacy clientcode files were removed. Use Flow Builder or POST /api/admin/flow/autogen for this tenant.',
    });
});

// --- PHASE 13: MASTER MIGRATION (URL RUNNABLE) ---
/**
 * URL: [BASE_URL]/api/admin/phase13-migration?key=topedge_phase13_secure_99
 * Purpose: Transition all records to Phase 13 (Omnichannel + Gemini + Stability)
 */
router.get('/phase13-migration', requireAdminMigrationSecret, protect, isSuperAdmin, async (req, res) => {

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
// --- PHASE 18: PUBLISH FLOW — alias removed Phase 6 ---
router.post('/flow/publish/:clientId', protect, (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'gone',
    message: 'Use POST /api/flow/publish/:clientId instead.',
    canonical: `/api/flow/publish/${req.params.clientId}`,
  });
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

// --- GET AUDIT LOG (Super Admin viewer — Phase 5) ---
router.get('/audit-log', protect, authorizeAdminScope('viewAuditLog'), async (req, res) => {
  try {
    const AuditLog = require('../models/AuditLog');
    const {
      clientId,
      action,
      category,
      fromDate,
      toDate,
      page = 1,
      limit = 100,
    } = req.query;
    const query = {};
    if (clientId) query.clientId = clientId;
    if (action) query.action_type = new RegExp(String(action), 'i');
    if (category) query.category = category;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) query.createdAt.$lte = new Date(toDate);
    }
    const skip = (Math.max(1, Number(page)) - 1) * Math.min(500, Number(limit));
    const lim = Math.min(500, Number(limit));
    const [data, total] = await Promise.all([
      AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
      AuditLog.countDocuments(query),
    ]);
    res.json({ success: true, data, total, page: Number(page), limit: lim });
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching audit log' });
  }
});

router.get('/audit-log/export', protect, authorizeAdminScope('viewAuditLog'), async (req, res) => {
  try {
    const AuditLog = require('../models/AuditLog');
    const logs = await AuditLog.find({}).sort({ createdAt: -1 }).limit(5000).lean();
    const header = 'createdAt,clientId,category,action_type,severity,user_id\n';
    const rows = logs
      .map((l) =>
        [
          l.createdAt?.toISOString(),
          l.clientId,
          l.category,
          l.action_type,
          l.severity,
          l.user_id,
        ].join(',')
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-log.csv');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ message: 'Export failed' });
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
    let { phoneNumberId, whatsappToken, wabaId, clientId: bodyClientId } = req.body;
    const targetClientId =
      req.user.role === 'SUPER_ADMIN' && bodyClientId ? String(bodyClientId).trim() : req.user.clientId;

    let effPid = String(phoneNumberId || '').trim();
    let effTok = String(whatsappToken || '').trim();
    let effWaba = String(wabaId || '').trim();

    if ((!effTok || effTok === '••••••••') && targetClientId) {
      const existing = await Client.findOne({ clientId: targetClientId })
        .select('phoneNumberId wabaId whatsappToken')
        .lean();
      if (existing) {
        if (!effPid) effPid = String(existing.phoneNumberId || '').trim();
        if (!effWaba) effWaba = String(existing.wabaId || '').trim();
        try {
          const { decrypt } = require('../utils/core/encryption');
          effTok = decrypt(existing.whatsappToken || '') || '';
        } catch (_) {
          effTok = '';
        }
      }
    }

    if (!effPid || !effTok) {
      return res.status(400).json({
        success: false,
        message: 'Phone Number ID and Access Token are required. Paste your permanent token if updating an existing connection.',
      });
    }

    const { validateWhatsAppCloudCredentials } = require('../utils/meta/whatsappMetaValidate');
    const v = await validateWhatsAppCloudCredentials({
      phoneNumberId: effPid,
      whatsappToken: effTok,
      wabaId: effWaba || '',
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
    } = require('../utils/meta/whatsappWebhookPublic');
    const { buildWebhookDashboardStatus } = require('../utils/meta/whatsappWebhookLifecycle');

    const clientId = tenantClientId(req);
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
    const clientId = tenantClientId(req);
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

router.get('/metrics/live', protect, authorizeAdminScope('viewMetrics'), async (req, res) => {
  try {
    const requestMetrics = require('../middleware/requestMetrics');
    const metricsCollector = require('../services/observability/metricsCollector');
    const { getAppRedis } = require('../utils/core/redisFactory');
    const redis = getAppRedis();
    const range = String(req.query.range || '24h');
    let queueDepth = {};
    if (redis) {
      for (const q of [
        'campaign-dispatch',
        'sequence-dispatch',
        'webhook-delivery',
        'flow-resumption',
        'template-sync',
        'shopify-sync',
      ]) {
        try {
          const n = await redis.llen(`bull:${q}:wait`);
          queueDepth[q] = Number(n) || 0;
        } catch {
          queueDepth[q] = 0;
        }
      }
    }
    const mongoose = require('mongoose');
    const { getTelemetryErrorTimeseries } = require('../services/observability/telemetryIngestService');
    const [requestSeries, telemetryErrors] = await Promise.all([
      Promise.resolve(
        typeof requestMetrics.getTimeseries === 'function'
          ? requestMetrics.getTimeseries(range)
          : { points: [] }
      ),
      getTelemetryErrorTimeseries({ range }),
    ]);
    res.json({
      success: true,
      range,
      requestMetrics: typeof requestMetrics.summarize === 'function' ? requestMetrics.summarize() : {},
      requestTimeseries: requestSeries,
      telemetryErrorTimeseries: telemetryErrors,
      customMetrics: metricsCollector.snapshot(),
      queueDepth,
      systemHealth: {
        api: true,
        redis: !!redis,
        mongo: mongoose.connection.readyState === 1,
      },
      at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/dead-letters', protect, authorizeAdminScope('viewDeadLetters'), async (req, res) => {
  try {
    const DeadLetterWebhook = require('../models/DeadLetterWebhook');
    const rows = await DeadLetterWebhook.find({}).sort({ deadLetteredAt: -1 }).limit(100).lean();
    res.json({ success: true, rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/dead-letters/:id/retry', protect, authorizeAdminScope('retryDeadLetters'), async (req, res) => {
  try {
    const DeadLetterWebhook = require('../models/DeadLetterWebhook');
    const WebhookConfig = require('../models/WebhookConfig');
    const { enqueueWebhookDelivery } = require('../utils/messaging/queues/webhookDeliveryQueue');
    const row = await DeadLetterWebhook.findById(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });
    await WebhookConfig.findByIdAndUpdate(row.subscriptionId, {
      isActive: true,
      pausedReason: null,
      consecutiveFailures: 0,
    });
    await enqueueWebhookDelivery({
      configId: String(row.subscriptionId),
      event: row.event,
      payload: row.payload,
      clientId: row.clientId,
      deliveryId: `${row.deliveryId}-retry`,
    });
    await DeadLetterWebhook.deleteOne({ _id: row._id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/dead-letters/:id', protect, authorizeAdminScope('retryDeadLetters'), async (req, res) => {
  try {
    const DeadLetterWebhook = require('../models/DeadLetterWebhook');
    await DeadLetterWebhook.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/usage-summary', protect, authorizeAdminScope('viewMetrics'), async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId query required' });
    }
    const days = parseInt(req.query.days, 10) || 7;
    const { getProductUsageSummary } = require('../services/observability/telemetryIngestService');
    const { getSessionStatsForClient } = require('../services/observability/dashboardSessionService');
    const summary = await getProductUsageSummary(clientId, { days });
    const sessionStats = await getSessionStatsForClient(clientId, { days });
    res.json({
      success: true,
      clientId,
      sessionStats,
      adminOnly: true,
      ...summary,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/reliability/summary', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getPlatformReliabilitySummary } = require('../services/observability/reliabilityService');
    const days = parseInt(req.query.days, 10) || 7;
    const limit = parseInt(req.query.limit, 10) || 50;
    const data = await getPlatformReliabilitySummary({ days, limit });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/reliability/:clientId/send-log', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getFailedTemplateSendLogs } = require('../services/observability/reliabilityService');
    const days = parseInt(req.query.days, 10) || 7;
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 30) * 24 * 3600 * 1000);
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 40;
    const data = await getFailedTemplateSendLogs(req.params.clientId, { since, page, limit });
    res.json({ success: true, clientId: req.params.clientId, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/reliability/:clientId', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getClientReliabilityDetail } = require('../services/observability/reliabilityService');
    const days = parseInt(req.query.days, 10) || 7;
    const data = await getClientReliabilityDetail(req.params.clientId, { days });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/sessions', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getAdminSessionSummary } = require('../services/observability/dashboardSessionService');
    const hours = parseInt(req.query.hours, 10) || 24;
    const limit = parseInt(req.query.limit, 10) || 50;
    const rows = await getAdminSessionSummary({ hours, limit });
    res.json({ success: true, hours, rows, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/client-health', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getClientHealthSummary } = require('../services/observability/telemetryIngestService');
    const hours = parseInt(req.query.hours, 10) || 24;
    const limit = parseInt(req.query.limit, 10) || 50;
    const rows = await getClientHealthSummary({ hours, limit });
    res.json({ success: true, hours, rows, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/client-health/:clientId/events', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getClientTelemetryEvents } = require('../services/observability/telemetryIngestService');
    const limit = parseInt(req.query.limit, 10) || 50;
    const hours = parseInt(req.query.hours, 10) || 72;
    const rows = await getClientTelemetryEvents(req.params.clientId, { limit, hours });
    res.json({ success: true, clientId: req.params.clientId, rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/client-health/:clientId/detail', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getClientHealthDetail } = require('../services/observability/telemetryIngestService');
    const hours = parseInt(req.query.hours, 10) || 72;
    const data = await getClientHealthDetail(req.params.clientId, { hours });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/telemetry/client-health/:clientId/timeseries', protect, authorizeAdminScope('viewErrors'), async (req, res) => {
  try {
    const { getTelemetryErrorTimeseries } = require('../services/observability/telemetryIngestService');
    const hours = parseInt(req.query.hours, 10) || 24;
    const range = hours <= 1 ? '1h' : hours <= 6 ? '6h' : hours <= 24 ? '24h' : '7d';
    const data = await getTelemetryErrorTimeseries({ range, clientId: req.params.clientId });
    res.json({ success: true, clientId: req.params.clientId, ...data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/tenant-economics', protect, authorizeAdminScope('viewMetrics'), async (req, res) => {
  try {
    const DailyTenantUsageCost = require('../models/DailyTenantUsageCost');
    const rows = await DailyTenantUsageCost.find({})
      .sort({ date: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, rows, disclaimer: 'Revenue and costs are estimates.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/billing/overview', protect, authorizeAdminScope('viewMetrics'), async (req, res) => {
  try {
    const { filter = 'all' } = req.query || {};
    const scopedClientFilter = applyClientScopeFilter({}, req);
    const clients = await Client.find(scopedClientFilter)
      .select('clientId name businessName plan isLifetimeAdmin trialEndsAt billing')
      .lean();
    const clientMap = new Map(clients.map((c) => [String(c.clientId), c]));
    const clientIds = clients.map((c) => String(c.clientId));

    const subs = await Subscription.find({ clientId: { $in: clientIds } })
      .select('clientId plan status currentPeriodEnd amount updatedAt')
      .lean();
    const invoices = await Invoice.find({ clientId: { $in: clientIds } })
      .sort({ createdAt: -1 })
      .select('clientId createdAt paidAt amount status')
      .lean();
    const latestInvoiceMap = new Map();
    for (const inv of invoices) {
      const key = String(inv.clientId);
      if (!latestInvoiceMap.has(key)) latestInvoiceMap.set(key, inv);
    }

    const rows = clients.map((client) => {
      const sub = subs.find((s) => String(s.clientId) === String(client.clientId));
      const inv = latestInvoiceMap.get(String(client.clientId));
      return {
        clientId: client.clientId,
        clientName: client.name || client.businessName || client.clientId,
        plan: sub?.plan || client.plan || 'trial',
        status: sub?.status || (client.isLifetimeAdmin ? 'vip' : 'trial'),
        currentPeriodEnd: sub?.currentPeriodEnd || client.trialEndsAt || null,
        estimatedMrrInr: sub?.amount ? Math.round(Number(sub.amount) / 100) : 0,
        lastInvoiceAt: inv?.paidAt || inv?.createdAt || null,
        isLifetimeAdmin: !!client.isLifetimeAdmin,
      };
    }).filter((row) => {
      if (filter === 'trial_7d') {
        const dt = row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null;
        if (!dt || Number.isNaN(dt.getTime())) return false;
        const ms = dt.getTime() - Date.now();
        return ms >= 0 && ms <= 7 * 24 * 60 * 60 * 1000 && row.status === 'trial';
      }
      if (filter === 'past_due') return row.status === 'past_due';
      if (filter === 'vip') return row.isLifetimeAdmin === true;
      return true;
    });

    res.json({ success: true, rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/billing/:clientId/extend-trial', protect, authorizeAdminScope('assignPlans'), async (req, res) => {
  try {
    const targetClientId = String(req.params.clientId || '').trim();
    if (!denyUnlessAdminClientAccess(req, res, targetClientId)) return;
    const days = Math.max(1, Math.min(60, Number(req.body?.days) || 7));
    const nextTrialDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    await Client.updateOne(
      { clientId: targetClientId },
      {
        $set: {
          trialActive: true,
          trialEndsAt: nextTrialDate,
          'billing.trialActive': true,
          'billing.trialEndsAt': nextTrialDate,
        },
      }
    );
    res.json({ success: true, clientId: targetClientId, trialEndsAt: nextTrialDate });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/billing/:clientId/grant-vip', protect, authorizeAdminScope('grantVIP'), async (req, res) => {
  try {
    const targetClientId = String(req.params.clientId || '').trim();
    if (!denyUnlessAdminClientAccess(req, res, targetClientId)) return;
    const { grantFullWorkspaceAccess } = require('../utils/core/entitlements');
    const out = await grantFullWorkspaceAccess(targetClientId, {
      grantedBy: req.user?._id || req.user?.id || null,
      reason: req.body?.note || 'admin_billing_ops_grant',
      grantUserLifetime: true,
    });
    res.json({ success: true, client: out });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/billing/:clientId/resend-reminder', protect, authorizeAdminScope('assignPlans'), async (req, res) => {
  try {
    const targetClientId = String(req.params.clientId || '').trim();
    if (!denyUnlessAdminClientAccess(req, res, targetClientId)) return;
    const [client, sub, adminUser] = await Promise.all([
      Client.findOne({ clientId: targetClientId }).lean(),
      Subscription.findOne({ clientId: targetClientId }).lean(),
      User.findOne({ clientId: targetClientId, role: 'CLIENT_ADMIN' }).select('name email phone').lean(),
    ]);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    if (!sub) return res.status(400).json({ success: false, message: 'No subscription found' });

    const sentForKey = `manual-billing-reminder:${targetClientId}:${Date.now()}`;
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'your renewal date';
    const amount = sub.amount ? Math.round(Number(sub.amount) / 100) : 0;
    const billingUrl = `${String(process.env.TOPEDGE_DASHBOARD_URL || 'https://dash.topedgeai.com').replace(/\/$/, '')}/billing`;

    if (adminUser?.email) {
      const html = renderBrandedEmail({
        brandName: 'TopEdge AI',
        title: 'Billing reminder',
        bodyHtml: `Hi ${adminUser.name || client.name || 'there'}, your plan renews on ${periodEnd}. Upcoming amount: ${amount ? formatInr(amount) : 'as per your plan'}.`,
        ctaUrl: billingUrl,
        ctaLabel: 'Open billing',
      });
      const ok = await sendSystemEmail({ to: adminUser.email, subject: 'TopEdge billing reminder', html });
      await LifecycleAutomationLog.create({
        clientId: targetClientId, clientName: client.name || client.businessName || '', automationType: 'billing_reminder',
        channel: 'email', status: ok ? 'sent' : 'failed', reason: ok ? '' : 'send_failed', sentForKey,
      }).catch(() => {});
    }
    if (adminUser?.phone) {
      const wa = await sendPlatformWhatsAppTemplate({
        toPhone: adminUser.phone,
        templateName: String(process.env.TOPEDGE_BILLING_REMINDER_TEMPLATE_NAME || '').trim() || 'topedge_billing_reminder_7d_v1',
        components: [{ type: 'body', parameters: [{ type: 'text', text: adminUser.name || client.name || 'there' }, { type: 'text', text: periodEnd }, { type: 'text', text: amount ? formatInr(amount) : 'your plan amount' }] }],
      });
      await LifecycleAutomationLog.create({
        clientId: targetClientId, clientName: client.name || client.businessName || '', automationType: 'billing_reminder',
        channel: 'whatsapp', status: wa.sent ? 'sent' : wa.skipped ? 'skipped' : 'failed', reason: wa.reason || '', sentForKey,
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/billing/:clientId/resend-receipt', protect, authorizeAdminScope('assignPlans'), async (req, res) => {
  try {
    const targetClientId = String(req.params.clientId || '').trim();
    if (!denyUnlessAdminClientAccess(req, res, targetClientId)) return;
    const [client, sub, adminUser, latestInvoice] = await Promise.all([
      Client.findOne({ clientId: targetClientId }).lean(),
      Subscription.findOne({ clientId: targetClientId }).lean(),
      User.findOne({ clientId: targetClientId, role: 'CLIENT_ADMIN' }).select('name email phone').lean(),
      Invoice.findOne({ clientId: targetClientId }).sort({ createdAt: -1 }).lean(),
    ]);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    if (!sub) return res.status(400).json({ success: false, message: 'No subscription found' });

    const sentForKey = `manual-payment-receipt:${targetClientId}:${Date.now()}`;
    const amount = latestInvoice?.amount ? Math.round(Number(latestInvoice.amount) / 100) : (sub.amount ? Math.round(Number(sub.amount) / 100) : 0);
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'your current billing period';

    if (adminUser?.email) {
      const html = renderBrandedEmail({
        brandName: 'TopEdge AI',
        title: 'Payment received',
        bodyHtml: `Hi ${adminUser.name || client.name || 'there'}, we received your payment${amount ? ` of ${formatInr(amount)}` : ''}. Plan: ${sub.plan || 'TopEdge'}. Next renewal: ${periodEnd}.`,
        ctaUrl: latestInvoice?.invoiceUrl || '',
        ctaLabel: latestInvoice?.invoiceUrl ? 'View invoice' : 'Open dashboard',
      });
      const ok = await sendSystemEmail({ to: adminUser.email, subject: 'TopEdge payment receipt', html });
      await LifecycleAutomationLog.create({
        clientId: targetClientId, clientName: client.name || client.businessName || '', automationType: 'payment_success',
        channel: 'email', status: ok ? 'sent' : 'failed', reason: ok ? '' : 'send_failed', sentForKey,
      }).catch(() => {});
    }
    if (adminUser?.phone) {
      const wa = await sendPlatformWhatsAppTemplate({
        toPhone: adminUser.phone,
        templateName: String(process.env.TOPEDGE_PAYMENT_SUCCESS_TEMPLATE_NAME || '').trim() || 'topedge_payment_success_v1',
        components: [{ type: 'body', parameters: [{ type: 'text', text: adminUser.name || client.name || 'there' }, { type: 'text', text: amount ? formatInr(amount) : 'your payment' }, { type: 'text', text: periodEnd }] }],
      });
      await LifecycleAutomationLog.create({
        clientId: targetClientId, clientName: client.name || client.businessName || '', automationType: 'payment_success',
        channel: 'whatsapp', status: wa.sent ? 'sent' : wa.skipped ? 'skipped' : 'failed', reason: wa.reason || '', sentForKey,
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/lifecycle/log', protect, authorizeAdminScope('viewMetrics'), async (req, res) => {
  try {
    const {
      automationType = 'all',
      status = 'all',
      limit: rawLimit = '50',
      before = '',
    } = req.query || {};

    const limit = Math.min(100, Math.max(1, parseInt(rawLimit, 10) || 50));
    const query = {};
    if (automationType !== 'all') query.automationType = String(automationType);
    if (status !== 'all') query.status = String(status);
    if (before) {
      const dt = new Date(before);
      if (!Number.isNaN(dt.getTime())) query.createdAt = { $lt: dt };
    }

    const rows = await LifecycleAutomationLog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length ? items[items.length - 1].createdAt : null;

    res.json({
      success: true,
      items,
      hasMore,
      nextCursor,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/lifecycle/review-summary', protect, authorizeAdminScope('viewMetrics'), async (_req, res) => {
  try {
    const clients = await Client.find({ platformReviewRating: { $gte: 1, $lte: 5 } })
      .select('platformReviewRating becamePayingAt')
      .lean();
    const eligible = await Client.countDocuments({
      becamePayingAt: { $ne: null },
      isLifetimeAdmin: { $ne: true },
    });
    const responded = clients.length;
    const avgRating = responded
      ? Number((clients.reduce((sum, c) => sum + Number(c.platformReviewRating || 0), 0) / responded).toFixed(2))
      : 0;
    const lowRatings = clients.filter((c) => Number(c.platformReviewRating || 0) <= 3).length;
    const responseRate = eligible > 0 ? Number(((responded / eligible) * 100).toFixed(2)) : 0;
    res.json({
      success: true,
      avgRating,
      responseRate,
      lowRatings,
      responded,
      eligible,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

function getPlatformClientId() {
  return String(process.env.TOPEDGE_SYSTEM_CLIENT_ID || 'topedge_platform_support').trim();
}

function canManagePlatformCampaigns(req) {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  if (!req.user?.isAdminTeam) return false;
  return !!req.user?.permissions?.managePlatformCampaigns;
}

function canManageCompanyInbox(req) {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  if (!req.user?.isAdminTeam) return false;
  return !!req.user?.permissions?.manageCompanyInbox;
}

function parseCsvRows(csvText = '') {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((v) => String(v || '').trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] || '';
    });
    return row;
  });
}

router.post('/marketing-desk/import', protect, async (req, res) => {
  try {
    if (!canManagePlatformCampaigns(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const platformClientId = getPlatformClientId();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : parseCsvRows(req.body?.csvText || '');
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Upload CSV rows or csvText' });
    }
    if (rows.length > MARKETING_DESK_MAX_CONTACTS) {
      return res.status(400).json({ success: false, message: `Max ${MARKETING_DESK_MAX_CONTACTS} contacts per campaign` });
    }
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const phone = normalizeIndianPhone(row.phone || row.mobile || row.number || '');
      if (!phone) {
        skipped += 1;
        continue;
      }
      await AdLead.updateOne(
        { clientId: platformClientId, phoneNumber: phone },
        {
          $set: {
            phoneNumber: phone,
            name: String(row.name || row.full_name || '').trim(),
            source: 'Platform Marketing Desk',
            tags: String(row.tags || '')
              .split('|')
              .map((t) => t.trim())
              .filter(Boolean),
            optStatus: 'opted_in',
            optInSource: 'csv_import',
            optInDate: new Date(),
            lastInteraction: new Date(),
          },
          $setOnInsert: { clientId: platformClientId },
        },
        { upsert: true }
      );
      imported += 1;
    }
    return res.json({ success: true, imported, skipped, maxContacts: MARKETING_DESK_MAX_CONTACTS });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/marketing-desk/campaigns', protect, async (req, res) => {
  try {
    if (!canManagePlatformCampaigns(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const platformClientId = getPlatformClientId();
    const { name, templateName, consentAttested, dryRun, dryRunCompleted } = req.body || {};
    if (!templateName) return res.status(400).json({ success: false, message: 'templateName required' });
    if (!consentAttested) return res.status(400).json({ success: false, message: 'Consent attestation required' });
    const leads = await AdLead.find({
      clientId: platformClientId,
      phoneNumber: { $exists: true, $ne: '' },
      optStatus: { $ne: 'opted_out' },
    })
      .sort({ updatedAt: -1 })
      .limit(MARKETING_DESK_MAX_CONTACTS + 1)
      .lean();
    if (leads.length > MARKETING_DESK_MAX_CONTACTS) {
      return res.status(400).json({ success: false, message: `Audience exceeds ${MARKETING_DESK_MAX_CONTACTS}` });
    }
    const audience = leads.map((l) => ({ _id: l._id, phone: l.phoneNumber, name: l.name || 'Lead' }));
    if (dryRun === false && !dryRunCompleted) {
      return res.status(400).json({ success: false, message: 'Run a dry-run first before live launch' });
    }
    const campaign = await Campaign.create({
      clientId: platformClientId,
      name: name || `Platform campaign ${new Date().toISOString().slice(0, 10)}`,
      templateName,
      channel: 'whatsapp',
      campaignType: 'STANDARD',
      templateCategory: 'MARKETING',
      status: dryRun ? 'DRAFT' : 'QUEUED',
      audience,
      audienceCount: audience.length,
      metadata: {
        marketingDesk: true,
        dryRun: dryRun !== false,
        consentAttested: true,
        dryRunCompletedAt: dryRun !== false ? new Date() : null,
      },
    });

    if (dryRun !== false) {
      return res.json({
        success: true,
        mode: 'dry_run',
        campaignId: campaign._id,
        wouldSend: audience.length,
      });
    }
    const { launchCampaignDispatch } = require('../services/campaignLaunchService');
    const launch = await launchCampaignDispatch(campaign, audience);
    return res.json({
      success: true,
      mode: 'live',
      campaignId: campaign._id,
      enqueued: launch.enqueued || 0,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/company-inbox/conversations', protect, async (req, res) => {
  try {
    if (!canManageCompanyInbox(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const platformClientId = getPlatformClientId();
    const tag = String(req.query.tag || 'all');
    const query = { clientId: platformClientId };
    if (tag !== 'all') query.tags = tag;
    const rows = await Conversation.find(query)
      .sort({ lastMessageAt: -1 })
      .limit(200)
      .lean();
    for (const row of rows) {
      const phone = String(row.phone || '').replace(/\D/g, '');
      if (!phone) continue;
      const phoneVariants = [phone, `+${phone}`, phone.startsWith('91') ? phone.slice(2) : `91${phone}`];
      const matchedUser = await User.findOne({ phone: { $in: phoneVariants } }).select('clientId').lean();
      const matchedLead = await AdLead.findOne({ clientId: platformClientId, phoneNumber: { $in: phoneVariants } }).select('_id').lean();
      let tagValue = 'prospect';
      if (matchedUser?.clientId && matchedUser.clientId !== platformClientId) tagValue = 'client';
      else if (matchedLead?._id) tagValue = 'marketing_reply';
      await Conversation.updateOne(
        { _id: row._id, clientId: platformClientId },
        {
          $set: { 'metadata.platformThreadTag': tagValue, 'metadata.linkedClientId': matchedUser?.clientId || '' },
          $addToSet: { tags: tagValue },
        }
      );
      row.tags = Array.from(new Set([...(row.tags || []), tagValue]));
      row.metadata = {
        ...(row.metadata || {}),
        platformThreadTag: tagValue,
        linkedClientId: matchedUser?.clientId || '',
      };
    }
    return res.json({ success: true, rows });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/company-inbox/:conversationId/messages', protect, async (req, res) => {
  try {
    if (!canManageCompanyInbox(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const platformClientId = getPlatformClientId();
    const convo = await Conversation.findOne({ _id: req.params.conversationId, clientId: platformClientId }).lean();
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });
    const rows = await Message.find({ conversationId: convo._id, clientId: platformClientId }).sort({ timestamp: 1 }).lean();
    return res.json({ success: true, rows, conversation: convo });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/company-inbox/:conversationId/reply', protect, async (req, res) => {
  try {
    if (!canManageCompanyInbox(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    const platformClientId = getPlatformClientId();
    const convo = await Conversation.findOne({ _id: req.params.conversationId, clientId: platformClientId });
    if (!convo) return res.status(404).json({ success: false, message: 'Conversation not found' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'text required' });
    const clientDoc = await Client.findOne({ clientId: platformClientId });
    if (!clientDoc) return res.status(404).json({ success: false, message: 'Platform client not found' });
    await WhatsApp.sendText(clientDoc, convo.phone, text);
    await Message.create({
      clientId: platformClientId,
      conversationId: convo._id,
      from: String(clientDoc.phoneNumberId || 'platform'),
      to: String(convo.phone || ''),
      content: text,
      type: 'text',
      direction: 'outgoing',
      channel: 'whatsapp',
      timestamp: new Date(),
    });
    convo.lastMessage = text;
    convo.lastMessageAt = new Date();
    await convo.save();
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/dfy/board', protect, authorizeAdminScope('viewClients'), async (req, res) => {
  try {
    const filter = applyClientScopeFilter({ isPlatformInternal: { $ne: true } }, req);
    const rows = await Client.find(filter)
      .select('clientId businessName name onboardingData dfyManagerId dfyKickoffAt dfyGoLiveAt phoneNumberId shopifyAccessToken')
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();
    const data = rows.map((c) => ({
      ...c,
      checklist: {
        whatsappConnected: Boolean(c.phoneNumberId),
        shopifyConnected: Boolean(c.shopifyAccessToken),
        kickoffDone: Boolean(c.dfyKickoffAt),
        goLiveDone: Boolean(c.dfyGoLiveAt),
      },
    }));
    return res.json({ success: true, rows: data });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/dfy/:clientId', protect, authorizeAdminScope('editClients'), async (req, res) => {
  try {
    const clientId = String(req.params.clientId || '');
    if (!denyUnlessAdminClientAccess(req, res, clientId)) return;
    const patch = {};
    if (req.body?.dfyManagerId !== undefined) patch.dfyManagerId = req.body.dfyManagerId || null;
    if (req.body?.dfyKickoffAt !== undefined) patch.dfyKickoffAt = req.body.dfyKickoffAt ? new Date(req.body.dfyKickoffAt) : null;
    if (req.body?.dfyGoLiveAt !== undefined) patch.dfyGoLiveAt = req.body.dfyGoLiveAt ? new Date(req.body.dfyGoLiveAt) : null;
    await Client.updateOne({ clientId }, { $set: patch });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/** GET /api/admin/dlq/:clientId — cart recovery dead-letter queue (Phase 7 B6.5) */
router.get('/dlq/:clientId', protect, authorizeAdminScope('viewDeadLetters'), async (req, res) => {
  try {
    if (!denyUnlessAdminClientAccess(req, res, req.params.clientId)) return;
    const { listCartRecoveryDlq } = require('../utils/commerce/cartRecoveryDlq');
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const items = await listCartRecoveryDlq(req.params.clientId, limit);
    res.json({ success: true, clientId: req.params.clientId, count: items.length, items });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/** POST /api/admin/dlq/:clientId/replay/:entryId */
router.post('/dlq/:clientId/replay/:entryId', protect, authorizeAdminScope('retryDeadLetters'), async (req, res) => {
  try {
    if (!denyUnlessAdminClientAccess(req, res, req.params.clientId)) return;
    const { replayCartRecoveryDlqEntry } = require('../utils/commerce/cartRecoveryDlq');
    const out = await replayCartRecoveryDlqEntry(req.params.clientId, req.params.entryId);
    if (!out.ok) return res.status(400).json({ success: false, ...out });
    res.json({ success: true, ...out });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
