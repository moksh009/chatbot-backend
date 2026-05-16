"use strict";

let mjmlCompile = null;

function getMjmlCompiler() {
  if (mjmlCompile) return mjmlCompile;
  try {
    const mjml2html = require("mjml");
    mjmlCompile = (mjmlSource) => {
      const { html, errors } = mjml2html(mjmlSource, { validationLevel: "soft", minify: false });
      if (errors?.length) {
        console.warn("[MJML] compile warnings:", errors.map((e) => e.message).join("; "));
      }
      return html;
    };
    return mjmlCompile;
  } catch (e) {
    console.warn("[MJML] mjml package not installed — using plain HTML fallback");
    return null;
  }
}

/**
 * Render a branded transactional email from MJML (or simple HTML fallback).
 */
function renderBrandedEmail({ brandName = "TopEdge", title, bodyHtml, ctaUrl, ctaLabel }) {
  const compile = getMjmlCompiler();
  const safeBrand = String(brandName || "Store").replace(/</g, "");
  const safeTitle = String(title || "Notification").replace(/</g, "");
  const body = String(bodyHtml || "Hello,").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (!compile) {
    return `<!DOCTYPE html><html><body style="font-family:Inter,sans-serif;padding:24px;background:#f8fafc">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e2e8f0">
        <h1 style="color:#7c3aed;font-size:20px">${safeBrand}</h1>
        <h2 style="color:#0f172a">${safeTitle}</h2>
        <p style="color:#475569;line-height:1.6">${body}</p>
        ${ctaUrl ? `<p><a href="${ctaUrl}" style="display:inline-block;padding:12px 20px;background:#7c3aed;color:#fff;border-radius:12px;text-decoration:none">${ctaLabel || "View"}</a></p>` : ""}
      </div></body></html>`;
  }

  const ctaBlock = ctaUrl
    ? `<mj-button background-color="#7c3aed" border-radius="12px" font-weight="600" href="${ctaUrl}">${ctaLabel || "View details"}</mj-button>`
    : "";

  const mjml = `
<mjml>
  <mj-head>
    <mj-title>${safeTitle}</mj-title>
    <mj-attributes>
      <mj-all font-family="Inter, Helvetica, Arial, sans-serif" />
      <mj-text color="#475569" line-height="1.6" font-size="15px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f1f5f9">
    <mj-section padding="24px 16px">
      <mj-column background-color="#ffffff" border-radius="16px" border="1px solid #e2e8f0" padding="32px 28px">
        <mj-text font-size="11px" font-weight="700" color="#7c3aed" text-transform="uppercase" letter-spacing="2px">${safeBrand}</mj-text>
        <mj-text font-size="22px" font-weight="800" color="#0f172a" padding-top="8px">${safeTitle}</mj-text>
        <mj-text padding-top="16px">${body}</mj-text>
        ${ctaBlock}
        <mj-text font-size="11px" color="#94a3b8" padding-top="24px">Sent via TopEdge AI</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

  return compile(mjml);
}

module.exports = { renderBrandedEmail, getMjmlCompiler };
