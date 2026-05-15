"use strict";

const log = require("./logger")("WarrantyPdf");

/**
 * Send warranty certificate to customer. Tries document send when a public URL exists;
 * otherwise sends a text summary (never fails silently).
 */
async function sendWarrantyCertificate(client, phone, meta = {}) {
  const WhatsApp = require("./whatsapp");
  const product = meta._warranty_product_name || meta._warranty_product || "your product";
  const expires = meta._warranty_expires_display || meta._warranty_expires_at || "";
  const orderRef = meta._warranty_order_ref || "";
  const branch = meta._warranty_branch || "active";

  const text =
    branch === "active"
      ? `📄 *Warranty certificate*\n\nProduct: *${product}*\n` +
        (orderRef ? `Order: ${orderRef}\n` : "") +
        (expires ? `Valid until: *${expires}*\n` : "") +
        `\nYour warranty is active. Keep this message for your records.`
      : `📄 *Warranty*\n\n${meta._warranty_summary || "We could not generate a certificate for this lookup. Our team can resend details on request."}`;

  const pdfUrl = String(meta.warranty_pdf_link || meta._warranty_pdf_url || "").trim();
  if (pdfUrl && pdfUrl.startsWith("http")) {
    try {
      await WhatsApp.sendDocument(
        client,
        phone,
        pdfUrl,
        `Warranty_${String(orderRef || "certificate").replace(/#/g, "")}.pdf`
      );
      await WhatsApp.sendText(client, phone, text.slice(0, 900));
      return { ok: true, mode: "document" };
    } catch (docErr) {
      log.warn(`[WarrantyPdf] document send failed: ${docErr.message}`);
    }
  }

  await WhatsApp.sendText(client, phone, text);
  return { ok: true, mode: "text" };
}

module.exports = { sendWarrantyCertificate };
