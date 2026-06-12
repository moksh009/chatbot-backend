'use strict';

const Conversation = require('../models/Conversation');
const IGConversation = require('../models/IGConversation');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { auditSecurity } = require('./securityAudit');
const log = require('../utils/core/logger')('InboxScope');

/**
 * Resolve channel for inbox :id routes (query takes precedence over body).
 */
function resolveInboxChannel(req) {
  const raw = req.query?.channel || req.body?.channel;
  if (!raw) return null;
  return String(raw).toLowerCase() === 'instagram' ? 'instagram' : 'whatsapp';
}

/**
 * Load conversation doc and verify it belongs to the authenticated tenant.
 * Sets req.inboxConversation = { channel, doc } on success.
 * Returns false if response was already sent.
 */
async function assertInboxConversationTenant(req, res) {
  const tenantId = tenantClientId(req);
  if (!tenantId) {
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }

  const { id } = req.params;
  if (!id || !/^[a-f\d]{24}$/i.test(String(id))) {
    res.status(400).json({ error: 'Invalid conversation id' });
    return false;
  }

  const channel = resolveInboxChannel(req);
  if (!channel) {
    res.status(400).json({
      error: 'channel query or body param is required (whatsapp | instagram)',
    });
    return false;
  }

  if (channel === 'instagram') {
    const doc = await IGConversation.findById(id).select('clientId igsid igUsername').lean();
    if (!doc) {
      res.status(404).json({ error: 'Conversation not found' });
      return false;
    }
    if (String(doc.clientId) !== String(tenantId)) {
      auditSecurity('INBOX_TENANT_DENIED', {
        req,
        tenantId: req.user?.clientId,
        targetClientId: doc.clientId,
        reason: 'instagram conversation cross-tenant',
      });
      log.warn('Inbox IG cross-tenant blocked', { id, tenantId, owner: doc.clientId });
      res.status(403).json({ error: 'Forbidden' });
      return false;
    }
    req.inboxConversation = { channel: 'instagram', doc };
    return true;
  }

  const doc = await Conversation.findById(id).select('clientId phone customerName').lean();
  if (!doc) {
    res.status(404).json({ error: 'Conversation not found' });
    return false;
  }
  if (String(doc.clientId) !== String(tenantId)) {
    auditSecurity('INBOX_TENANT_DENIED', {
      req,
      tenantId: req.user?.clientId,
      targetClientId: doc.clientId,
      reason: 'whatsapp conversation cross-tenant',
    });
    log.warn('Inbox WA cross-tenant blocked', { id, tenantId, owner: doc.clientId });
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  req.inboxConversation = { channel: 'whatsapp', doc };
  return true;
}

/**
 * Express middleware for /api/inbox/conversations/:id/* routes.
 */
function inboxConversationScope() {
  return async (req, res, next) => {
    try {
      const ok = await assertInboxConversationTenant(req, res);
      if (!ok) return;
      return next();
    } catch (err) {
      log.error('inboxConversationScope error', { message: err.message });
      return res.status(500).json({ error: 'Tenant scope check failed' });
    }
  };
}

module.exports = {
  inboxConversationScope,
  assertInboxConversationTenant,
  resolveInboxChannel,
};
