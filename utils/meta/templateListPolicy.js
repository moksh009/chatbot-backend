"use strict";

function tplComp(components, type) {
  const arr = Array.isArray(components) ? components : [];
  return arr.find((c) => String(c?.type || "").toUpperCase() === type);
}

function isProductTemplate(tpl) {
  if (!tpl) return false;
  const name = String(tpl.name || "").toLowerCase();
  if (name.startsWith("prod_")) return true;
  if (tpl.templateKind === "product") return true;
  const src = String(tpl.source || "").toLowerCase();
  if (src === "wizard_product") return true;
  if (tpl.autoGenProductId && tpl.templateKind !== "prebuilt" && !tpl.isPrebuilt) return true;
  return false;
}

function getTemplateBodyText(tpl) {
  if (!tpl) return "";
  const bodyComp = tplComp(tpl.components, "BODY");
  if (bodyComp?.text && String(bodyComp.text).trim()) return String(bodyComp.text).trim();
  const fd = tpl.formData;
  if (fd?.bodyText && String(fd.bodyText).trim()) return String(fd.bodyText).trim();
  if (tpl.body && String(tpl.body).trim()) return String(tpl.body).trim();
  return "";
}

function hasDisplayableContent(tpl) {
  if (isProductTemplate(tpl)) return false;
  const body = getTemplateBodyText(tpl);
  if (body.length >= 6) return true;
  const header = tplComp(tpl.components, "HEADER");
  if (header && String(header.format || "").toUpperCase() === "IMAGE") {
    const img =
      header._imageUrl ||
      header.example?.header_handle?.[0] ||
      header.example?.header_url?.[0] ||
      tpl.headerImageUrl;
    if (img && String(img).trim()) return true;
  }
  if (header?.text && String(header.text).trim().length >= 3) return true;
  return false;
}

function filterTemplatesForManagerList(list) {
  return (Array.isArray(list) ? list : []).filter(hasDisplayableContent);
}

module.exports = {
  isProductTemplate,
  getTemplateBodyText,
  hasDisplayableContent,
  filterTemplatesForManagerList,
};
