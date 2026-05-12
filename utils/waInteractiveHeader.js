/**
 * WhatsApp Cloud API: one optional header per interactive message — text | image | video | document.
 * Supports explicit listHeaderType / headerType plus legacy imageUrl + header text.
 *
 * @param {object} data — node.data (after variable injection when used from engine)
 * @returns {object|null} — header object for interactive.header, or null
 */
function buildInteractiveHeaderFromNodeData(data) {
  if (!data || typeof data !== "object") return null;

  const ht = String(data.listHeaderType || data.headerType || "").toLowerCase().trim();
  const img = String(data.headerImageUrl || data.headerMediaUrl || data.imageUrl || "").trim();
  const vid = String(data.headerVideoUrl || "").trim();
  const doc = String(data.headerDocumentUrl || "").trim();
  const docNameRaw = String(data.headerDocumentFilename || "document.pdf").trim();
  const docName = docNameRaw.slice(0, 240) || "document.pdf";
  const txt = String(data.header || data.listHeaderText || "").trim();

  const imgSafe = img && !img.includes("{{") && /^https?:\/\//i.test(img);
  const vidSafe = vid && !vid.includes("{{") && /^https?:\/\//i.test(vid);
  const docSafe = doc && !doc.includes("{{") && /^https?:\/\//i.test(doc);

  if (ht === "none") return null;

  const clip = (s, n) => String(s || "").slice(0, n);

  if (ht === "video" && vidSafe) {
    return { type: "video", video: { link: clip(vid, 2048) } };
  }
  if (ht === "document" && docSafe) {
    return { type: "document", document: { link: clip(doc, 2048), filename: docName } };
  }
  if (ht === "image" && imgSafe) {
    return { type: "image", image: { link: clip(img, 2048) } };
  }
  if (ht === "text" && txt) {
    return { type: "text", text: clip(txt, 60) };
  }

  // Legacy / unset type: first non-empty wins (image > video > document > text)
  if (!ht) {
    if (imgSafe) return { type: "image", image: { link: clip(img, 2048) } };
    if (vidSafe) return { type: "video", video: { link: clip(vid, 2048) } };
    if (docSafe) return { type: "document", document: { link: clip(doc, 2048), filename: docName } };
    if (txt) return { type: "text", text: clip(txt, 60) };
  }

  return null;
}

module.exports = { buildInteractiveHeaderFromNodeData };
