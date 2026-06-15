'use strict';

/**
 * Shared QR scan side-effects for wa.me ref text and bare QR_XXXXXXXX messages.
 */

async function recordQrScanStats(qrId, phone) {
  const QRScan = require('../../models/QRScan');
  const QRCode = require('../../models/QRCode');
  const isUnique = !(await QRScan.exists({ qrCodeId: qrId, phone }));
  await QRScan.findOneAndUpdate(
    { qrCodeId: qrId, phone },
    { $setOnInsert: { qrCodeId: qrId, phone, scannedAt: new Date() } },
    { upsert: true }
  );
  await QRCode.findByIdAndUpdate(qrId, {
    $inc: { scansTotal: 1, ...(isUnique ? { scansUnique: 1 } : {}) },
  });
  return { isUnique };
}

async function applyQrLeadEffects({ client, phone, lead, qr, shortCode, isUnique }) {
  const AdLead = require('../../models/AdLead');
  const tags = [...(qr.config?.tags || [])];
  if (qr.config?.utmSource) tags.push(`Source: ${qr.config.utmSource}`);
  tags.push(`qr:${qr.name || shortCode}`);
  tags.push(`Scanned_${shortCode}`);

  const leadFilter = lead?._id
    ? { _id: lead._id, clientId: client.clientId }
    : { phoneNumber: phone, clientId: client.clientId };

  const update = {
    $addToSet: { tags: { $each: [...new Set(tags.filter(Boolean))] } },
    $set: {
      'meta.lastQRCode': shortCode,
      'meta.lastQRCodeName': qr.name || shortCode,
    },
  };
  if (qr.config?.discountCode) {
    update.$set.activeDiscountCode = qr.config.discountCode;
  }
  await AdLead.findOneAndUpdate(leadFilter, update);

  try {
    const { fireWebhookEvent } = require('../core/webhookDelivery');
    fireWebhookEvent(client.clientId, 'qr.scanned', {
      phone,
      qrCode: qr.name,
      shortCode,
      isFirstScan: isUnique,
    });
  } catch (_) {
    /* optional */
  }
}

function extractQrShortCodeFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const refMatch = raw.match(/\(Ref:\s*(QR_[a-zA-Z0-9_]+)\)/i);
  if (refMatch?.[1]) return refMatch[1].toUpperCase();
  if (/^QR_[A-F0-9]{8}$/i.test(raw)) return raw.toUpperCase();
  return null;
}

async function maybeAttributeQrConversion(clientId, phone, leadDoc) {
  const shortCode = leadDoc?.meta?.lastQRCode;
  if (!shortCode || !phone) return false;

  const QRCode = require('../../models/QRCode');
  const QRScan = require('../../models/QRScan');
  const { qrClientIdFilter } = require('../core/qrClientScope');

  const qr = await QRCode.findOne({
    shortCode: String(shortCode).toUpperCase(),
    ...qrClientIdFilter({ clientId }),
  })
    .select('_id')
    .lean();
  if (!qr) return false;

  const scan = await QRScan.findOne({ qrCodeId: qr._id, phone }).select('scannedAt convertedAt').lean();
  if (!scan || scan.convertedAt) return false;

  const windowMs = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(scan.scannedAt).getTime() > windowMs) return false;

  await QRScan.updateOne({ qrCodeId: qr._id, phone }, { $set: { convertedAt: new Date() } });
  await QRCode.updateOne({ _id: qr._id }, { $inc: { conversions: 1 } });
  return true;
}

module.exports = {
  recordQrScanStats,
  applyQrLeadEffects,
  extractQrShortCodeFromText,
  maybeAttributeQrConversion,
};
