'use strict';

/**
 * Resolve merchant WhatsApp digits for wa.me links (no + prefix).
 */
function resolveMerchantWaPhone(client, toolDesign = {}) {
  const manual = String(toolDesign.phoneNumber || '').replace(/\D/g, '');
  if (manual.length >= 10) return manual;

  const fromDisplay = String(client?.whatsappDisplayPhoneNumber || '').replace(/\D/g, '');
  if (fromDisplay.length >= 10) return fromDisplay;

  const accounts = Array.isArray(client?.wabaAccounts) ? client.wabaAccounts : [];
  for (const acc of accounts) {
    const digits = String(acc?.phoneNumber || acc?.displayPhoneNumber || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits;
  }

  const fromPlatform = String(client?.platformVars?.adminWhatsappNumber || '').replace(/\D/g, '');
  if (fromPlatform.length >= 10) return fromPlatform;

  return '';
}

function buildWaMeLink(client, toolDesign, message) {
  const digits = resolveMerchantWaPhone(client, toolDesign);
  if (!digits) return '';
  const text = encodeURIComponent(String(message || toolDesign?.defaultWhatsAppMessage || 'Hi!').trim());
  return `https://wa.me/${digits}?text=${text}`;
}

module.exports = { resolveMerchantWaPhone, buildWaMeLink };
