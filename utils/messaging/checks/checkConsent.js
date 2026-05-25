function getChannelConsent(contact, channel) {
  return contact?.channelConsent?.[channel] || { status: contact?.optStatus || 'unknown' };
}

function checkConsent({ contact, channel, intent, strictMode = true }) {
  const consent = getChannelConsent(contact, channel);
  const status = String(consent?.status || 'unknown');
  const blocked = { pass: false, blockedBy: 'consent', consentSnapshot: consent };

  if (intent === 'marketing') {
    if (status !== 'opted_in') {
      if (strictMode || status === 'opted_out') return { ...blocked, reason: 'marketing_requires_opted_in' };
    }
    return { pass: true, consentSnapshot: consent };
  }
  if (intent === 'service') {
    return { pass: true, consentSnapshot: consent };
  }
  if (status === 'opted_out') return { ...blocked, reason: 'recipient_opted_out' };
  return { pass: true, consentSnapshot: consent };
}

module.exports = { checkConsent };
