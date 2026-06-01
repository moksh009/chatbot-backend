"use strict";

/** Strip HTML tags and collapse whitespace for WhatsApp body text. */
function stripHtmlText(input) {
  if (!input) return "";
  return String(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { stripHtmlText };
