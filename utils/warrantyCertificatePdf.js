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
const VIOLET_LIGHT = "#c4b5fd";
const INK = "#0f172a";
const MUTED = "#64748b";
const PAGE_W = 595.28;
const PAGE_H = 841.89;

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

function drawGradientFrame(doc, x, y, w, h) {
  doc.save();
  doc.lineWidth(4);
  doc.roundedRect(x, y, w, h, 8).strokeColor(VIOLET_LIGHT).stroke();
  doc.roundedRect(x + 3, y + 3, w - 6, h - 6, 6).strokeColor(VIOLET).stroke();
  doc.restore();
}

/**
 * Premium A4 portrait warranty certificate PDF — aligned with dashboard HTML export.
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

  const margin = 36;
  const frameX = margin;
  const frameY = margin;
  const frameW = PAGE_W - margin * 2;
  const frameH = PAGE_H - margin * 2;
  const pad = 28;
  const innerX = frameX + pad;
  const innerY = frameY + pad;
  const innerW = frameW - pad * 2;

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.rect(0, 0, PAGE_W, PAGE_H).fill("#f5f3ff");
    drawGradientFrame(doc, frameX, frameY, frameW, frameH);
    doc.roundedRect(frameX + 6, frameY + 6, frameW - 12, frameH - 12, 6).fill("#ffffff");

    doc.save();
    doc.rect(innerX, innerY, innerW, 5).fill(VIOLET);
    doc.restore();

    let y = innerY + 22;

    doc.fillColor(VIOLET_DARK).fontSize(9).font("Helvetica-Bold").text(brand.toUpperCase(), innerX, y, {
      width: innerW,
      align: "right",
    });
    doc.fillColor(VIOLET).fontSize(8).font("Helvetica").text(`Certificate № ${orderRef}`, innerX, y + 12, {
      width: innerW,
      align: "right",
    });

    const badgeY = y + 26;
    doc.roundedRect(innerX + innerW - 118, badgeY, 108, 18, 9).fill("#ecfdf5");
    doc.fillColor("#047857").fontSize(7).font("Helvetica-Bold").text("ACTIVE PROTECTION", innerX + innerW - 110, badgeY + 5, {
      width: 92,
      align: "center",
    });

    y = innerY + 78;
    doc.circle(innerX + innerW / 2, y + 18, 22).fill("#faf5ff").strokeColor(VIOLET_LIGHT).lineWidth(1);
    doc.circle(innerX + innerW / 2, y + 18, 14).strokeColor(VIOLET).lineWidth(0.8);
    doc.fillColor(VIOLET).fontSize(10).font("Helvetica-Bold").text("W", innerX + innerW / 2 - 5, y + 12);

    y += 52;
    doc.fillColor(VIOLET_DARK).fontSize(28).font("Helvetica-BoldOblique").text("Certificate of Warranty", innerX, y, {
      width: innerW,
      align: "center",
    });
    y += 34;
    doc.fillColor(VIOLET).fontSize(7).font("Helvetica-Bold").text("OFFICIAL PROTECTION DOCUMENT", innerX, y, {
      width: innerW,
      align: "center",
      characterSpacing: 1.2,
    });
    y += 16;
    doc.moveTo(innerX + innerW / 2 - 50, y).lineTo(innerX + innerW / 2 + 50, y).lineWidth(2).strokeColor(VIOLET).stroke();
    y += 14;
    doc.fillColor(MUTED).fontSize(10).font("Helvetica").text(
      "This certifies that the product below is registered in our digital warranty program and remains eligible for support under your purchase terms.",
      innerX + 32,
      y,
      { width: innerW - 64, align: "center", lineGap: 3 }
    );

    y += 48;
    doc.roundedRect(innerX + 8, y, innerW - 16, 52, 6).fill("#faf5ff").strokeColor("#ede9fe").lineWidth(0.8);
    doc.fillColor(VIOLET).fontSize(7).font("Helvetica-Bold").text("PROTECTED PRODUCT", innerX + 18, y + 10);
    doc.fillColor(INK).fontSize(12).font("Helvetica-Bold").text(product, innerX + 18, y + 22, {
      width: innerW - 36,
    });
    doc.fillColor(MUTED).fontSize(8).font("Helvetica").text(`Order: ${orderRef}${serial ? `  ·  Serial: ${serial}` : ""}`, innerX + 18, y + 40);

    y += 64;
    const colW = (innerW - 24) / 2;
    doc.roundedRect(innerX + 8, y, colW, 48, 5).fill("#ffffff").strokeColor("#ede9fe").lineWidth(0.8);
    doc.fillColor(VIOLET).fontSize(7).font("Helvetica-Bold").text("CERTIFICATE HOLDER", innerX + 16, y + 8);
    doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(customer, innerX + 16, y + 20, { width: colW - 16 });
    if (phone) doc.fillColor(MUTED).fontSize(8).font("Helvetica").text(phone, innerX + 16, y + 36, { width: colW - 16 });

    doc.roundedRect(innerX + 16 + colW, y, colW, 48, 5).fill("#ffffff").strokeColor("#ede9fe").lineWidth(0.8);
    doc.fillColor(VIOLET).fontSize(7).font("Helvetica-Bold").text("ISSUED BY", innerX + 24 + colW, y + 8);
    doc.fillColor(INK).fontSize(11).font("Helvetica-Bold").text(brand, innerX + 24 + colW, y + 20, { width: colW - 16 });
    doc.fillColor(MUTED).fontSize(8).font("Helvetica").text("Digital warranty registry", innerX + 24 + colW, y + 36);

    y += 60;
    const thirdW = (innerW - 32) / 3;
    doc.roundedRect(innerX + 8, y, thirdW, 42, 5).fill("#f0fdf4").strokeColor("#a7f3d0").lineWidth(0.6);
    doc.fillColor("#059669").fontSize(7).font("Helvetica-Bold").text("COVERAGE STARTS", innerX + 14, y + 8);
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(purchase, innerX + 14, y + 22);

    doc.roundedRect(innerX + 12 + thirdW, y, thirdW, 42, 5).fill("#fff1f2").strokeColor("#fecdd3").lineWidth(0.6);
    doc.fillColor("#be123c").fontSize(7).font("Helvetica-Bold").text("VALID UNTIL", innerX + 18 + thirdW, y + 8);
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(expires, innerX + 18 + thirdW, y + 22);

    doc.fillColor(MUTED).fontSize(7).font("Helvetica").text("Authorized signature", innerX + 20 + thirdW * 2, y + 28, {
      width: thirdW - 8,
      align: "center",
    });
    doc.moveTo(innerX + 24 + thirdW * 2, y + 24).lineTo(innerX + 16 + thirdW * 3, y + 24).lineWidth(0.8).strokeColor(VIOLET_LIGHT).stroke();

    const footY = frameY + frameH - 42;
    doc.moveTo(innerX, footY).lineTo(innerX + innerW, footY).lineWidth(0.5).strokeColor("#ede9fe").stroke();
    doc.fillColor("#94a3b8").fontSize(7.5).font("Helvetica").text(
      `Digitally issued · Retain for warranty claims · ${brand}`,
      innerX,
      footY + 12,
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
