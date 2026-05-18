"use strict";

const { resolvePublicMediaUrl, isMetaSafeMediaUrl } = require("./resolvePublicUrl");

function getPublicBaseUrl() {
  return String(
    process.env.PUBLIC_BASE_URL ||
      process.env.PUBLIC_WEBHOOK_BASE_URL ||
      process.env.SERVER_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      ""
  )
    .trim()
    .replace(/\/$/, "");
}

/**
 * Normalize logo / header image URLs for WhatsApp (HTTPS, no localhost).
 */
function sanitizeInteractiveImageUrl(url) {
  const resolved = resolvePublicMediaUrl(url);
  if (resolved && isMetaSafeMediaUrl(resolved)) return resolved;
  const raw = String(url || "").trim();
  if (!raw || /^data:/i.test(raw)) return "";
  if (/localhost|127\.0\.0\.1/i.test(raw)) {
    const path = raw.replace(/^https?:\/\/[^/]+/i, "");
    const base = getPublicBaseUrl();
    if (base && path.startsWith("/uploads/")) {
      const fixed = `${base}${path}`;
      return isMetaSafeMediaUrl(fixed) ? fixed : "";
    }
    return "";
  }
  if (raw.startsWith("/uploads/")) {
    const base = getPublicBaseUrl();
    const fixed = base ? `${base}${raw}` : "";
    return isMetaSafeMediaUrl(fixed) ? fixed : "";
  }
  return isMetaSafeMediaUrl(raw) ? raw : "";
}

const MEDIA_KEYS = [
  "imageUrl",
  "headerImageUrl",
  "headerMediaUrl",
  "headerVideoUrl",
  "headerDocumentUrl",
  "mpmHeaderImage",
];

/**
 * Fix media fields on a flow node.data object (after variable injection).
 */
function sanitizeNodeMediaData(data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };

  for (const key of MEDIA_KEYS) {
    if (out[key]) {
      const clean = sanitizeInteractiveImageUrl(out[key]);
      if (clean) out[key] = clean;
      else delete out[key];
    }
  }

  const safeLogo = sanitizeInteractiveImageUrl(
    out.headerImageUrl || out.imageUrl || out.headerMediaUrl || ""
  );
  if (safeLogo) {
    out.headerImageUrl = safeLogo;
    out.imageUrl = safeLogo;
    if (!out.listHeaderType && !out.headerType) {
      out.listHeaderType = "image";
    }
  } else if (out.listHeaderType === "image" || out.headerType === "image") {
    out.listHeaderType = "none";
    out.headerType = "none";
    delete out.headerImageUrl;
    delete out.imageUrl;
  }

  return out;
}

function sanitizeFlowNodesMedia(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node?.data) return node;
    return { ...node, data: sanitizeNodeMediaData(node.data) };
  });
}

/**
 * Strip or fix interactive.header before Meta API send.
 */
function sanitizeInteractivePayload(interactive) {
  if (!interactive?.header) return interactive;

  const h = interactive.header;
  if (h.type === "image" && h.image?.link) {
    const safe = sanitizeInteractiveImageUrl(h.image.link);
    if (!safe) delete interactive.header;
    else interactive.header = { type: "image", image: { link: safe } };
  } else if (h.type === "video" && h.video?.link) {
    const safe = sanitizeInteractiveImageUrl(h.video.link);
    if (!safe) delete interactive.header;
    else interactive.header = { type: "video", video: { link: safe } };
  } else if (h.type === "text") {
    const text = String(h.text || "").trim();
    if (!text) delete interactive.header;
    else interactive.header = { type: "text", text: text.slice(0, 60) };
  } else if (!h.type) {
    delete interactive.header;
  }

  return interactive;
}

module.exports = {
  sanitizeInteractiveImageUrl,
  sanitizeNodeMediaData,
  sanitizeFlowNodesMedia,
  sanitizeInteractivePayload,
  getPublicBaseUrl,
};
