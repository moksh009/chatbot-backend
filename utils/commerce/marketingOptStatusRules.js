'use strict';

const AdLead = require('../../models/AdLead');
const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');

const MANUAL_RE_OPT_IN_BLOCKED_MESSAGE =
  'Manual override blocked: opted-out contacts cannot be switched back to opted-in.';

function normalizeOptStatus(raw) {
  const s = String(raw || 'opted_in').trim().toLowerCase();
  if (s === 'opted_in' || s === 'opted_out' || s === 'pending') return s;
  return 'opted_in';
}

function isManualReOptInBlocked(currentStatus, nextStatus) {
  const current = normalizeOptStatus(currentStatus);
  const next = nextStatus ? normalizeOptStatus(nextStatus) : null;
  return current === 'opted_out' && next === 'opted_in';
}

function canAutomatedKeywordOptIn(currentStatus) {
  const s = normalizeOptStatus(currentStatus);
  return s === 'opted_in' || s === 'unknown' || s === 'pending' || s === 'opted_out';
}

function buildKeywordOptInSetFields() {
  const now = new Date();
  return {
    optStatus: 'opted_in',
    optInDate: now,
    optInSource: 'keyword',
    optInMethod: 'single',
    whatsappMarketingEligible: true,
    optOutDate: null,
    optOutSource: '',
    'channelConsent.whatsapp.status': 'opted_in',
    'channelConsent.whatsapp.source': 'inbound_message',
    'channelConsent.whatsapp.timestamp': now,
    'channelConsent.whatsapp.lastUpdated': now,
  };
}

function buildKeywordOptInHistoryEntry() {
  return {
    event: 'opted_in',
    action: 're_opted_in',
    timestamp: new Date(),
    source: 'user_keyword',
    note: 'Customer keyword opt-in',
  };
}

function buildOrderPlacedOptInSetFields(currentStatus) {
  if (normalizeOptStatus(currentStatus) === 'opted_out') return {};
  return buildDefaultOptInSetFields('shopify_order');
}

function buildCsvImportOptInSetFields() {
  return buildDefaultOptInSetFields('csv_import');
}

function buildDefaultOptInSetFields(source = 'csv_import') {
  const now = new Date();
  return {
    optStatus: 'opted_in',
    optInDate: now,
    optInSource: source,
    optInMethod: 'single',
    whatsappMarketingEligible: true,
    'channelConsent.whatsapp.status': 'opted_in',
    'channelConsent.whatsapp.source': source === 'csv_import' ? 'csv_import' : 'inbound_message',
    'channelConsent.whatsapp.timestamp': now,
    'channelConsent.whatsapp.lastUpdated': now,
  };
}

function buildManualOptStatusHistoryEntry(nextStatus) {
  const status = normalizeOptStatus(nextStatus);
  if (status !== 'opted_in' && status !== 'opted_out') return null;
  return {
    event: status,
    action: status,
    source: 'admin_manual',
    timestamp: new Date(),
    note: 'Manual status override from dashboard',
  };
}

function buildManualOptStatusSetFields(nextStatus, existingLead = {}) {
  const status = normalizeOptStatus(nextStatus);
  if (status !== 'opted_in' && status !== 'opted_out') return {};

  const fields = { optStatus: status };
  if (status === 'opted_out') {
    fields.optOutDate = new Date();
    fields.optOutSource = 'admin_manual';
    fields.whatsappMarketingEligible = false;
    fields['channelConsent.whatsapp.status'] = 'opted_out';
    fields['channelConsent.whatsapp.source'] = 'admin_override';
    fields['channelConsent.whatsapp.timestamp'] = new Date();
    fields['channelConsent.whatsapp.lastUpdated'] = new Date();
  }
  if (status === 'opted_in') {
    fields.optInDate = existingLead.optInDate || new Date();
    fields.optInSource = existingLead.optInSource || 'admin_manual';
    fields.optOutDate = null;
    fields.optOutSource = '';
    fields.whatsappMarketingEligible = true;
    fields['channelConsent.whatsapp.status'] = 'opted_in';
    fields['channelConsent.whatsapp.source'] = 'admin_override';
    fields['channelConsent.whatsapp.timestamp'] = fields.optInDate;
    fields['channelConsent.whatsapp.lastUpdated'] = new Date();
  }
  return fields;
}

async function markLeadOptOutFromSendFailure({ clientId, phone, errorMessage = '' }) {
  if (!clientId || !phone) return null;
  const now = new Date();
  const variants = phoneVariants(phone);
  return AdLead.findOneAndUpdate(
    { clientId, phoneNumber: { $in: variants } },
    {
      $set: {
        optStatus: 'opted_out',
        optOutDate: now,
        optOutSource: 'delivery_failed',
        whatsappMarketingEligible: false,
        'channelConsent.whatsapp.status': 'opted_out',
        'channelConsent.whatsapp.source': 'inbound_message',
        'channelConsent.whatsapp.timestamp': now,
        'channelConsent.whatsapp.lastUpdated': now,
      },
      $push: {
        optInHistory: {
          event: 'opted_out',
          action: 'opted_out',
          source: 'delivery_failed',
          timestamp: now,
          note: errorMessage ? `Send failed: ${errorMessage}` : 'WhatsApp delivery failed',
        },
      },
    },
    { new: true }
  );
}

module.exports = {
  MANUAL_RE_OPT_IN_BLOCKED_MESSAGE,
  normalizeOptStatus,
  isManualReOptInBlocked,
  canAutomatedKeywordOptIn,
  buildKeywordOptInSetFields,
  buildKeywordOptInHistoryEntry,
  buildDefaultOptInSetFields,
  buildOrderPlacedOptInSetFields,
  buildCsvImportOptInSetFields,
  buildManualOptStatusHistoryEntry,
  buildManualOptStatusSetFields,
  markLeadOptOutFromSendFailure,
};
