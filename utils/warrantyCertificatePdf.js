"use strict";

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const WARRANTY_DIR = path.join(__dirname, "..", "uploads", "warranty");
if (!fs.existsSync(WARRANTY_DIR)) {
  fs.mkdirSync(WARRANTY_DIR, { recursive: true });
}

function publicBaseUrl() {
  return String(
    process.env.BACKEND_URL ||
      process.env.PUBLIC_APP_URL ||
      process.env.APP_BASE_URL ||
      process.env.SERVER_URL ||
      ""
  ).replace(/\/$/, "");
}

/**
 * Build a simple warranty certificate PDF; returns { filePath, publicUrl, filename }.
 */
async function generateWarrantyCertificatePdf(client, record = {}) {
  const clientId = String(client?.clientId || "tenant").replace(/[^a-z0-9_-]/gi, "_");
  const stamp = Date.now();
  const filename = `warranty_${clientId}_${stamp}.pdf`;
  const filePath = path.join(WARRANTY_DIR, filename);

  const brand = client.brand?.businessName || client.businessName || client.name || "Store";
  const product = record.productName || record._warranty_product_name || "Product";
  const orderRef = record.orderRef || record._warranty_order_ref || record.orderId || "—";
  const purchase =
    record.purchaseDateDisplay ||
    (record.purchaseDate ? new Date(record.purchaseDate).toLocaleDateString("en-IN") : "—");
  const expires =
    record.expiresDisplay ||
    record._warranty_expires_display ||
    (record.expiryDate ? new Date(record.expiryDate).toLocaleDateString("en-IN") : "—");
  const customer = record.customerName || "Customer";
  const serial = record.serialNumber || record.serial || "—";

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.rect(0, 0, doc.page.width, 120).fill("#0f172a");
    doc.fillColor("#ffffff").fontSize(20).font("Helvetica-Bold").text("Warranty Certificate", 48, 42);
    doc.fontSize(10).font("Helvetica").text(brand, 48, 72);
    doc.fillColor("#0f172a").fontSize(12).text(`This certifies that *${customer}* is covered for:`, 48, 140);
    doc.font("Helvetica-Bold").fontSize(14).text(product, 48, 162);
    doc.font("Helvetica").fontSize(11);
    let y = 200;
    const lines = [
      ["Order reference", orderRef],
      ["Serial / ID", serial],
      ["Purchase date", purchase],
      ["Warranty valid until", expires],
      ["Issued by", brand],
    ];
    lines.forEach(([label, val]) => {
      doc.font("Helvetica-Bold").text(`${label}:`, 48, y, { continued: true });
      doc.font("Helvetica").text(` ${val}`);
      y += 22;
    });
    doc.fontSize(9).fillColor("#64748b").text(
      "Keep this document for service claims. For support, contact the store on WhatsApp.",
      48,
      y + 24,
      { width: doc.page.width - 96 }
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
