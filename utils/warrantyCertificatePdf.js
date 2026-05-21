"use strict";

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const WARRANTY_DIR = path.join(__dirname, "..", "uploads", "warranty");
if (!fs.existsSync(WARRANTY_DIR)) {
  fs.mkdirSync(WARRANTY_DIR, { recursive: true });
}

const VIOLET = "#7c3aed";
const VIOLET_DARK = "#4c1d95";
const INK = "#0f172a";
const MUTED = "#64748b";

function publicBaseUrl() {
  return String(
    process.env.BACKEND_URL ||
      process.env.PUBLIC_APP_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_BASE_URL ||
      process.env.SERVER_URL ||
      ""
  ).replace(/\/$/, "");
}

function formatDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Premium A4 warranty certificate PDF — aligned with dashboard HTML export.
 */
async function generateWarrantyCertificatePdf(client, record = {}) {
  const clientId = String(client?.clientId || "tenant").replace(/[^a-z0-9_-]/gi, "_");
  const stamp = Date.now();
  const filename = `warranty_${clientId}_${stamp}.pdf`;
  const filePath = path.join(WARRANTY_DIR, filename);

  const brand = client.brand?.businessName || client.businessName || client.name || "Store";
  const product = record.productName || record._warranty_product_name || "Product";
  const orderRef =
    record.orderRef || record.shopifyOrderId || record._warranty_order_ref || record.orderId || "—";
  const purchase =
    record.purchaseDateDisplay ||
    formatDate(record.purchaseDate || record._warranty_purchase_date);
  const expires =
    record.expiresDisplay ||
    record._warranty_expires_display ||
    formatDate(record.expiryDate || record._warranty_expiry);
  const customer = record.customerName || "Customer";
  const phone = record.customerPhone || record.phone || "";
  const serial = record.serialNumber || record.serial || "";

  const pageW = 595.28;
  const pageH = 841.89;
  const margin = 48;
  const innerX = margin + 14;
  const innerY = margin + 14;
  const innerW = pageW - (margin + 14) * 2;
  const innerH = pageH - (margin + 14) * 2;

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.rect(0, 0, pageW, pageH).fill("#faf5ff");
    doc.roundedRect(margin, margin, pageW - margin * 2, pageH - margin * 2, 16).lineWidth(3).strokeColor("#c4b5fd").stroke();
    doc.roundedRect(innerX, innerY, innerW, innerH, 12).fill("#ffffff");

    doc.save();
    doc.rect(innerX, innerY, innerW, 6).fill(VIOLET);
    doc.restore();

    let y = innerY + 28;
    doc.fillColor(VIOLET_DARK).fontSize(10).font("Helvetica-Bold").text(brand.toUpperCase(), innerX + innerW - 200, y, {
      width: 190,
      align: "right",
    });
    doc.fillColor(VIOLET).fontSize(9).font("Helvetica").text(`CERT-REF: ${orderRef}`, innerX + innerW - 200, y + 14, {
      width: 190,
      align: "right",
    });

    doc.roundedRect(innerX + 20, y + 32, 72, 22, 11).fill("#ecfdf5");
    doc.fillColor("#047857").fontSize(8).font("Helvetica-Bold").text("ACTIVE PROTECTION", innerX + 28, y + 39);

    y = innerY + 100;
    doc.fillColor(VIOLET_DARK).fontSize(32).font("Helvetica-BoldOblique").text("Certificate of Warranty", innerX, y, {
      width: innerW,
      align: "center",
    });
    y += 44;
    doc.moveTo(innerX + innerW / 2 - 40, y).lineTo(innerX + innerW / 2 + 40, y).lineWidth(3).strokeColor(VIOLET).stroke();
    y += 18;
    doc.fillColor(MUTED).fontSize(11).font("Helvetica").text(
      "This document certifies that the product identified below is registered under our official digital warranty program.",
      innerX + 40,
      y,
      { width: innerW - 80, align: "center", lineGap: 4 }
    );

    y += 52;
    doc.moveTo(innerX + 24, y).lineTo(innerX + innerW - 24, y).lineWidth(1).strokeColor("#ede9fe").stroke();
    y += 20;

    doc.fillColor(VIOLET).fontSize(8).font("Helvetica-Bold").text("PROTECTED ITEM", innerX + 28, y);
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(product, innerX + 28, y + 14, { width: innerW / 2 - 40 });
    doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(`Order: ${orderRef}`, innerX + 28, y + 34);
    if (serial) doc.text(`Serial: ${serial}`, innerX + 28, y + 48);

    doc.fillColor(VIOLET).fontSize(8).font("Helvetica-Bold").text("CERTIFICATE HOLDER", innerX + innerW / 2 + 12, y, {
      width: innerW / 2 - 40,
      align: "right",
    });
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(customer, innerX + innerW / 2 + 12, y + 14, {
      width: innerW / 2 - 40,
      align: "right",
    });
    if (phone) {
      doc.fillColor(MUTED).fontSize(9).font("Helvetica").text(phone, innerX + innerW / 2 + 12, y + 34, {
        width: innerW / 2 - 40,
        align: "right",
      });
    }

    y += 78;
    doc.moveTo(innerX + 24, y).lineTo(innerX + innerW - 24, y).lineWidth(1).strokeColor("#ede9fe").stroke();
    y += 22;

    doc.fillColor("#059669").fontSize(8).font("Helvetica-Bold").text("ISSUE DATE", innerX + 28, y);
    doc.fillColor(INK).fontSize(14).font("Helvetica-Bold").text(purchase, innerX + 28, y + 12);

    doc.fillColor("#be123c").fontSize(8).font("Helvetica-Bold").text("VALID UNTIL", innerX + 28, y + 44);
    doc.fillColor(INK).fontSize(14).font("Helvetica-Bold").text(expires, innerX + 28, y + 56);

    doc.fillColor(MUTED).fontSize(8).font("Helvetica").text("Authorized signature", innerX + innerW - 180, y + 52, {
      width: 160,
      align: "center",
    });
    doc.moveTo(innerX + innerW - 170, y + 48).lineTo(innerX + innerW - 30, y + 48).lineWidth(1).strokeColor("#c4b5fd").stroke();

    y = innerY + innerH - 36;
    doc.fillColor("#94a3b8").fontSize(8).font("Helvetica").text(
      `Digitally issued · ${brand} · Retain for warranty claims`,
      innerX,
      y,
      { width: innerW, align: "center" }
    );

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  const base = publicBaseUrl();
  const publicUrl = base ? `${base}/uploads/warranty/${filename}` : `/uploads/warranty/${filename}`;
  return { filePath, publicUrl, filename };
}

module.exports = { generateWarrantyCertificatePdf, WARRANTY_DIR };
