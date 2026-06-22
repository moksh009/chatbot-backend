'use strict';

const { normalizeOptStatus } = require('../../commerce/marketingOptStatusRules');

function getChannelConsent(contact, channel) {
  const cc = contact?.channelConsent?.[channel];
  const raw = cc?.status || contact?.optStatus || 'opted_in';
  const status = normalizeOptStatus(raw);
  return { ...(cc || {}), status };
}

function checkConsent({ contact, channel, intent, strictMode = true, complianceExempt = false }) {
  const consent = getChannelConsent(contact, channel);
  const status = String(consent?.status || 'opted_in');
  const blocked = { pass: false, blockedBy: 'consent', consentSnapshot: consent };

  if (complianceExempt) {
    return { pass: true, consentSnapshot: consent };
  }

  const intentNorm = String(intent || 'service').toLowerCase();

  if (status === 'opted_out') {
    // Service/session bot replies (flows, interactive menus, order help) are allowed.
    // Marketing templates, campaigns, and cart-recovery promos stay blocked until re-engagement.
    if (intentNorm === 'service' || intentNorm === 'transactional' || intentNorm === 'utility') {
      return { pass: true, consentSnapshot: consent };
    }
    return { ...blocked, reason: channel === 'email' ? 'email_opted_out' : 'recipient_opted_out' };
  }

  if (channel === 'email') {
    const emailStatus = String(contact?.channelConsent?.email?.status || '').toLowerCase();
    if (emailStatus === 'opted_out') {
      return { ...blocked, reason: 'email_opted_out' };
    }
    if (contact?.emailBounced) {
      return { ...blocked, reason: 'email_bounced' };
    }
  }

  return { pass: true, consentSnapshot: consent };
}

module.exports = { checkConsent, getChannelConsent };
