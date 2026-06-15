"use strict";

const QRCodeModel = require("../../models/QRCode");
const QRCodeLib   = require("qrcode");
const crypto      = require("crypto");
const { resolveClientWaPhone } = require("./qrClientScope");

/**
 * Generate a unique 8-char short code: QR_A1B2C3D4
 */
function generateShortCode() {
  return "QR_" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/**
 * Generate a base64 PNG data URL from a text string (WA deep link)
 */
async function generateQRImage(text, fgColor = "#000000", bgColor = "#FFFFFF") {
  return await QRCodeLib.toDataURL(text, {
    errorCorrectionLevel: "H",
    type:                 "image/png",
    width:                512,
    margin:               2,
    color: {
      dark:  fgColor,
      light: bgColor
    }
  });
}

function buildWaLink(client, shortCode, config = {}) {
  const phone = resolveClientWaPhone(client);
  const customText = config?.prefilledText
    ? `${config.prefilledText} (Ref: ${shortCode})`
    : `Hi! I'd like to connect. (Ref: ${shortCode})`;

  return phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(customText)}`
    : `https://wa.me/?text=${encodeURIComponent(customText)}`;
}

/**
 * Create and persist a QR code record.
 * @param {Object} client  - Client mongoose document
 * @param {Object} qrData  - { name, type, config, expiresAt }
 * @returns {Object}       - Saved QRCode document
 */
async function createQRCode(client, qrData) {
  let shortCode;
  let existing;
  let attempts = 0;
  do {
    shortCode = generateShortCode();
    existing  = await QRCodeModel.findOne({ shortCode });
    attempts++;
  } while (existing && attempts < 5);

  const config = qrData.config || {};
  const waLink = buildWaLink(client, shortCode, config);
  const fgColor = config?.styleConfig?.fgColor || "#000000";
  const bgColor = config?.styleConfig?.bgColor || "#FFFFFF";
  const qrImage = await generateQRImage(waLink, fgColor, bgColor);

  const qr = await QRCodeModel.create({
    clientId:   String(client.clientId),
    name:       qrData.name,
    shortCode,
    type:       qrData.type || "flow",
    isActive:   true,
    config,
    waLink,
    qrImageUrl: qrImage,
    createdAt:  new Date(),
    expiresAt:  qrData.expiresAt || null
  });

  return qr;
}

/**
 * Regenerate wa.me link + PNG when config or phone changes.
 */
async function refreshQRCodeAssets(client, qr) {
  const config = qr.config || {};
  const waLink = buildWaLink(client, qr.shortCode, config);
  const fgColor = config?.styleConfig?.fgColor || "#000000";
  const bgColor = config?.styleConfig?.bgColor || "#FFFFFF";
  const qrImage = await generateQRImage(waLink, fgColor, bgColor);
  qr.waLink = waLink;
  qr.qrImageUrl = qrImage;
  return qr;
}

module.exports = {
  createQRCode,
  generateQRImage,
  generateShortCode,
  buildWaLink,
  refreshQRCodeAssets,
};
