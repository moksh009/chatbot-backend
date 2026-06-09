/**
 * Conversations API (dashboard human-requests panel):
 * - GET / — Conversation.find + countDocuments + AdLead bulk enrichment
 */
const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/core/queryHelpers');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { apiCache } = require('../middleware/apiCache');
const { getCachedClient } = require('../utils/core/clientCache');
const WhatsApp = require('../utils/meta/whatsapp');
const { createMessage } = require('../utils/core/createMessage');
const ExportJob = require('../models/ExportJob');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { uploadToCloud } = require('../utils/core/cloudinary');
const { normalizePhone } = require('../utils/core/helpers');

/** IDOR guard — always scope conversation by tenant unless super-admin. */
function conversationQueryForTenant(req, conversationId) {
  const query = { _id: conversationId };
  if (req.user?.role !== 'SUPER_ADMIN') {
    query.clientId = req.user.clientId;
  }
  return query;
}
const { injectVariables } = require('../utils/core/variableInjector');
const { generateCheckoutForOrder, publicApiBase } = require('../utils/commerce/commerceCheckoutService');
const CheckoutLinkModel = require('../models/CheckoutLink');
const AdLeadModel = require('../models/AdLead');
const { correctAIResponse } = require('../controllers/flowFixController');
const Notification = require('../models/Notification');
const { logAction } = require('../middleware/audit');

const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

/** Same access scope as GET /api/conversations/:id (avoids sidebar/full-context 404s). */
function conversationAccessQuery(conversationId, user, tenantClientIdOverride = null) {
  const query = { _id: conversationId };
  const scopedClientId =
    tenantClientIdOverride ||
    (user?.role !== 'SUPER_ADMIN' ? user?.clientId : null);
  if (scopedClientId) {
    query.clientId = scopedClientId;
  }
  return query;
}

router.post('/correct-ai', protect, correctAIResponse);

const upload = multer({ storage: multer.memoryStorage() });

/** Last 10 digits — matches conversation.phone to AdLead.phoneNumber across formats. */
function phoneSuffixKey(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return '';
  return clean.length >= 10 ? clean.slice(-10) : clean;
}

/** All likely stored variants for bulk AdLead lookup (avoids N× findOne). */
function collectPhoneVariantsForInbox(phones) {
  const variants = new Set();
  for (const raw of phones) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (s) variants.add(s);
    const clean = s.replace(/\D/g, '');
    if (clean) {
      variants.add(clean);
      const suffix = clean.length >= 10 ? clean.slice(-10) : clean;
      if (suffix) variants.add(suffix);
      if (clean.length >= 12 && clean.startsWith('91')) variants.add(clean.slice(2));
    }
  }
  variants.delete('');
  return [...variants];
}

/**
 * Shared conversation list loader (GET /api/conversations + dashboard summary).
 */
async function getConversationsList(user, queryParams = {}, options = {}) {
  const { createTimer, timeParallel } = require('../utils/core/perfLogger');
  const timer =
    options.timer ||
    createTimer('getConversationsList', queryParams.clientId || user?.clientId || '');

  const {
    days,
    clientId,
    phone,
    search,
    isImported,
    importBatchId: importBatchIdRaw,
    page: pageRaw,
    limit: limitRaw,
  } = queryParams;
  let query = {};
  if (phone) {
    query.phone = phone;
  } else if (search && String(search).trim()) {
    const term = String(search).trim();
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 4) {
      query.phone = { $regex: digits };
    } else if (term.length >= 2) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      query.$or = [
        { customerName: regex },
        { lastMessage: regex },
        { phone: regex },
      ];
    }
  }

  const qClient = clientId && String(clientId).trim() ? String(clientId).trim() : null;
  const activeClientId = user.role === 'SUPER_ADMIN' ? qClient : user.clientId || null;
  const scopeToTenant = user.role !== 'SUPER_ADMIN' || !!qClient;

  if (scopeToTenant) {
    if (!activeClientId) {
      const err = new Error('Unauthorized');
      err.statusCode = 403;
      throw err;
    }
    query.clientId = activeClientId;
  }

  if (days) {
    const date = new Date();
    date.setDate(date.getDate() - parseInt(days, 10));
    query.lastMessageAt = { $gte: date };
  }
  timer.checkpoint('query_built');

  const importBatchId =
    importBatchIdRaw && String(importBatchIdRaw).trim() ? String(importBatchIdRaw).trim() : null;

  if (isImported === 'true' || importBatchId) {
    if (!activeClientId) {
      const err = new Error('clientId is required when filtering imported leads');
      err.statusCode = 400;
      throw err;
    }
    const AdLead = require('../models/AdLead');
    const leadQuery = { clientId: activeClientId, source: 'imported' };
    if (importBatchId) {
      const mongoose = require('mongoose');
      if (mongoose.Types.ObjectId.isValid(importBatchId)) {
        leadQuery.importBatchId = importBatchId;
      } else {
        query.phone = '___UNMATCHABLE___';
        timer.checkpoint('imported_filter_invalid_batch', { importBatchId });
      }
    }
    if (query.phone !== '___UNMATCHABLE___') {
      const importedLeads = await timer.time('AdLead.imported_phones', () =>
        AdLead.find(leadQuery).select('phoneNumber').lean()
      );
      const importedPhones = importedLeads.map((l) => l.phoneNumber);
      const phoneFilter = query.phone;
      const orFilter = query.$or;
      delete query.phone;
      delete query.$or;

      let phoneConstraint;
      if (!importedPhones.length) {
        phoneConstraint = '___UNMATCHABLE___';
      } else if (phoneFilter && typeof phoneFilter === 'string') {
        phoneConstraint = importedPhones.includes(phoneFilter) ? phoneFilter : '___UNMATCHABLE___';
      } else if (phoneFilter && typeof phoneFilter === 'object' && phoneFilter.$regex) {
        const matched = importedPhones.filter((p) => phoneFilter.$regex.test(String(p)));
        phoneConstraint = matched.length ? { $in: matched } : '___UNMATCHABLE___';
      } else {
        phoneConstraint = { $in: importedPhones };
      }

      if (phoneConstraint === '___UNMATCHABLE___') {
        query.phone = '___UNMATCHABLE___';
      } else if (orFilter) {
        query.$and = [{ $or: orFilter }, { phone: phoneConstraint }];
      } else {
        query.phone = phoneConstraint;
      }

      timer.checkpoint('imported_filter_applied', {
        phones: importedPhones.length,
        importBatchId: importBatchId || 'all',
      });
    }
  }

  const page = parseInt(pageRaw, 10) || 1;
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 50);
  const skip = (page - 1) * limit;
  const includeTotal = queryParams.includeTotal === '1' || queryParams.includeTotal === 'true';

  const conversations = await timer.time('conversations_find', () => {
    const q = Conversation.find(query)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        '_id phone customerName lastMessage lastMessageAt channel status unreadCount assignedTo isBotPaused botPaused requiresAttention attentionReason lastDetectedIntent summary clientId'
      )
      .lean();
    if (query.clientId) {
      q.hint({ clientId: 1, lastMessageAt: -1 });
    }
    return q;
  });

  let total = null;
  if (includeTotal) {
    total = await timer.time('conversations_count', () => Conversation.countDocuments(query));
  } else if (conversations.length < limit) {
    total = skip + conversations.length;
  }

  const User = require('../models/User');
  const agentIds = [
    ...new Set(
      conversations.map((c) => c.assignedTo).filter(Boolean).map((id) => String(id))
    ),
  ];
  const agents =
    agentIds.length > 0
      ? await timer.time('User.assignees_bulk', () =>
          User.find({ _id: { $in: agentIds } })
            .select('name')
            .lean()
        )
      : [];
  const agentMap = new Map(agents.map((a) => [String(a._id), a]));

  const AdLead = require('../models/AdLead');
  const phones = conversations.map((c) => c.phone).filter(Boolean);
  const enrichClientId = activeClientId || conversations[0]?.clientId;
  const lookupVariants =
    phones.length > 0 && enrichClientId ? collectPhoneVariantsForInbox(phones) : [];
  const leads =
    lookupVariants.length > 0 && enrichClientId
      ? await timer.time('AdLead.bulk_enrichment', () =>
          AdLead.find({
            clientId: enrichClientId,
            phoneNumber: { $in: lookupVariants },
          })
            .select(
              'phoneNumber leadScore scoreLabel cartStatus checkoutInitiatedCount addToCartCount isOrderPlaced tags'
            )
            .lean()
        )
      : [];
  timer.checkpoint('lead_fetch_done', { leads: leads.length });

  const leadBySuffix = new Map();
  for (const l of leads) {
    const key = phoneSuffixKey(l.phoneNumber);
    if (key && !leadBySuffix.has(key)) leadBySuffix.set(key, l);
  }

  const enrichedConversations = conversations.map((conv) => {
    const assignee = conv.assignedTo ? agentMap.get(String(conv.assignedTo)) : null;
    const base = {
      ...conv,
      assignedTo: assignee ? { _id: assignee._id, name: assignee.name } : conv.assignedTo,
    };
    const lead = conv.phone ? leadBySuffix.get(phoneSuffixKey(conv.phone)) : null;
    if (lead) {
      return {
        ...base,
        leadScore: lead.leadScore,
        scoreLabel: lead.scoreLabel,
        leadTags: lead.tags,
      };
    }
    return base;
  });
  timer.checkpoint('enrichment_map_done', { rows: enrichedConversations.length });

  return {
    success: true,
    data: enrichedConversations,
    pagination: {
      total,
      page,
      pages: total != null ? Math.ceil(total / limit) : null,
      hasMore: conversations.length === limit,
    },
  };
}

// @route   GET /api/conversations
// @desc    Get all conversations for the client
// @access  Private
router.get('/', protect, logPersonalDataAccess, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer(
    'GET /api/conversations',
    req.query.clientId || req.user?.clientId || ''
  );
  timer.checkpoint('START');

  const warmClientId = req.query.clientId || req.user?.clientId;
  if (warmClientId) {
    const { getCachedClientForWhatsAppSend } = require('../utils/core/clientCache');
    getCachedClientForWhatsAppSend(warmClientId).catch(() => {});
  }

  try {
    const { dedupeAsync } = require('../utils/core/requestDedupe');
    const dedupeKey = [
      'conv-list',
      req.query.clientId || req.user?.clientId || '',
      req.query.page || '1',
      req.query.limit || '50',
      req.query.days || '',
      req.query.phone || '',
      req.query.search || '',
      req.query.isImported || '',
      req.query.includeTotal || '',
    ].join(':');
    const payload = await dedupeAsync(dedupeKey, () =>
      getConversationsList(req.user, req.query, { timer })
    );
    res.json(payload);
    timer.finish(
      `200 ok | page=${payload.pagination.page} limit=100 total=${payload.pagination.total}`
    );
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    if (error.statusCode === 403) {
      return res.status(403).json({ success: false, message: error.message });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   POST /api/conversations/:id/email
// @desc    Send a manual email to the customer
// @access  Private
const { sendEmailMessage } = require('../utils/core/emailIntegration');
router.post('/:id/email', protect, async (req, res) => {
  try {
    const { subject, text, html } = req.body;
    const conversation = await Conversation.findOne(conversationQueryForTenant(req, req.params.id));
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    if (req.user.role !== 'SUPER_ADMIN' && conversation.clientId !== req.user.clientId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId: conversation.clientId || req.user.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const toEmail = conversation.email || conversation.phone; // Fallback if email not set but phone is an email address
    if (!toEmail || !toEmail.includes('@')) {
      return res.status(400).json({ message: 'Customer does not have a valid email address associated with this conversation.' });
    }

    const result = await sendEmailMessage(client, toEmail, subject, text, html);
    
    // Update conversation last message
    conversation.lastMessage = subject ? `Email: ${subject}` : text.substring(0, 50);
    conversation.lastMessageAt = new Date();
    conversation.unreadCount = 0;
    await conversation.save();

    res.json({ success: true, message: result });
  } catch (error) {
    console.error('[Conversations] Email send error:', error);
    res.status(500).json({ message: error.message || 'Failed to send email' });
  }
});

// @route   GET /api/conversations/:id
// @desc    Get single conversation details
// @access  Private
router.get('/:id', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query).populate('assignedTo', 'name');

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   GET /api/conversations/:id/messages
// @desc    Get messages for a conversation
// @access  Private
router.get('/:id/messages', protect, logPersonalDataAccess, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/conversations/:id/messages', req.user?.clientId || '');
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await timer.time('Conversation.findOne', () =>
      Conversation.findOne(query).select('_id phone customerName botStatus clientId').lean()
    );

    if (!conversation) {
      timer.finish('404');
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before; // ISO timestamp
    const queryPayload = { conversationId: conversation._id };
    
    if (before) {
      queryPayload.timestamp = { $lt: new Date(before) };
    }

    const messages = await timer.time('Message.find', () =>
      Message.find(queryPayload)
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean()
    );

    const chronological = messages.reverse();
    const oldestWithTs = chronological.find((m) => m.timestamp);
    res.json({
      messages: chronological,
      nextCursor:
        chronological.length === limit && oldestWithTs?.timestamp
          ? new Date(oldestWithTs.timestamp).toISOString()
          : null,
      hasMore: messages.length === limit,
      meta: {
        customerPhone: conversation.phone,
        customerName: conversation.customerName,
        botStatus: conversation.botStatus || 'active'
      }
    });
    timer.finish(`200 ok | count=${chronological.length}`);
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   DELETE /api/conversations/:id/messages
// @desc    Clear chat messages by scope (conversation record kept)
// @access  Private
router.delete('/:id/messages', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const clearScope = String(
      req.body?.clearScope || req.query?.clearScope || ''
    ).trim();

    const { clearConversationMessages } = require('../utils/core/clearConversationMessages');
    const result = await clearConversationMessages({
      conversationId: req.params.id,
      clientId,
      clearScope,
      allowAnyClient: req.user.role === 'SUPER_ADMIN',
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[DELETE /conversations/:id/messages]', error);
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to clear messages',
    });
  }
});

/**
 * Conversation.phone is often "9193…" while AdLead.phoneNumber may be "93…" or 10-digit local.
 * Try several normalizations so LTV/score/tags resolve reliably.
 */
async function findLeadForConversationPhone(tenantId, phone, selectFields) {
  const AdLead = require('../models/AdLead');
  const clean = String(phone || '').replace(/\D/g, '');
  const suffix = clean.length >= 10 ? clean.slice(-10) : clean;
  const select =
    selectFields ||
    'name email leadScore scoreLabel cartStatus tags intentState source totalSpent lifetimeValue ordersCount lastInteraction isOrderPlaced cartSnapshot addToCartCount checkoutInitiatedCount importBatchId meta warrantyRecords';
  const base = { clientId: tenantId };

  const tryOne = async (pn) => {
    if (!pn) return null;
    return AdLead.findOne({ ...base, phoneNumber: pn }).select(select).maxTimeMS(8000).lean();
  };

  let l = await tryOne(phone);
  if (!l && clean && clean !== String(phone)) l = await tryOne(clean);
  if (!l && suffix) l = await tryOne(suffix);
  if (!l && clean.length >= 12 && clean.startsWith('91')) l = await tryOne(clean.slice(2));
  return l;
}

/** Fast path: messages + lead only (Live Chat first paint). */
async function loadConversationLiteContext({ id, user, timer, tenantId: scopedClientId }) {
  const conversation = await timer.time('Conversation.findOne', () =>
    Conversation.findOne(conversationAccessQuery(id, user, scopedClientId))
      .select(
        'phone customerName status botPaused botStatus unreadCount channel assignedTo summary lastDetectedIntent requiresAttention attentionReason clientId escalationRequestedAt ' +
          'pendingCart lastBrowsedCollectionId lastBrowsedCollectionAt lastCheckoutUrl lastCheckoutShortCode lastCheckoutValue lastCheckoutAt checkoutLinkClicked'
      )
      .lean()
  );

  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const phone = conversation.phone;
  const tenantId = conversation.clientId || scopedClientId || user.clientId;
  const {
    resolveScoreStageNameForClient,
    calculateCustomerLTV,
  } = require('../utils/commerce/customerOrderMetrics');

  const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
  const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

  const parallel = await timer.time('lite_context_parallel', () =>
    Promise.all([
      Message.find({ conversationId: id })
        .sort({ timestamp: -1 })
        .limit(50)
        .select(
          'content type direction status timestamp mediaUrl metadata from to voiceTranscript originalText'
        )
        .lean()
        .then((msgs) => ({
          messages: msgs.reverse(),
          nextCursor: msgs.length === 50 ? msgs[0].timestamp.toISOString() : null,
          hasMore: msgs.length === 50,
        })),
      (async () => {
        let l = await findLeadForConversationPhone(tenantId, phone);
        if (l?.importBatchId) {
          const ImportSession = require('../models/ImportSession');
          const batch = await ImportSession.findById(l.importBatchId).select('batchName').lean();
          if (batch) l.importSource = batch.batchName;
        } else if (l && !l.importSource && l.meta?.importListName) {
          l.importSource = l.meta.importListName;
        }
        return l;
      })(),
      (async () => {
        if (!phone) return [];
        const Order = require('../models/Order');
        const select =
          'orderId orderNumber customerName amount totalPrice status paymentMethod isCOD createdAt items fulfillmentStatus financialStatus trackingNumber trackingUrl phone customerPhone';
        const sort = { createdAt: -1 };
        const exact = await Order.find({
          clientId: tenantId,
          $or: [{ phone }, { customerPhone: phone }],
        })
          .sort(sort)
          .limit(5)
          .select(select)
          .lean();
        if (exact.length > 0) return exact;
        if (!phoneSuffix) return [];
        return Order.find({
          clientId: tenantId,
          $or: [
            { phone: { $regex: `${phoneSuffix}$` } },
            { customerPhone: { $regex: `${phoneSuffix}$` } },
          ],
        })
          .sort(sort)
          .limit(5)
          .select(select)
          .lean()
          .catch(() => []);
      })(),
    ])
  );

  const messages = parallel[0];
  const lead = parallel[1];
  const orders = parallel[2];
  const leadScore = lead?.leadScore ?? 0;
  let ltv = Number(lead?.lifetimeValue ?? lead?.totalSpent ?? 0) || 0;
  if (phone) {
    const fromOrders =
      (await timer.time('calculateCustomerLTV', () => calculateCustomerLTV(tenantId, phone))) || 0;
    ltv = Math.max(ltv, fromOrders);
  }
  const stageName = await timer.time('resolveScoreStageName', () =>
    resolveScoreStageNameForClient(tenantId, leadScore)
  );

  if (lead) {
    lead.ltv = ltv;
    lead.stageName = stageName;
  }

  return {
    conversation,
    messages: messages.messages,
    nextCursor: messages.nextCursor,
    hasMore: messages.hasMore,
    lead,
    leadScore,
    stageName,
    ltv,
    orders,
  };
}

/** Sidebar payload — orders, notes, sequences (deferred after lite paint). */
async function loadConversationSidebarContext({ id, user, timer }) {
  const conversation = await Conversation.findOne(conversationAccessQuery(id, user))
    .select('phone clientId')
    .lean();
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const phone = conversation.phone;
  const tenantId = conversation.clientId || user.clientId;
  const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
  const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

  const parallel = await timer.time('sidebar_context_parallel', () =>
    Promise.all([
      (async () => {
        if (!phone) return [];
        const Order = require('../models/Order');
        const select =
          'orderId orderNumber customerName amount totalPrice status paymentMethod isCOD createdAt items fulfillmentStatus financialStatus trackingNumber trackingUrl';
        const sort = { createdAt: -1 };
        const exact = await Order.find({
          clientId: tenantId,
          $or: [{ phone }, { customerPhone: phone }],
        })
          .sort(sort)
          .limit(5)
          .select(select)
          .lean();
        if (exact.length > 0) return exact;
        if (!phoneSuffix) return [];
        return Order.find({
          clientId: tenantId,
          $or: [
            { phone: { $regex: `${phoneSuffix}$` } },
            { customerPhone: { $regex: `${phoneSuffix}$` } },
          ],
        })
          .sort(sort)
          .limit(5)
          .select(select)
          .lean()
          .catch(() => []);
      })(),
      (async () => {
        if (!phoneSuffix) return null;
        try {
          const FollowUpSequence = require('../models/FollowUpSequence');
          return FollowUpSequence.findOne({
            clientId: tenantId,
            phone,
            status: { $in: ['active', 'pending', 'ACTIVE', 'PENDING'] },
          })
            .select('name status steps')
            .lean();
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const ConversationNote = require('../models/ConversationNote');
          const rows = await ConversationNote.find({ conversationId: id })
            .sort({ createdAt: -1 })
            .limit(40)
            .lean();
          return rows.reverse();
        } catch {
          return [];
        }
      })(),
      (async () => {
        try {
          const pn = normalizePhone(phone);
          if (!pn) return null;
          return CheckoutLinkModel.findOne({
            clientId: tenantId,
            converted: false,
            phone: pn,
          })
            .sort({ createdAt: -1 })
            .select('shortCode fullUrl cartRecoverySent createdAt totalValue currency')
            .lean();
        } catch {
          return null;
        }
      })(),
    ])
  );

  return {
    orders: parallel[0],
    activeSequence: parallel[1],
    notes: parallel[2],
    latestCheckoutLink: parallel[3],
  };
}

router.get('/:id/sidebar-context', protect, logPersonalDataAccess, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const timer = createTimer('GET /api/conversations/:id/sidebar-context', req.user?.clientId || '');
  const { id } = req.params;
  const dedupeKey = `sidebar-ctx:${req.user?.clientId || ''}:${id}`;

  try {
    const payload = await dedupeAsync(dedupeKey, () =>
      loadConversationSidebarContext({ id, user: req.user, timer })
    );
    res.json(payload);
    timer.finish('200 ok');
  } catch (error) {
    timer.finish(`${error.statusCode || 500} error=${error.message}`);
    const status = error.statusCode || 500;
    res.status(status).json({
      message: status === 404 ? 'Conversation not found' : 'Server Error fetching sidebar context',
    });
  }
});

// ✅ Phase 2: Live Chat Mega-Payload (Full Context)
// Fetches conversation, 50 messages, lead intent, orders, and wallet in 1 round trip
router.get('/:id/full-context', protect, logPersonalDataAccess, async (req, res) => {
  const { createTimer, timeParallel } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const tenantId = tenantClientId(req);
  const timer = createTimer('GET /api/conversations/:id/full-context', tenantId || req.user?.clientId || '');
  const { id } = req.params;
  const dedupeKey = `full-ctx:${tenantId || ''}:${id}`;

  try {
    if (req.query.lite === '1' || req.query.lite === 'true') {
      const litePayload = await dedupeAsync(`lite-ctx:${tenantId || ''}:${id}`, () =>
        loadConversationLiteContext({ id, user: req.user, timer, tenantId })
      );
      res.json(litePayload);
      timer.finish('200 ok lite');
      return;
    }

    const payload = await dedupeAsync(dedupeKey, async () => {
    const scopedClientId = tenantId || req.user.clientId;

    let conversation = await timer.time('Conversation.findOne', () =>
      Conversation.findOne(conversationAccessQuery(id, req.user, scopedClientId))
        .select(
          'phone customerName status botPaused botStatus unreadCount channel assignedTo summary lastDetectedIntent requiresAttention attentionReason clientId escalationRequestedAt ' +
            'pendingCart lastBrowsedCollectionId lastBrowsedCollectionAt lastCheckoutUrl lastCheckoutShortCode lastCheckoutValue lastCheckoutAt checkoutLinkClicked'
        )
        .lean()
    );

    if (!conversation) {
      const err = new Error('Conversation not found');
      err.statusCode = 404;
      throw err;
    }

    const phone = conversation.phone;
    const tenantId = conversation.clientId || scopedClientId;
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

    const {
      calculateCustomerLTV,
      resolveScoreStageNameForClient,
    } = require('../utils/commerce/customerOrderMetrics');

    const parallel = await timeParallel(
      timer,
      {
        messages: () =>
          Message.find({ conversationId: id })
            .sort({ timestamp: -1 })
            .limit(50)
            .select(
              'content type direction status timestamp mediaUrl metadata from to voiceTranscript originalText'
            )
            .lean()
            .then((msgs) => ({
              messages: msgs.reverse(),
              nextCursor: msgs.length === 50 ? msgs[0].timestamp.toISOString() : null,
              hasMore: msgs.length === 50,
            })),
        lead: async () => {
          const l = await findLeadForConversationPhone(tenantId, phone);
          if (l?.importBatchId) {
            const ImportSession = require('../models/ImportSession');
            const batch = await ImportSession.findById(l.importBatchId).select('batchName').lean();
            if (batch) l.importSource = batch.batchName;
          } else if (l && !l.importSource && l.meta?.importListName) {
            l.importSource = l.meta.importListName;
          }
          return l;
        },
        orders: async () => {
          if (!phone) return [];
          const Order = require('../models/Order');
          const select =
            'orderId orderNumber customerName amount totalPrice status paymentMethod isCOD createdAt items fulfillmentStatus financialStatus trackingNumber trackingUrl';
          const sort = { createdAt: -1 };
          const exact = await Order.find({
            clientId: tenantId,
            $or: [{ phone }, { customerPhone: phone }],
          })
            .sort(sort)
            .limit(3)
            .select(select)
            .lean();
          if (exact.length > 0) return exact;
          if (!phoneSuffix) return [];
          return Order.find({
            clientId: tenantId,
            $or: [
              { phone: { $regex: phoneSuffix + '$' } },
              { customerPhone: { $regex: phoneSuffix + '$' } },
            ],
          })
            .sort(sort)
            .limit(3)
            .select(select)
            .lean()
            .catch(() => []);
        },
        activeSequence: async () => {
          if (!phoneSuffix) return null;
          try {
            const FollowUpSequence = require('../models/FollowUpSequence');
            return FollowUpSequence.findOne({
              clientId: tenantId,
              $or: [{ phone: { $regex: phoneSuffix + '$' } }, { phone }],
              status: { $regex: /^(active|pending)$/i },
            })
              .select('name status steps')
              .lean();
          } catch {
            return null;
          }
        },
        notes: async () => {
          try {
            const ConversationNote = require('../models/ConversationNote');
            const rows = await ConversationNote.find({ conversationId: id })
              .sort({ createdAt: -1 })
              .limit(40)
              .lean();
            return rows.reverse();
          } catch {
            return [];
          }
        },
        latestCheckoutLink: async () => {
          try {
            const pn = normalizePhone(phone);
            if (!pn) return null;
            return CheckoutLinkModel.findOne({
              clientId: tenantId,
              converted: false,
              phone: pn,
            })
              .sort({ createdAt: -1 })
              .select('shortCode fullUrl cartRecoverySent createdAt totalValue currency')
              .lean();
          } catch {
            return null;
          }
        },
      },
      'full_context_parallel'
    );

    const messages = parallel.messages;
    const lead = parallel.lead;
    const orders = parallel.orders;
    const activeSequence = parallel.activeSequence;
    const notes = parallel.notes;
    const latestCheckoutLink = parallel.latestCheckoutLink;

    const leadScore = lead?.leadScore ?? 0;
    let ltv = Number(lead?.lifetimeValue ?? lead?.totalSpent ?? 0) || 0;
    if (phone) {
      const fromOrders = await timer.time('calculateCustomerLTV', () =>
        calculateCustomerLTV(tenantId, phone)
      );
      ltv = Math.max(ltv, Number(fromOrders) || 0);
    }
    const stageName = await timer.time('resolveScoreStageName', () =>
      resolveScoreStageNameForClient(tenantId, leadScore)
    );

    // Attach notes for UI backwards compatibility
    if (conversation) {
      conversation.internalNotes = notes || [];
    }

    if (lead) {
      lead.ltv = ltv;
      lead.stageName = stageName;
    }
    
    return {
      conversation,
      messages: messages.messages,
      nextCursor: messages.nextCursor,
      hasMore: messages.hasMore,
      lead,
      leadScore,
      stageName,
      ltv,
      orders,
      activeSequence,
      latestCheckoutLink,
    };
    });

    res.json(payload);
    timer.finish('200 ok');
  } catch (error) {
    console.error('[FullContext Error]:', error);
    timer.finish(`${error.statusCode || 500} error=${error.message}`);
    const status = error.statusCode || 500;
    res.status(status).json({
      message: status === 404 ? 'Conversation not found' : 'Server Error fetching full context',
    });
  }
});

/** Full order document for Live Chat sidebar expand (line items + fulfillment). */
router.get('/:id/orders/:orderKey', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const tenantId = tenantClientId(req);
    const { id, orderKey } = req.params;
    if (!tenantId) return res.status(403).json({ message: 'Unauthorized' });

    const conversation = await Conversation.findOne(
      req.user.role === 'SUPER_ADMIN' ? { _id: id } : { _id: id, clientId: tenantId }
    ).lean();
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const mongoose = require('mongoose');
    const Order = require('../models/Order');
    const key = decodeURIComponent(String(orderKey || '').trim());
    const orConditions = [{ orderId: key }, { orderNumber: key }];
    if (mongoose.Types.ObjectId.isValid(key)) {
      orConditions.push({ _id: key });
    }

    const order = await Order.findOne({
      clientId: tenantId,
      $or: orConditions,
    }).lean();

    if (!order) return res.status(404).json({ message: 'Order not found' });

    const phone = normalizePhone(conversation.phone);
    const orderPhone = normalizePhone(order.phone || order.customerPhone || '');
    const phoneSuffix = phone ? phone.slice(-10) : '';
    const orderSuffix = orderPhone ? orderPhone.slice(-10) : '';
    const phoneMatch =
      phone &&
      orderPhone &&
      (phone === orderPhone || (phoneSuffix && orderSuffix && phoneSuffix === orderSuffix));
    if (!phoneMatch) {
      return res.status(403).json({ message: 'Order does not belong to this conversation' });
    }

    let payload = order;
    const refreshShopify = String(req.query.refreshShopify || '') === '1';
    if (refreshShopify && order.shopifyOrderId) {
      try {
        const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');
        const { buildShopifyOrderSet } = require('../utils/shopify/shopifyOrderMapper');
        const fresh = await withShopifyRetry(tenantId, async (shop) => {
          const r = await shop.get(`/orders/${order.shopifyOrderId}.json`);
          return r.data?.order;
        });
        if (fresh) {
          const mapped = buildShopifyOrderSet(tenantId, fresh, { preferLogisticsStatus: true });
          payload = {
            ...order,
            fulfillmentStatus: mapped.fulfillmentStatus || order.fulfillmentStatus,
            financialStatus: mapped.financialStatus || order.financialStatus,
            status: mapped.status || order.status,
            trackingNumber: mapped.trackingNumber || order.trackingNumber,
            trackingUrl: mapped.trackingUrl || order.trackingUrl,
            items: Array.isArray(mapped.items) && mapped.items.length ? mapped.items : order.items,
            totalPrice: mapped.totalPrice ?? order.totalPrice,
          };
        }
      } catch (shopErr) {
        console.warn('[GET conversation order] Shopify refresh skipped:', shopErr.message);
      }
    }

    return res.json({ success: true, order: payload });
  } catch (err) {
    console.error('[GET conversation order]', err);
    return res.status(500).json({ message: 'Failed to load order details' });
  }
});

// Agent: resend WhatsApp checkout (permalink / short link or regenerate from pendingCart)
router.post('/:id/resend-checkout', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { regenerate } = req.body || {};
    const query = { _id: id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await getCachedClient(conversation.clientId);
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const normalizedPhone = normalizePhone(conversation.phone);
    if (!normalizedPhone) return res.status(400).json({ message: 'Invalid conversation phone' });

    let shortUrl = '';
    let shortCode = '';
    let total = Number(conversation.lastCheckoutValue) || 0;

    if (!regenerate) {
      const link = await CheckoutLinkModel.findOne({
        clientId: conversation.clientId,
        converted: false,
        phone: normalizedPhone
      })
        .sort({ createdAt: -1 })
        .lean();
      if (link) {
        const base = publicApiBase();
        shortUrl = base ? `${base}/api/r/${link.shortCode}` : link.fullUrl;
        shortCode = link.shortCode;
        if (!total && Number(link.totalValue)) total = Number(link.totalValue);
      }
    }

    const rawItems = conversation.pendingCart?.items;
    const pendingItems = (Array.isArray(rawItems) ? rawItems : [])
      .map((i) => ({
        product_retailer_id: String(i.product_retailer_id ?? i.variantId ?? i.id ?? '').trim(),
        quantity: Math.max(1, Number(i.quantity || 1) || 1),
        item_price: Number(i.item_price ?? i.price ?? 0) || 0,
        currency: i.currency || 'INR'
      }))
      .filter((i) => i.product_retailer_id);

    if (!shortUrl && pendingItems.length) {
      const bundle = await generateCheckoutForOrder(client, normalizedPhone, pendingItems);
      shortUrl = bundle.shortUrl || '';
      shortCode = bundle.shortCode || '';
      if (!total && Number(bundle.totalValue)) total = Number(bundle.totalValue);
    }

    if (!shortUrl) {
      return res.status(400).json({
        success: false,
        message: 'No active checkout link or saved cart. The customer can shop from the catalog again.'
      });
    }

    const currency = pendingItems[0]?.currency || rawItems?.[0]?.currency || 'INR';
    const lead = await AdLeadModel.findOne({
      clientId: conversation.clientId,
      phoneNumber: normalizedPhone
    })
      .select('name')
      .lean();

    const tpl =
      client.commerceBotSettings?.checkoutMessage ||
      'Complete your checkout 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}';
    const text = injectVariables(String(tpl), {
      checkout_url: shortUrl,
      cart_total: String(total),
      currency,
      item_count: String(pendingItems.length || conversation.pendingCart?.items?.length || 0),
      first_name: (lead?.name || 'there').split(/\s+/)[0]
    });

    await WhatsApp.sendText(client, normalizedPhone, text);
    await createMessage({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      phone: normalizedPhone,
      direction: 'outgoing',
      type: 'text',
      body: text,
      metadata: { agent_resend_checkout: true, shortCode }
    });

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          lastCheckoutUrl: shortUrl,
          lastCheckoutShortCode: shortCode,
          lastCheckoutAt: new Date(),
          lastCheckoutValue: total
        }
      }
    );

    res.json({ success: true, shortUrl });
  } catch (error) {
    console.error('[resend-checkout]', error);
    res.status(500).json({ message: error.message || 'Failed to resend checkout' });
  }
});

// @route   POST /api/conversations/:id/messages
// @desc    Send a message (Agent reply)
// @access  Private
router.post('/:id/messages', protect, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('POST /api/conversations/:id/messages', req.user?.clientId || '');
  const { content, mediaUrl, mediaType } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await timer.time('Conversation.findOne', () =>
      Conversation.findOne(query)
        .select(
          'clientId phone detectedLanguage botPaused status firstResponseAt firstInboundAt requiresAttention attentionReason'
        )
        .lean()
    );

    if (!conversation) {
      timer.finish('404');
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const { getCachedClientForWhatsAppSend } = require('../utils/core/clientCache');
    const client = await timer.time('getCachedClientForWhatsAppSend', () =>
      getCachedClientForWhatsAppSend(conversation.clientId)
    );
    if (!client) {
      timer.finish('404 client');
      return res.status(404).json({ message: 'Client not found' });
    }

    const { translateText } = require('../utils/core/translationEngine');
    let finalContent = content;
    let translatedContent = '';
    const translationConfig = client.translationConfig || {};

    if (
      translationConfig.enabled &&
      conversation.detectedLanguage &&
      conversation.detectedLanguage !== 'en' &&
      conversation.detectedLanguage !== (translationConfig.agentLanguage || 'en')
    ) {
      translatedContent = await timer.time('translateText', () =>
        translateText(
          content,
          conversation.detectedLanguage,
          client?.geminiApiKey || process.env.GEMINI_API_KEY
        )
      );
      if (translatedContent && translatedContent !== content) {
        finalContent = translatedContent;
      }
    }

    const { dispatchAgentEnvelope } = require('../utils/messaging/botEnvelopeDispatch');
    const agentMessageId = `agent_${req.user._id}_${Date.now()}`;

    let newMessage;
    if (mediaUrl) {
      const type = mediaType?.toLowerCase() || 'image';

      await timer.time('WhatsApp.send_media', async () => {
        let payload;
        if (type === 'image') {
          payload = { media: { type: 'image', url: mediaUrl }, text: finalContent };
        } else {
          payload = { text: `${finalContent}\n\n${type}: ${mediaUrl}` };
        }
        const env = await dispatchAgentEnvelope({
          client,
          phone: conversation.phone,
          payload,
          userId: String(req.user._id),
          conversationId: conversation._id,
          messageId: agentMessageId,
        });
        if (env?.blocked && env.windowClosed) {
          const err = new Error('WhatsApp 24-hour service window closed. Send an approved template instead.');
          err.code = 'window_closed';
          throw err;
        }
        if (env?.handled && !env.sent && !env.duplicate) {
          const err = new Error(env.reason || 'Send blocked by compliance');
          err.code = env.result?.blockedBy || 'blocked';
          throw err;
        }
      });

      newMessage = await timer.time('createMessage', () =>
        createMessage({
          clientId: conversation.clientId,
          conversationId: conversation._id,
          phone: conversation.phone,
          direction: 'outgoing',
          type: type === 'file' ? 'document' : type,
          body: content,
          translatedContent,
          detectedLanguage: conversation.detectedLanguage,
          mediaUrl,
          agentId: req.user._id,
        })
      );
    } else {
      await timer.time('WhatsApp.sendText', async () => {
        const env = await dispatchAgentEnvelope({
          client,
          phone: conversation.phone,
          payload: { text: finalContent },
          userId: String(req.user._id),
          conversationId: conversation._id,
          messageId: agentMessageId,
        });
        if (env?.blocked && env.windowClosed) {
          const err = new Error('WhatsApp 24-hour service window closed. Send an approved template instead.');
          err.code = 'window_closed';
          throw err;
        }
        if (env?.handled && !env.sent && !env.duplicate) {
          const err = new Error(env.reason || 'Send blocked by compliance');
          err.code = env.result?.blockedBy || 'blocked';
          throw err;
        }
      });
      newMessage = await timer.time('createMessage', () =>
        createMessage({
          clientId: conversation.clientId,
          conversationId: conversation._id,
          phone: conversation.phone,
          direction: 'outgoing',
          type: 'text',
          body: content,
          translatedContent,
          detectedLanguage: conversation.detectedLanguage,
          agentId: req.user._id,
        })
      );
    }

    const now = new Date();
    const convPatch = {
      lastMessage: (content || '').substring(0, 100),
      lastMessageAt: now,
      requiresAttention: false,
      attentionReason: '',
    };
    if (!conversation.firstResponseAt && conversation.firstInboundAt) {
      convPatch.firstResponseAt = now;
    }

    await timer.time('Conversation.updateOne', () =>
      Conversation.updateOne({ _id: conversation._id }, { $set: convPatch })
    );

    const AdLead = require('../models/AdLead');
    AdLead.updateOne(
      { phoneNumber: conversation.phone, clientId: conversation.clientId },
      {
        $set: {
          lastMessageContent: (content || '').substring(0, 500),
          lastInteraction: now,
        },
      }
    ).catch(() => {});

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', {
        ...conversation,
        ...convPatch,
        _id: conversation._id,
      });
    }

    res.json(newMessage);
    timer.finish('200 ok');
  } catch (error) {
    const errorData = error.response?.data?.error || error.data || error.message;
    const statusCode = error.status || error.response?.status || 500;

    console.error('Error sending message:', errorData);
    timer.finish(`500 error=${error.message || errorData}`);

    if (error.code === 'window_closed') {
      return res.status(400).json({
        success: false,
        message: error.message,
        code: 'window_closed',
        blockedBy: 'service_window',
      });
    }

    const finalStatus = [401, 403].includes(statusCode) ? 400 : statusCode;
    const friendly =
      error.friendlyMessage ||
      (typeof errorData === 'string' ? errorData : error.message) ||
      'Failed to send message';

    res.status(finalStatus).json({
      success: false,
      message: friendly,
      error: errorData,
    });
  }
});

// @route   PATCH /api/conversations/:id/bot-status
// @desc    Update bot status (active or paused)
// @access  Private
router.patch('/:id/bot-status', protect, async (req, res) => {
  try {
    const { id } = req.params;
    const { clientId, botStatus } = req.body;

    if (!['active', 'paused'].includes(botStatus)) {
      return res.status(400).json({ error: 'botStatus must be "active" or "paused".' });
    }

    const existingConv = await Conversation.findOne({ _id: id, clientId })
      .select('escalationRequestedAt')
      .lean();
    const pausePatch =
      botStatus === 'paused' && !existingConv?.escalationRequestedAt
        ? { escalationRequestedAt: new Date() }
        : {};

    const conversation = await Conversation.findOneAndUpdate(
      { _id: id, clientId },
      {
        $set: {
          botStatus,
          botPaused: botStatus === 'paused',
          isBotPaused: botStatus === 'paused',
          updatedAt: new Date(),
          ...pausePatch,
        },
      },
      { new: true }
    ).select('botStatus phone customerName escalationRequestedAt').lean();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Emit to frontend so all open sessions see the change immediately
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${clientId}`).emit('botStatusChanged', {
        conversationId: id,
        botStatus: conversation.botStatus
      });
    }

    res.json({ botStatus: conversation.botStatus });
  } catch (err) {
    console.error('[PATCH /conversations/:id/bot-status]', err);
    res.status(500).json({ error: 'Failed to update bot status.' });
  }
});

// @route   PUT /api/conversations/:id/takeover
// @desc    Agent takes over conversation (pauses bot)
// @access  Private
router.put('/:id/takeover', protect, async (req, res) => {
  const CONV_TAKEOVER_MAX_MS = parseInt(process.env.CONV_TAKEOVER_MAX_MS || '12000', 10) || 12000;
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }

    const existing = await Conversation.findOne(query)
      .select('clientId')
      .maxTimeMS(5000)
      .lean();
    if (!existing) return res.status(404).json({ message: 'Not found' });

    const client = await Client.findOne({ clientId: existing.clientId })
      .select('plan')
      .lean()
      .maxTimeMS(4000);
    if (client && client.plan === 'CX Agent (V1)') {
      return res.status(403).json({
        message: 'Human Handoff is locked for CX Agent (v1). Please upgrade to v2.',
      });
    }

    const assignedAt = new Date();
    const takeoverExisting = await Conversation.findOne(query)
      .select('escalationRequestedAt')
      .lean();
    const escalationPatch =
      !takeoverExisting?.escalationRequestedAt ? { escalationRequestedAt: assignedAt } : {};

    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $set: {
          status: 'HUMAN_TAKEOVER',
          botPaused: true,
          isBotPaused: true,
          botStatus: 'paused',
          assignedTo: req.user._id,
          assignedAt,
          requiresAttention: false,
          attentionReason: '',
          updatedAt: assignedAt,
          ...escalationPatch,
        },
      },
      { new: true, maxTimeMS: CONV_TAKEOVER_MAX_MS }
    );

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    setImmediate(() => {
      const ConversationAssignment = require('../models/ConversationAssignment');
      ConversationAssignment.create({
        conversationId: conversation._id,
        clientId: conversation.clientId,
        assignedAgentId: req.user._id,
        assignedAt,
      }).catch((err) => console.error('[Analytics] Failed to record takeover assignment:', err.message));
    });

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('bot_status_changed', {
        conversationId: conversation._id,
        status: 'HUMAN_TAKEOVER',
        botPaused: true,
      });
    }

    const AdLead = require('../models/AdLead');
    AdLead.pushJourneyEvent(
      conversation.clientId,
      conversation.phone,
      'human_takeover',
      { agentId: req.user._id, agentName: req.user.name }
    ).catch(() => {});

    res.json(conversation);
  } catch (error) {
    console.error('[PUT /conversations/:id/takeover]', error.message);
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   PUT /api/conversations/:id/release
// @desc    Release conversation back to bot
// @access  Private
router.put('/:id/release', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    conversation.status = 'BOT_ACTIVE';
    conversation.botPaused = false;
    conversation.isBotPaused = false;
    conversation.botStatus = 'active';
    await conversation.save();

    // Phase R4: Emit bot status change to all connected dashboard tabs
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('bot_status_changed', {
        conversationId: conversation._id,
        status: 'BOT_ACTIVE',
        botPaused: false
      });
    }

    const AdLead = require('../models/AdLead');
    AdLead.pushJourneyEvent(conversation.clientId, conversation.phone, 'bot_release', { agentId: req.user._id, agentName: req.user.name }).catch(() => {});

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   PUT /api/conversations/:id/read
// @desc    Mark conversation as read (reset unreadCount)
// @access  Private
router.put('/:id/read', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);

    if (!conversation) return res.status(404).json({ message: 'Not found' });

    conversation.unreadCount = 0;
    await conversation.save();

    // Emit Socket Event to update other connected clients for this tenant
    // Emit Socket Event to update other connected clients for this tenant
    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

// @route   PUT /api/conversations/:id/bot-status
// @desc    Toggle bot status
// @access  Private
router.put('/:id/bot-status', protect, async (req, res) => {
  try {
    const { paused } = req.body;
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $set: {
          botPaused: paused,
          isBotPaused: paused,
          botStatus: paused ? 'paused' : 'active'
        }
      },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('support_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('botStatusChanged', {
        conversationId: String(conversation._id),
        botStatus: conversation.botStatus
      });
    }

    res.json(conversation);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PATCH /api/conversations/:id/assign
// @desc    Assign conversation to an agent (Supports id or phone for new chats)
// @access  Private
router.patch('/:id/assign', protect, async (req, res) => {
  try {
    const { agentId, agentName, phone } = req.body;
    
    let query = {};
    const mongoose = require('mongoose');
    
    // Logic: Try ID first, then fallback to phone + clientId
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      query._id = req.params.id;
    } else if (phone) {
      query.phone = phone;
      if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid conversation reference' });
    }

    const update = agentId
      ? { $set: { assignedTo: agentId, assignedAt: new Date(), assignedBy: agentName || req.user.name } }
      : { $unset: { assignedTo: 1, assignedAt: 1, assignedBy: 1 } };

    let conversation = await Conversation.findOneAndUpdate(query, update, { new: true }).populate('assignedTo', 'name email');
    
    // If conversation doesn't exist but we have a phone, it's a "brand new" chat that hasn't been saved yet.
    // Create it on the fly to support immediate assignment.
    if (!conversation && phone) {
      conversation = await Conversation.create({
        phone,
        clientId: query.clientId || req.user.clientId,
        assignedTo: agentId || undefined,
        assignedAt: agentId ? new Date() : undefined,
        assignedBy: agentId ? (agentName || req.user.name) : undefined,
        status: 'HUMAN_TAKEOVER' // Auto takeover if assigned
      });
      conversation = await Conversation.findById(conversation._id).populate('assignedTo', 'name email');
    }

    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    // Task 1.2: Record assignment for historical analytics
    if (agentId) {
      const ConversationAssignment = require('../models/ConversationAssignment');
      await ConversationAssignment.create({
        conversationId: conversation._id,
        clientId: conversation.clientId,
        assignedAgentId: agentId,
        assignedAt: new Date()
      }).catch(err => console.error('[Analytics] Failed to record manual assignment:', err.message));
    }

    // Save persistent notification in database
    if (agentId) {
      await Notification.create({
        clientId: conversation.clientId,
        title: 'New Assignment',
        message: `${agentName || req.user.name} assigned a conversation to you.`,
        type: 'assignment',
        metadata: { conversationId: conversation._id, phone: conversation.phone }
      });
    }

    const io = req.app.get('socketio');
    if (io) {
      const activeClientId = conversation.clientId;
      // Emit task_assigned for the specific agent to receive real-time toast
      if (agentId) {
        io.to(`agent_${agentId}`).emit('task_assigned', {
          agentId,
          message: 'Admin assigned a new conversation to you.',
          conversationId: conversation._id
        });
      }
      
      // ✅ Module 3.5: Broadcast real-time update to update "purple pill" everywhere
      io.to(`client_${activeClientId}`).emit('conversation_update', conversation);
      io.to(`client_${activeClientId}`).emit('conversation_assigned', { 
        conversationId: conversation._id, 
        agentId, 
        agentName: conversation.assignedTo?.name || null 
      });
    }

    res.json({ success: true, conversation });
  } catch (error) {
    console.error('[Assignment] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/conversations/:id/upload-media
// @desc    Upload media to Cloudinary and return URL
// @access  Private
router.post('/:id/upload-media', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const mediaUrl = await uploadToCloud(req.file.buffer, 'chat_media', 'auto');
    res.json({ success: true, mediaUrl });
  } catch (error) {
    console.error('[UploadMedia] Error:', error);
    res.status(500).json({ message: 'Media upload failed' });
  }
});

// @route   POST /api/conversations/correct-ai
// @desc    Log agent correction for AI training
// @access  Private
// @route   PATCH /api/conversations/:id/labels
// @desc    Update conversation labels
// @access  Private
router.patch('/:id/labels', protect, async (req, res) => {
  try {
    const { labels } = req.body; // array of strings
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOneAndUpdate(query, { $set: { labels } }, { new: true });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   POST /api/conversations/:id/notes
// @desc    Add an internal note to a conversation
// @access  Private
router.post('/:id/notes', protect, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ message: 'Note content is required' });

    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.create({
      conversationId: conversation._id,
      clientId: conversation.clientId,
      content: content.trim(),
      authorId: req.user._id,
      authorName: req.user.name || req.user.email,
      createdAt: new Date()
    });

    const io = req.app.get('socketio');
    if (io) io.to(`client_${conversation.clientId}`).emit('internal_note_added', { conversationId: conversation._id, note });

    res.json({ success: true, note, conversation });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   PATCH /api/conversations/:id/notes/:noteId
// @desc    Update an internal note
// @access  Private
router.patch('/:id/notes/:noteId', protect, async (req, res) => {
  try {
    const { content } = req.body;
    const { id, noteId } = req.params;
    
    if (!content?.trim()) return res.status(400).json({ message: 'Note content is required' });

    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.findOne({ _id: noteId, conversationId: id });
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    
    // Authorization: Only the author or a SUPER_ADMIN can edit
    if (req.user.role !== 'SUPER_ADMIN' && note.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to edit this note' });
    }
    
    note.content = content.trim();
    await note.save();
    
    res.json({ success: true, note });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   DELETE /api/conversations/:id/notes/:noteId
// @desc    Delete an internal note
// @access  Private
router.delete('/:id/notes/:noteId', protect, async (req, res) => {
  try {
    const { id, noteId } = req.params;
    
    const ConversationNote = require('../models/ConversationNote');
    const note = await ConversationNote.findOne({ _id: noteId, conversationId: id });
    
    if (!note) return res.status(404).json({ message: 'Note not found' });
    
    // Authorization: Only the author or a SUPER_ADMIN can delete
    if (req.user.role !== 'SUPER_ADMIN' && note.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this note' });
    }
    
    await ConversationNote.deleteOne({ _id: noteId });
    res.json({ success: true, message: 'Note deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   POST /api/conversations/:id/summarize
// @desc    Summarize conversation using AI
// @access  Private
router.post('/:id/summarize', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: 1 })
      .limit(50);

    if (messages.length === 0) {
      return res.json({ summary: "No messages found to summarize.", sentiment: "neutral" });
    }

    const chatLog = messages.map(m => `${m.from}: ${m.content}`).join('\n');

    const { generateText } = require('../utils/core/gemini');
    const client = await Client.findOne({ clientId: conversation.clientId });

    const prompt = `
      Analyze this WhatsApp conversation and provide:
      1. A one-sentence summary of the user's intent or current status.
      2. Their sentiment (choose: "happy", "interested", "frustrated", "neutral").
      
      Return ONLY raw JSON: {"summary": "...", "sentiment": "..."}
      
      CONVERSATION:
      ${chatLog}
    `;

    const aiResponse = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY);

    try {
      // Clean potential markdown formatting from AI
      const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(jsonStr);
      res.json(result);
    } catch (e) {
      console.error("AI JSON Parse Error:", aiResponse);
      res.json({ summary: aiResponse, sentiment: "neutral" });
    }
  } catch (error) {
    console.error("Summarization Error:", error);
    res.status(500).json({ message: 'AI processing failed', error: error.message });
  }
});

// @route   POST /api/conversations/:id/send-product
// @desc    Send a WhatsApp interactive product card (cta_url) from cached Shopify data
// @access  Private
router.post('/:id/send-product', protect, async (req, res) => {
  const { shopifyProductId, bodyText, skipImage, productSnapshot } = req.body || {};

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query)
      .select('clientId phone')
      .lean();
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    const targetClientId =
      req.user.role === 'SUPER_ADMIN'
        ? req.body.clientId || conversation.clientId
        : conversation.clientId;

    if (!shopifyProductId) {
      return res.status(400).json({ message: 'shopifyProductId is required' });
    }

    const trimmedBody = String(bodyText || '').trim();
    if (!trimmedBody) {
      return res.status(400).json({ message: 'Message body is required' });
    }

    const { resolveCachedShopifyProduct, resolveProductSnapshot } = require('../utils/commerce/resolveCachedShopifyProduct');
    let product = await resolveCachedShopifyProduct(targetClientId, shopifyProductId);
    if (!product && productSnapshot) {
      product = resolveProductSnapshot(productSnapshot, shopifyProductId);
    }
    if (!product) {
      return res.status(404).json({ message: 'Product not found in your synced catalog' });
    }

    if (!product.title) {
      return res.status(400).json({ message: 'Product is missing a title and cannot be sent' });
    }

    if (!product.productUrl) {
      return res.status(400).json({
        message: 'Product storefront URL is missing. Re-sync Shopify products and try again.',
      });
    }

    const imageUrl = String(product.imageUrl || '').trim();
    const omitImage = skipImage === true || skipImage === 'true';
    if (!imageUrl && !omitImage) {
      return res.status(400).json({
        code: 'missing_image',
        message: 'Product image URL is unavailable',
      });
    }

    const { getCachedClientForWhatsAppSend } = require('../utils/core/clientCache');
    const client = await getCachedClientForWhatsAppSend(conversation.clientId);
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const interactive = {
      type: 'cta_url',
      action: {
        name: 'cta_url',
        parameters: {
          display_text: 'View Product',
          url: product.productUrl,
        },
      },
    };

    if (imageUrl && !omitImage) {
      interactive.header = { type: 'image', image: { link: imageUrl } };
    }

    const { dispatchAgentEnvelope } = require('../utils/messaging/botEnvelopeDispatch');
    const agentMessageId = `agent_product_${req.user._id}_${Date.now()}`;

    let env;
    try {
      env = await dispatchAgentEnvelope({
        client,
        phone: conversation.phone,
        payload: { interactive, text: trimmedBody.substring(0, 1024) },
        userId: String(req.user._id),
        conversationId: conversation._id,
        messageId: agentMessageId,
      });
    } catch (sendErr) {
      console.error('[send-product] WhatsApp dispatch error:', sendErr?.response?.data || sendErr.message);
      return res.status(502).json({
        message: 'Could not send product — check your WhatsApp connection and try again.',
      });
    }

    if (env?.blocked && env.windowClosed) {
      return res.status(400).json({
        success: false,
        code: 'window_closed',
        message:
          'This customer is outside the 24-hour WhatsApp service window. Send an approved Meta template to reach them.',
        blockedBy: 'service_window',
      });
    }

    if (env?.handled && !env.sent && !env.duplicate) {
      const reason = String(env.reason || env.result?.reason || '').trim();
      const isWaConfig =
        reason === 'whatsapp_not_configured' ||
        env.result?.blockedBy === 'whatsapp_credentials' ||
        /Missing credentials/i.test(reason);
      return res.status(400).json({
        success: false,
        code: isWaConfig ? 'whatsapp_not_configured' : 'send_blocked',
        message: isWaConfig
          ? 'WhatsApp is not fully connected for this workspace. Open Settings → Connections and complete Meta embedded signup or paste your Cloud API credentials.'
          : reason || 'Could not send product — check your WhatsApp connection and try again.',
        blockedBy: env.result?.blockedBy || null,
      });
    }

    const { createMessage } = require('../utils/core/createMessage');
    const wamid = env?.messageId || env?.result?.messageId || null;

    const newMessage = await createMessage({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      phone: conversation.phone,
      direction: 'outgoing',
      type: 'interactive',
      body: trimmedBody,
      agentId: req.user._id,
      messageId: wamid || agentMessageId,
      metadata: {
        interactive,
        productCard: {
          title: product.title,
          imageUrl: omitImage ? '' : imageUrl,
          url: product.productUrl,
          ctaLabel: 'View Product',
          shopifyProductId: product.shopifyProductId,
        },
      },
    });

    const now = new Date();
    const convPatch = {
      lastMessage: trimmedBody.substring(0, 100),
      lastMessageAt: now,
      requiresAttention: false,
      attentionReason: '',
    };
    await Conversation.updateOne({ _id: conversation._id }, { $set: convPatch });

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', {
        _id: conversation._id,
        ...convPatch,
      });
    }

    res.json(newMessage);
  } catch (error) {
    console.error('[send-product]', error?.response?.data || error.message);
    res.status(500).json({
      message: error.message || 'Could not send product — check your WhatsApp connection and try again.',
    });
  }
});

// @route   POST /api/conversations/:id/send-template
// @desc    Send a Meta WhatsApp Template to a lead
// @access  Private
router.post('/:id/send-template', protect, async (req, res) => {
  const { templateName, languageCode = 'en', components = [] } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    const { isWhatsAppOutboundReady } = require('../utils/meta/clientWhatsAppCreds');

    if (!isWhatsAppOutboundReady(client)) {
      return res.status(400).json({
        success: false,
        code: 'whatsapp_not_configured',
        message:
          'WhatsApp is not fully connected for this workspace. Open Settings → Connections and complete Meta embedded signup or paste your Cloud API credentials.',
      });
    }

    const { sendEnvelope } = require('../utils/messaging/sendEnvelope');
    const AdLead = require('../models/AdLead');
    const lead = await AdLead.findOne({
      clientId: conversation.clientId,
      phoneNumber: conversation.phone,
    })
      .select('_id')
      .lean();

    const tplResult = await sendEnvelope({
      clientId: conversation.clientId,
      channel: 'whatsapp',
      intent: 'utility',
      contactId: lead?._id ? String(lead._id) : undefined,
      contact: lead?._id ? undefined : { phone: conversation.phone },
      payload: {
        templateName,
        templateLanguage: languageCode || 'en',
        components: components || [],
      },
      idempotency: {
        key: `agent:${req.user._id}:tpl_${Date.now()}`,
      },
      context: {
        source: 'routes/conversations:send-template',
        conversationId: String(conversation._id),
      },
    });
    if (tplResult.status === 'blocked') {
      const isWindow =
        tplResult.blockedBy === 'service_window' ||
        tplResult.reason === 'window_closed' ||
        tplResult.reason === 'outside_service_window';
      return res.status(400).json({
        message: isWindow
          ? 'WhatsApp 24-hour service window closed. Choose an approved template the customer can receive outside the window.'
          : tplResult.reason || 'Send blocked by compliance',
        code: isWindow ? 'window_closed' : tplResult.blockedBy || 'blocked',
        blockedBy: tplResult.blockedBy,
      });
    }
    if (tplResult.status !== 'sent' && tplResult.status !== 'queued') {
      return res.status(400).json({
        message: 'Failed to send template',
        error: tplResult.reason || tplResult.status,
      });
    }

    // Save outbound message
    const newMessage = await createMessage({
      clientId: conversation.clientId,
      conversationId: conversation._id, // CRITICAL FIX
      phone: conversation.phone,
      direction: 'outbound',
      type: 'template',
      body: `[Template: ${templateName}]`
    });

    conversation.lastMessage = `[Template: ${templateName}]`;
    conversation.lastMessageAt = Date.now();
    conversation.requiresAttention = false; // Reset attention flag on manual template send
    if (conversation.attentionReason) conversation.attentionReason = '';
    await conversation.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    console.error('Template Send Error:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to send template', error: error.message });
  }
});

// @route   POST /api/conversations/:id/generate-outreach
// @desc    Generate personalized AI outreach copy (Email/WhatsApp)
// @access  Private
router.post('/:id/generate-outreach', protect, async (req, res) => {
  const { goal, channel = 'email' } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: conversation._id })
      .sort({ timestamp: 1 })
      .limit(20);

    const chatLog = messages.map(m => `${m.from}: ${m.content}`).join('\n');
    const client = await Client.findOne({ clientId: conversation.clientId });
    const { generateText } = require('../utils/core/gemini');

    const prompt = `
      Act as an expert ecommerce conversion specialist.
      Generate a highly personalized ${channel} outreach message for this customer.
      
      GOAL: ${goal}
      CUSTOMER NAME: ${conversation.customerName || 'Customer'}
      HISTORY:
      ${chatLog}
      
      Requirements:
      1. One compelling subject line (max 10 words).
      2. A concise, persuasive message body.
      3. Tone should be professional, empathetic, and premium.
      
      Return ONLY raw JSON: {"subject": "...", "body": "..."}
    `;

    const aiResponse = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY);
    
    try {
      const jsonStr = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      const result = JSON.parse(jsonStr);
      res.json(result);
    } catch (e) {
      // Logic fallback if AI returns plain text
      res.json({ subject: "Personalized Outreach", body: aiResponse });
    }
  } catch (error) {
    console.error("AI Generation Error:", error);
    res.status(500).json({ message: 'AI processing failed' });
  }
});

// @route   POST /api/conversations/:id/send-email
// @desc    Send an email to a lead from LiveChat
// @access  Private
router.post('/:id/send-email', protect, async (req, res) => {
  const { subject, body, toEmail, scheduleDate } = req.body;

  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.clientId = req.user.clientId;
    }
    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    
    if (!client?.emailUser) {
      return res.status(400).json({ message: 'Email not configured: add sending address and app password in workspace email / SMTP settings.' });
    }

    if (scheduleDate) {
      const ScheduledMessage = require('../models/ScheduledMessage');
      const scheduledMsg = new ScheduledMessage({
        clientId: conversation.clientId,
        phone: toEmail,
        channel: 'email',
        messageType: 'text',
        content: { subject, body, toEmail },
        sendAt: new Date(scheduleDate),
        status: 'pending',
        sourceType: 'follow_up',
        sourceId: conversation._id
      });
      await scheduledMsg.save();
      
      const newMessage = await Message.create({
        clientId: conversation.clientId,
        conversationId: conversation._id,
        from: 'agent',
        to: toEmail,
        content: `[Scheduled Email] ${subject}\n\nScheduled for ${new Date(scheduleDate).toLocaleString()}`,
        status: 'sent',
        channel: 'email',
        messageType: 'text',
        timestamp: new Date()
      });
      
      return res.json({ success: true, message: 'Email scheduled successfully', scheduledMessage: scheduledMsg });
    }

    const emailService = require('../utils/core/emailService');
    const sent = await emailService.sendEmail(client, {
      to: toEmail,
      subject,
      html: `<div>${body.replace(/\n/g, '<br/>')}</div>`
    });
    if (!sent) {
      return res.status(503).json({ message: 'SMTP send failed. Check workspace email credentials and SMTP host/port (465 recommended).' });
    }

    const newMessage = await Message.create({
      clientId: conversation.clientId,
      conversationId: conversation._id,
      from: 'agent',
      to: conversation.phone,
      content: `[Email] ${subject}\n\n${body}`,
      type: 'email',
      direction: 'outgoing',
      status: 'sent'
    });

    conversation.lastMessage = `[Email] ${subject}`;
    conversation.lastMessageAt = Date.now();
    conversation.requiresAttention = false; // Reset attention flag on manual email send
    if (conversation.attentionReason) conversation.attentionReason = '';
    await conversation.save();

    const io = req.app.get('socketio');
    if (io) {
      io.to(`client_${conversation.clientId}`).emit('new_message', newMessage);
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
    }

    res.json(newMessage);
  } catch (error) {
    console.error('Email Send Error:', error.message);
    res.status(500).json({ message: 'Failed to send email' });
  }
});

// @route   POST /api/conversations/:id/csat
router.post('/:id/csat', protect, async (req, res) => {
  try {
    const { rating } = req.body;
    const conversation = await Conversation.findOne(conversationQueryForTenant(req, req.params.id));
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    conversation.csatScore = { rating, respondedAt: new Date() };
    await conversation.save();
    res.json(conversation);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @route   POST /api/conversations/:id/assign
router.post('/:id/assign', protect, async (req, res) => {
  try {
    const { agentId, agentName, clientId: bodyClientId } = req.body;
    const activeClientId =
      req.user.role === 'SUPER_ADMIN' ? bodyClientId || req.user.clientId : req.user.clientId;

    let query = {};
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      query._id = req.params.id;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid conversation id' });
    }
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = activeClientId;
    else if (activeClientId) query.clientId = activeClientId;

    if (!agentId) {
      return res.status(400).json({ success: false, message: 'agentId is required' });
    }

    const assignedAt = new Date();
    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $set: {
          assignedTo: agentId,
          assignedAt,
          assignedBy: agentName || req.user.name,
          status: 'HUMAN_TAKEOVER',
          botPaused: true,
          isBotPaused: true,
          botStatus: 'paused',
          requiresAttention: false,
          attentionReason: '',
          updatedAt: assignedAt,
        },
      },
      { new: true }
    ).populate('assignedTo', 'name email');

    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const ConversationAssignment = require('../models/ConversationAssignment');
    await ConversationAssignment.create({
      conversationId: conversation._id,
      clientId: conversation.clientId,
      assignedAgentId: agentId,
      assignedAt,
    }).catch((err) => console.error('[Analytics] assignment record failed:', err.message));

    const io = req.app.get('socketio');
    if (io) {
      io.to(`agent_${agentId}`).emit('task_assigned', {
        agentId,
        message: 'A conversation was assigned to you.',
        conversationId: conversation._id,
      });
      io.to(`client_${conversation.clientId}`).emit('conversation_update', conversation);
      io.to(`client_${conversation.clientId}`).emit('conversation_assigned', {
        conversationId: conversation._id,
        agentId,
        agentName: conversation.assignedTo?.name || agentName || null,
      });
    }

    res.json({ success: true, conversation });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


/**
 * @route   PUT /api/conversations/:id/resolve
 * @desc    Mark conversation as resolved
 * @access  Private
 */
router.put('/:id/resolve', protect, async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

    const conversation = await Conversation.findOne(query);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    conversation.status = 'BOT_ACTIVE';
    conversation.botPaused = false;
    conversation.isBotPaused = false;
    conversation.resolvedAt = new Date();
    conversation.requiresAttention = false;
    await conversation.save();

    // --- Phase 23: Track 6 CSAT Trigger ---
    const { triggerCSAT } = require('../utils/core/csatService');
    await triggerCSAT(conversation); 

    const io = req.app.get('socketio');

    if (io) io.to(`client_${conversation.clientId}`).emit('conversation_resolved', conversation);

    res.json({ success: true, conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ─── GET /api/conversations/:id/export — Export conversation as PDF/JSON/TXT ──
router.get('/:id/export', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { format = 'pdf' } = req.query;
    const conversation = await Conversation.findById(req.params.id).lean();
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const messages = await Message.find({ conversationId: req.params.id })
      .sort({ createdAt: 1 })
      .lean();

    const client = await Client.findOne({ clientId: conversation.clientId }).lean();

    const timestamp = new Date().toISOString().split('T')[0];
    const filename  = `conversation_${conversation.phone}_${timestamp}`;

    // ── JSON export ─────────────────────────────────────────────────────────
    if (format === 'json') {
      res.set('Content-Type', 'application/json');
      res.set('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.send(JSON.stringify({ conversation, messages, exportedAt: new Date() }, null, 2));
    }

    // ── TXT export ──────────────────────────────────────────────────────────
    if (format === 'txt') {
      const lines = [
        `CONVERSATION TRANSCRIPT`,
        `${'─'.repeat(50)}`,
        `Business: ${client?.businessName || conversation.clientId}`,
        `Customer: ${conversation.customerName || 'Unknown'} (${conversation.phone})`,
        `Exported:  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        `${'─'.repeat(50)}`,
        '',
        ...messages.map(m => {
          const ts    = new Date(m.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
          const from  = m.direction === 'outbound' ? (client?.businessName || 'Bot') : (conversation.customerName || conversation.phone);
          return `[${ts}] ${from}: ${m.content || m.text || '(media)'}`;
        }),
        '',
        `${'─'.repeat(50)}`,
        'Generated by TopEdge AI'
      ];
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}.txt"`);
      return res.send(lines.join('\n'));
    }

    // ── PDF export ──────────────────────────────────────────────────────────
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('TopEdge AI', 40, 40);
    doc.fontSize(11).font('Helvetica').fillColor('#666').text('Conversation Transcript', 40, 65);
    doc.moveTo(40, 85).lineTo(555, 85).strokeColor('#E2E8F0').stroke();

    // Meta info
    doc.fillColor('#111').fontSize(10).font('Helvetica-Bold').text('Customer:', 40, 100, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${conversation.customerName || 'Unknown'} · ${conversation.phone}`, { continued: false });
    doc.font('Helvetica-Bold').fillColor('#111').text('Business:', 40, 118, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${client?.businessName || conversation.clientId}`);
    doc.font('Helvetica-Bold').fillColor('#111').text('Exported:', 40, 136, { continued: true })
      .font('Helvetica').fillColor('#444').text(`  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    doc.moveTo(40, 160).lineTo(555, 160).strokeColor('#E2E8F0').stroke();

    // Messages
    let y = 175;
    const PAGE_BOTTOM = 730;

    for (const msg of messages) {
      const isOutbound = msg.direction === 'outbound';
      const content    = (msg.content || msg.text || '').substring(0, 500);
      if (!content) continue;

      const senderLabel = isOutbound
        ? (client?.businessName || 'Agent')
        : (conversation.customerName || conversation.phone);
      const ts = new Date(msg.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

      // Page break
      if (y > PAGE_BOTTOM) {
        doc.addPage();
        y = 40;
      }

      // Bubble color
      const bubbleColor = isOutbound ? '#EFF6FF' : '#F8FAFC';
      const borderColor = isOutbound ? '#BFDBFE' : '#E2E8F0';
      const textHeight  = Math.ceil(content.length / 80) * 14 + 30;

      doc.roundedRect(isOutbound ? 140 : 40, y, 375, textHeight, 6)
        .fillAndStroke(bubbleColor, borderColor);

      doc.fillColor('#64748B').fontSize(8)
        .text(`${senderLabel} · ${ts}`, isOutbound ? 145 : 45, y + 8);
      doc.fillColor('#111').fontSize(9.5).font('Helvetica')
        .text(content, isOutbound ? 145 : 45, y + 20, { width: 360, lineGap: 2 });

      y += textHeight + 8;
    }

    // Footer
    doc.moveTo(40, PAGE_BOTTOM + 10).lineTo(555, PAGE_BOTTOM + 10).strokeColor('#E2E8F0').stroke();
    doc.fontSize(8).fillColor('#AAA').text('Generated by TopEdge AI · Confidential', 40, PAGE_BOTTOM + 18, { align: 'center' });

    doc.end();
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/conversations/smart-recovery/toggle — enable/disable AI recovery ─
router.post('/smart-recovery/toggle', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    client.smartCartRecovery = !client.smartCartRecovery;
    await client.save();
    res.json({ success: true, smartCartRecovery: client.smartCartRecovery });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/smart-recovery/preview — preview AI messages ──────
router.get('/smart-recovery/preview', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { leadId } = req.query;
    if (!leadId) return res.status(400).json({ success: false, message: 'leadId required' });

    const client = await Client.findOne({ clientId }).lean();
    const AdLead = require('../models/AdLead');
    const lead = await AdLead.findById(leadId).lean();
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    if (lead.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { generateSmartRecoveryMessage } = require('../utils/commerce/smartCartRecovery');
    const [step1, step2, step3] = await Promise.all([
      generateSmartRecoveryMessage(client, lead, 1),
      generateSmartRecoveryMessage(client, lead, 2),
      generateSmartRecoveryMessage(client, lead, 3)
    ]);

    res.json({ success: true, previews: { step1, step2, step3 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/conversations/bulk-export — Enqueue bulk PDF/JSON/CSV export ────
router.post('/bulk-export', protect, async (req, res) => {
  try {
    const { ids, format = 'pdf' } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ success: false, message: 'No conversations selected' });

    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    
    // Create Export Job
    const job = await ExportJob.create({
      clientId,
      userId: req.user._id,
      type: `conversations_${format}`,
      status: 'pending',
      totalItems: ids.length,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h expiration
    });

    res.json({ success: true, jobId: job._id });

    // ── BACKGROUND PROCESSING ──────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        job.status = 'processing';
        await job.save();

        const exportDir = path.join(__dirname, '../public/exports');
        if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

        const filename = `bulk_export_${job._id}.${format}`;
        const filepath = path.join(exportDir, filename);
        
        if (format === 'pdf') {
          const PDFDocument = require('pdfkit');
          const doc = new PDFDocument({ margin: 40, size: 'A4' });
          const stream = fs.createWriteStream(filepath);

          // Register Fonts for Hindi/Gujarati support
          const fontDir = path.join(__dirname, '../utils/fonts');
          const hindiFont = path.join(fontDir, 'NotoSansDevanagari-Regular.ttf');
          const gujaratiFont = path.join(fontDir, 'NotoSansGujarati-Regular.ttf');
          const hasHindi = fs.existsSync(hindiFont);
          const hasGujarati = fs.existsSync(gujaratiFont);

          if (hasHindi) doc.registerFont('Hindi', hindiFont);
          if (hasGujarati) doc.registerFont('Gujarati', gujaratiFont);

          doc.pipe(stream);

          for (let i = 0; i < ids.length; i++) {
            const convoId = ids[i];
            const conversation = await Conversation.findById(convoId).lean();
            if (!conversation) continue;

            const messages = await Message.find({ conversationId: convoId }).sort({ createdAt: 1 }).lean();
            const client = await Client.findOne({ clientId: conversation.clientId }).lean();

            if (i > 0) doc.addPage();

            // Header for each conversation
            doc.fontSize(16).fillColor('#111').text(`Conversation: ${conversation.customerName || conversation.phone}`, { align: 'center' });
            doc.fontSize(10).fillColor('#666').text(`Business: ${client?.businessName || conversation.clientId}`, { align: 'center' });
            doc.moveTo(40, 80).lineTo(555, 80).strokeColor('#EEE').stroke();

            let y = 100;
            for (const m of messages) {
                if (y > 700) { doc.addPage(); y = 40; }
                const isOutbound = m.direction === 'outbound';
                const ts = new Date(m.createdAt).toLocaleTimeString();
                
                // Select font based on script detection (simple regex)
                const content = m.content || '';
                let activeFont = 'Helvetica'; // Fallback
                if (/[\u0900-\u097F]/.test(content) && hasHindi) activeFont = 'Hindi';
                else if (/[\u0A80-\u0AFF]/.test(content) && hasGujarati) activeFont = 'Gujarati';

                doc.fontSize(8).fillColor(isOutbound ? '#4F46E5' : '#10B981').text(`[${ts}] ${isOutbound ? 'Bot' : 'Customer'}:`, 40, y);
                doc.font(activeFont).fontSize(9).fillColor('#333').text(content || '(Media)', 110, y, { width: 440 });
                // Reset font for next parts
                doc.font('Helvetica');
                y += Math.ceil((content || '').length / 90) * 12 + 15;
            }
            
            job.processedItems = i + 1;
            job.progress = Math.round(((i + 1) / ids.length) * 100);
            await job.save();
          }
          doc.end();
          
          await new Promise((resolve) => stream.on('finish', resolve));
        } else if (format === 'json') {
          const data = [];
          for (let i = 0; i < ids.length; i++) {
             const convo = await Conversation.findById(ids[i]).lean();
             const msgs  = await Message.find({ conversationId: ids[i] }).lean();
             data.push({ conversation: convo, messages: msgs });
             job.progress = Math.round(((i + 1) / ids.length) * 100);
             await job.save();
          }
          fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        }

        job.status = 'completed';
        job.fileUrl = `/public/exports/${filename}`;
        job.fileName = filename;
        await job.save();
      } catch (err) {
        console.error(`Export Job ${job._id} Failed:`, err);
        job.status = 'failed';
        job.error = err.message;
        await job.save();
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/export-jobs/:id — Check status and polling ────────
router.get('/export-jobs/:id', protect, async (req, res) => {
  try {
    const job = await ExportJob.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (req.user.role === 'SUPER_ADMIN') {
      return res.json({ success: true, job });
    }
    const tenantId = tenantClientId(req);
    if (!tenantId || job.clientId !== tenantId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/conversations/:id/smart-replies — AI Contextual Suggestions ──
router.get('/:id/smart-replies', protect, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/conversations/:id/smart-replies', req.user?.clientId || '');
  try {
    const convoId = req.params.id;
    const conversation = await timer.time('Conversation.findById', () =>
      Conversation.findById(convoId).select('clientId phone').lean()
    );
    if (!conversation) {
      timer.finish('404');
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (conversation.clientId !== clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await timer.time('getCachedClient', () =>
      getCachedClient(clientId, 'businessName geminiApiKey')
    );
    if (!client) {
      timer.finish('404 client');
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const messages = await timer.time('Message.find', () =>
      Message.find({ conversationId: convoId })
        .sort({ timestamp: -1 })
        .limit(10)
        .select('content direction')
        .lean()
    );
    
    if (messages.length === 0) {
      return res.json({ success: true, replies: ['Hello! How can I help you today?', 'Hi there!', 'Welcome!'] });
    }

    const contextArr = messages.reverse().map(m => `${m.direction === 'incoming' ? 'Customer' : 'Agent'}: ${m.content || '(Media)'}`);
    const contextStr = contextArr.join('\n');

    const prompt = `
    You are an AI assistant helping a human customer support agent for "${client.businessName || 'our business'}".
    Below is the recent chat history with the customer (Customer Phone: ${conversation.phone}).
    
    Chat History:
    ${contextStr}

    Based on the context, suggest exactly 3 short, distinct, direct replies the human agent could send RIGHT NOW. 
    They should be conversational, helpful, and under 15 words each.
    Format your response STRICTLY as a JSON array of 3 strings. Example: ["Yes, we have it.", "I will check for you.", "Please provide your order number."]
    Do not include any markdown, backticks, or explanation. Just the raw JSON array.
    `;

    const { generateText } = require('../utils/core/gemini');
    const aiResponseRaw = await timer.time('gemini.generateText', () =>
      generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY)
    );
    
    let replies = [];
    if (aiResponseRaw) {
       try {
         const cleaned = aiResponseRaw.replace(/```json/g, '').replace(/```/g, '').trim();
         replies = JSON.parse(cleaned);
       } catch (parseErr) {
         console.error('Smart reply parse error:', parseErr.message, 'Raw:', aiResponseRaw);
       }
    }

    // Fallbacks if AI fails or returns malformed
    if (!Array.isArray(replies) || replies.length < 3) {
       replies = [
         "Let me check that for you.",
         "Could you provide more details?",
         "I understand, give me a moment."
       ];
    }

    res.json({ success: true, replies: replies.slice(0, 3) });
    timer.finish('200 ok');
  } catch (err) {
    console.error('SmartReplies Error:', err);
    timer.finish(`500 error=${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   POST /api/conversations/:id/ghost-complete
// @desc    Live Copilot Autocomplete for Agent Typings
// @access  Private
router.post('/:id/ghost-complete', protect, async (req, res) => {
  try {
    const convoId = req.params.id;
    const { currentInput } = req.body;
    
    if (!currentInput || currentInput.length < 3) {
      return res.json({ success: true, completion: '' });
    }

    const conversation = await Conversation.findById(convoId);
    if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const client = await Client.findOne({ clientId: conversation.clientId });
    
    // Fetch last 5 messages for context
    const messages = await Message.find({ conversationId: convoId })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
      
    const contextStr = messages.reverse().map(m => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.content || '(Media)'}`).join('\n');

    const prompt = `
    You are an AI Copilot assisting a customer support agent for "${client?.businessName || 'a business'}".
    Here is the recent chat history:
    ${contextStr}

    The agent is currently typing: "${currentInput}"

    Your task: Autocomplete the agent's message.
    CRITICAL RULE: Output ONLY the EXACT text that should FOLLOW the agent's current input. 
    Do NOT repeat what the agent has already typed.
    Do NOT include quotes.
    Keep the completion under 20 words.
    `;

    const { generateText } = require('../utils/core/gemini');
    let aiResponseRaw = await generateText(prompt, client?.geminiApiKey || process.env.GEMINI_API_KEY, { temperature: 0.1, maxTokens: 40 });
    
    if (aiResponseRaw) {
      // Clean up common AI prefixes that ignore instructions
      const cleaned = aiResponseRaw.replace(/^["']/, '').replace(/["']$/, '').trim();
      return res.json({ success: true, completion: cleaned });
    }
    
    return res.json({ success: true, completion: '' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// GAP 4: Context endpoint to fetch Active Sequences and Campaigns
router.get('/:clientId/:phone/context', protect, logPersonalDataAccess, async (req, res) => {
    try {
        const { clientId, phone } = req.params;
        const FollowUpSequence = require('../models/FollowUpSequence');
        const CampaignMessage = require('../models/CampaignMessage');
        const AdLead = require('../models/AdLead');

        const tenantId = tenantClientId(req);
        if (!tenantId || tenantId !== clientId) {
           return res.status(403).json({ success: false, message: 'Unauthorized client access' });
        }

        const lead = await AdLead.findOne({ clientId, phoneNumber: phone });
        
        // Fetch specific active sequences
        const activeSequences = await FollowUpSequence.find({ 
            clientId, 
            phone, 
            status: { $in: ["active", "pending"] } 
        });
        
        // Fetch recent outbound campaigns sent to lead
        const recentCampaigns = await CampaignMessage.find({ 
            clientId, 
            phone 
        }).sort({ sentAt: -1 }).limit(5);

        res.json({
            success: true,
            lead,
            activeSequences: activeSequences.map(seq => ({
                id: seq._id,
                name: seq.name,
                status: seq.status,
                progress: `${seq.steps.filter(s => s.status === 'sent').length}/${seq.steps.length}`,
                nextSendAt: seq.steps.find(s => s.status === 'pending')?.sendAt
            })),
            recentCampaigns: recentCampaigns.map(camp => ({
                id: camp._id,
                name: camp.campaignName || "Broadcast",
                status: camp.status,
                sentAt: camp.sentAt
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/resolve', protect, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (req.user.role !== 'SUPER_ADMIN') query.clientId = req.user.clientId;

        const conversation = await Conversation.findOne(query);
        if (!conversation) return res.status(404).json({ success: false, message: 'Conversation not found' });

        conversation.status = 'BOT_ACTIVE';
        conversation.requiresAttention = false;
        conversation.botStatus = 'active';
        conversation.botPaused = false;
        conversation.isBotPaused = false;
        conversation.resolvedAt = new Date();

        await conversation.save();

        try {
            const ConversationNote = require('../models/ConversationNote');
            await ConversationNote.create({
                conversationId: conversation._id,
                clientId: conversation.clientId,
                content: `Ticket marked as RESOLVED by ${req.user.name || 'Agent'}. Bot is active for new messages.`,
                authorId: req.user._id,
                authorName: 'System',
                createdAt: new Date()
            });
        } catch (noteErr) {
            console.error('[POST resolve] Note create failed:', noteErr.message);
        }

        try {
            const AdLead = require('../models/AdLead');
            await AdLead.findOneAndUpdate(
                { phoneNumber: conversation.phone, clientId: conversation.clientId },
                { $set: { pendingSupport: false } }
            );
        } catch (err) {}

        const io = req.app.get('socketio');
        if (io) {
            const payload = conversation.toObject ? conversation.toObject() : conversation;
            io.to(`client_${conversation.clientId}`).emit('conversation_update', payload);
            io.to(`client_${conversation.clientId}`).emit('conversationUpdated', {
                conversationId: conversation._id,
                status: conversation.status,
                requiresAttention: conversation.requiresAttention,
                botStatus: conversation.botStatus
            });
            io.to(`client_${conversation.clientId}`).emit('botStatusChanged', {
                conversationId: String(conversation._id),
                botStatus: conversation.botStatus
            });
        }

        res.json({ success: true, conversation });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/clear-intent', protect, async (req, res) => {
    try {
        const conversation = await Conversation.findByIdAndUpdate(
            req.params.id,
            { $set: { "lastDetectedIntent.intentName": null, "lastDetectedIntent.confidenceScore": 0, "lastDetectedIntent.detectedAt": null } },
            { new: true }
        );
        res.json({ success: true, lastDetectedIntent: conversation.lastDetectedIntent });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
module.exports.getConversationsList = getConversationsList;

