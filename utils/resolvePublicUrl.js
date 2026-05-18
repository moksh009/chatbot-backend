"use strict";

/**
 * Turn /uploads/... or localhost dev URLs into a public HTTPS URL for Meta WhatsApp media.
 */
function resolvePublicMediaUrl(url) {
  const raw = String(url || "").trim();
  if (!raw || raw.includes("{{")) return null;

  const base = String(
    process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || ""
  )
    .trim()
    .replace(/\/$/, "");

  if (/^https:\/\//i.test(raw) && !/localhost|127\.0\.0\.1/i.test(raw)) {
    return raw;
  }

  if (/localhost|127\.0\.0\.1/i.test(raw)) {
    if (!base) return null;
    const path = raw.replace(/^https?:\/\/[^/]+/i, "");
    return path ? `${base}${path.startsWith("/") ? path : `/${path}`}` : null;
  }

  if (raw.startsWith("/uploads/") || raw.startsWith("uploads/")) {
    if (!base) return null;
    return `${base}/${raw.replace(/^\//, "")}`;
  }

  if (/^http:\/\//i.test(raw) && !/localhost|127\.0\.0\.1/i.test(raw)) {
    return raw;
  }

  return null;
}

function isMetaSafeMediaUrl(url) {
  const resolved = resolvePublicMediaUrl(url);
  return !!resolved && /^https:\/\//i.test(resolved) && !/localhost|127\.0\.0\.1/i.test(resolved);
}

module.exports = { resolvePublicMediaUrl, isMetaSafeMediaUrl };
