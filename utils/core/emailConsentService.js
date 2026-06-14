'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const AdLead = require('../../models/AdLead');
const EmailTracking = require('../../models/EmailTracking');
const SuppressionList = require('../../models/SuppressionList');
const { emitToClient } = require('./socket');

const VALID_STATUSES = new Set(['opted_in', 'opted_out']);

function normalizeEmailConsentStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return VALID_STATUSES.has(s) ? s : null;
}

/**
 * Set per-channel email marketing consent on a lead (tenant-scoped).
 * Does not override global WhatsApp opt-out when re-subscribing email only.
 */
async function setLeadEmailConsent({
  clientId,
  leadId,
  status,
  source = 'admin_manual',
  actorUserId = null,
  cancelAutomations = true,
} = {}) {
  const next = normalizeEmailConsentStatus(status);
  if (!next) {
    const err = new Error('status must be opted_in or opted_out');
    err.status = 400;
    throw err;
  }
  if (!clientId || !leadId) {
    const err = new Error('clientId and leadId are required');
    err.status = 400;
    throw err;
  }

  if (!mongoose.Types.ObjectId.isValid(String(leadId))) {
    const err = new Error('Invalid lead id');
    err.status = 400;
    throw err;
  }

  const lead = await AdLead.findOne({ _id: leadId, clientId });
  if (!lead) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }

  const email = String(lead.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    const err = new Error('Lead has no valid email address');
    err.status = 400;
    throw err;
  }

  const now = new Date();
  const prevStatus = String(lead.channelConsent?.email?.status || 'unknown').toLowerCase();

  lead.channelConsent = lead.channelConsent || {};
  lead.channelConsent.email = lead.channelConsent.email || {};
  lead.channelConsent.email.status = next;
  lead.channelConsent.email.lastUpdated = now;
  lead.channelConsent.email.source = source;

  if (next === 'opted_out') {
    lead.channelConsent.email.unsubscribeAt = now;
    if (!lead.channelConsent.email.unsubscribeToken) {
      lead.channelConsent.email.unsubscribeToken = crypto.randomBytes(24).toString('hex');
    }
  } else {
    lead.channelConsent.email.unsubscribeAt = null;
    if (lead.emailBounced) {
      lead.emailBounced = false;
      lead.emailHardBounce = false;
      lead.emailBouncedAt = null;
    }
  }

  lead.optInHistory = lead.optInHistory || [];
  lead.optInHistory.push({
    event: next,
    action: next,
    source,
    timestamp: now,
    note:
      next === 'opted_out'
        ? 'Email marketing opt-out'
        : 'Email marketing re-subscribed',
  });

  await lead.save();

  if (next === 'opted_out') {
    await SuppressionList.findOneAndUpdate(
      { clientId, phone: email, channel: 'email' },
      { $set: { reason: 'opted_out', source, addedAt: now } },
      { upsert: true }
    );
    try {
      await EmailTracking.create({
        clientId,
        leadId: lead._id,
        type: 'unsubscribe',
        url: '',
        ipAddress: '',
        userAgent: String(source).slice(0, 500),
        timestamp: now,
      });
    } catch (_) {
      /* non-fatal */
    }
  } else {
    await SuppressionList.deleteOne({ clientId, phone: email, channel: 'email' }).catch(() => {});
  }

  if (cancelAutomations && next === 'opted_out') {
    try {
      const { cancelAllAutomationsFor } = require('../messaging/cancelAllAutomationsFor');
      await cancelAllAutomationsFor({
        clientId,
        leadId: lead._id,
        phone: lead.phoneNumber,
        reason: source === 'unsubscribe_link' ? 'unsubscribe_link' : 'agent_block',
        channels: ['email'],
        actor: {
          type: actorUserId ? 'user' : 'lead',
          userId: actorUserId || undefined,
          leadId: lead._id,
          source,
        },
      });
    } catch (_) {
      /* non-fatal */
    }
  }

  emitToClient(clientId, 'lead_email_consent_changed', {
    leadId: String(lead._id),
    email,
    status: next,
    previousStatus: prevStatus,
    source,
  });

  return {
    leadId: String(lead._id),
    name: lead.name || '—',
    email: lead.email,
    status: next,
    unsubscribed: next === 'opted_out',
    unsubscribeAt: lead.channelConsent.email.unsubscribeAt || null,
  };
}

async function getEmailConsentEvents(clientId, { limit = 15, days = 30 } = {}) {
  const take = Math.min(50, Math.max(1, Number(limit) || 15));
  const dayCount = Math.min(90, Math.max(1, Number(days) || 30));
  const since = new Date(Date.now() - dayCount * 86400000);

  const trackingRows = await EmailTracking.find({
    clientId,
    type: 'unsubscribe',
    timestamp: { $gte: since },
  })
    .sort({ timestamp: -1 })
    .limit(take * 2)
    .lean();

  const leadIds = [...new Set(trackingRows.map((r) => String(r.leadId)).filter(Boolean))];
  const leadMap = new Map();
  if (leadIds.length) {
    const leads = await AdLead.find({ clientId, _id: { $in: leadIds } })
      .select('name email')
      .lean();
    for (const l of leads) leadMap.set(String(l._id), l);
  }

  const rows = trackingRows.slice(0, take).map((row) => {
    const l = row.leadId ? leadMap.get(String(row.leadId)) : null;
    return {
      id: String(row._id),
      leadId: row.leadId ? String(row.leadId) : null,
      name: l?.name || '—',
      email: l?.email || '—',
      event: 'opted_out',
      source: String(row.userAgent || 'unsubscribe_link').includes('dashboard')
        ? 'dashboard:email_hub'
        : 'unsubscribe_link',
      timestamp: row.timestamp,
    };
  });

  return { rows, total: rows.length, since };
}

module.exports = {
  setLeadEmailConsent,
  getEmailConsentEvents,
  normalizeEmailConsentStatus,
};
