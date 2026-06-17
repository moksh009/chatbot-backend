'use strict';

const Client = require('../../models/Client');
const { buildConnectionStatusPayload } = require('./connectionStatus');
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
} = require('../meta/clientWhatsAppCreds');

/** Match QR rows stored with string clientId or legacy ObjectId string. */
function qrClientIdFilter(client) {
  const ids = new Set();
  if (client?.clientId) ids.add(String(client.clientId));
  if (client?._id) ids.add(String(client._id));
  const list = [...ids];
  if (list.length <= 1) return { clientId: list[0] || '' };
  return { $or: list.map((id) => ({ clientId: id })) };
}

function qrBelongsToClient(qr, client) {
  if (!qr || !client) return false;
  const stored = String(qr.clientId || '');
  return stored === String(client.clientId) || stored === String(client._id);
}

function isWhatsAppBusinessConnected(client) {
  if (!client) return false;
  return !!buildConnectionStatusPayload(client).whatsapp_connected;
}

/**
 * WhatsApp Business number only — never adminPhone / account owner personal numbers.
 */
function getStoredWhatsAppBusinessPhoneDigits(client) {
  if (!client) return '';

  const fromDisplay = String(client.whatsappDisplayPhoneNumber || '').replace(/\D/g, '');
  if (fromDisplay.length >= 10) return fromDisplay;

  const accounts = Array.isArray(client.wabaAccounts) ? client.wabaAccounts : [];
  for (const acc of accounts) {
    const digits = String(acc?.phoneNumber || acc?.displayPhoneNumber || '').replace(/\D/g, '');
    if (digits.length >= 10) return digits;
  }

  return '';
}

function formatWhatsAppPhoneForDisplay(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return '';
  return `+${d}`;
}

async function fetchDisplayPhoneFromMeta(client) {
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client);
  const token = getEffectiveWhatsAppAccessToken(client);
  if (!phoneNumberId || !token) return '';

  try {
    const axios = require('axios');
    const res = await axios.get(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { fields: 'display_phone_number' },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    });
    const display = res.data?.display_phone_number;
    const digits = String(display || '').replace(/\D/g, '');
    if (res.status < 400 && digits.length >= 10) {
      if (client.clientId && !getStoredWhatsAppBusinessPhoneDigits(client)) {
        Client.updateOne(
          { clientId: client.clientId },
          { $set: { whatsappDisplayPhoneNumber: display } }
        ).catch(() => {});
      }
      return digits;
    }
  } catch (_) {
    /* fall through */
  }
  return '';
}

/**
 * Digits for wa.me/{phone} — connected WhatsApp Business number only.
 */
async function resolveClientWaPhone(client) {
  if (!client) return '';

  const stored = getStoredWhatsAppBusinessPhoneDigits(client);
  if (stored) return stored;

  if (!isWhatsAppBusinessConnected(client)) return '';

  return fetchDisplayPhoneFromMeta(client);
}

/**
 * Authoritative QR phone + connection context for API + UI.
 */
async function getClientQrPhoneContext(client) {
  const whatsappConnected = isWhatsAppBusinessConnected(client);
  const phoneDigits = await resolveClientWaPhone(client);
  const waDisplayPhone = formatWhatsAppPhoneForDisplay(phoneDigits);
  const waPhoneConfigured = whatsappConnected && phoneDigits.length >= 10;

  return {
    whatsappConnected,
    phoneDigits,
    waDisplayPhone,
    waPhoneConfigured,
  };
}

module.exports = {
  qrClientIdFilter,
  qrBelongsToClient,
  isWhatsAppBusinessConnected,
  getStoredWhatsAppBusinessPhoneDigits,
  formatWhatsAppPhoneForDisplay,
  resolveClientWaPhone,
  getClientQrPhoneContext,
};
