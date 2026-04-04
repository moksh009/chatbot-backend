"use strict";

const QRCodeModel = require("../models/QRCode");
const QRCodeLib   = require("qrcode");
const crypto      = require("crypto");
const Client      = require("../models/Client");

/**
 * Generate a unique 8-char short code: QR_A1B2C3D4
 */
function generateShortCode() {
  return "QR_" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/**
 * Generate a base64 PNG data URL from a text string (WA deep link)
 */
async function generateQRImage(text) {
  return await QRCodeLib.toDataURL(text, {
    errorCorrectionLevel: "H",
    type:                 "image/png",
    width:                512,
    margin:               2,
    color: {
      dark:  "#000000",
      light: "#FFFFFF"
    }
  });
}

/**
 * Create and persist a QR code record.
 * @param {Object} client  - Client mongoose document
 * @param {Object} qrData  - { name, type, config, expiresAt }
 * @returns {Object}       - Saved QRCode document
 */
async function createQRCode(client, qrData) {
  // Ensure uniqueness (retry up to 5 times)
  let shortCode, existing;
  let attempts = 0;
  do {
    shortCode = generateShortCode();
    existing  = await QRCodeModel.findOne({ shortCode });
    attempts++;
  } while (existing && attempts < 5);

  // Build WA deep link using the client's phone number
  const phone  = (client.adminPhone || "").replace(/\D/g, "");
  const waLink = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(shortCode)}`
    : `https://wa.me/?text=${encodeURIComponent(shortCode)}`;

  const qrImage = await generateQRImage(waLink);

  const qr = await QRCodeModel.create({
    clientId:   client._id,
    name:       qrData.name,
    shortCode,
    type:       qrData.type || "flow",
    isActive:   true,
    config:     qrData.config || {},
    waLink,
    qrImageUrl: qrImage,
    createdAt:  new Date(),
    expiresAt:  qrData.expiresAt || null
  });

  return qr;
}

module.exports = { createQRCode, generateQRImage, generateShortCode };
