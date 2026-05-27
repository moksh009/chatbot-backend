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

  if (status === 'opted_out') {
    return { ...blocked, reason: 'recipient_opted_out' };
  }

  return { pass: true, consentSnapshot: consent };
}

module.exports = { checkConsent, getChannelConsent };
