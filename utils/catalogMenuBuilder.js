"use strict";

/**
 * WhatsApp interactive list limits + overflow menu for large Shopify/Meta catalogs.
 * Page 1: up to 9 collections + "More categories" row when needed.
 * Page 2: remaining collections (up to 10 per message).
 */

const MAX_EXPLORE_MENU_ROWS = 10;
const PRIMARY_WITH_OVERFLOW_SLOTS = 9;
const MORE_ROW_ID = "cat_more_ranges";
const TOP_SECTION = "Top picks";
const MORE_SECTION = "More ranges";
const OVERFLOW_PAGE_TITLE = "More categories";

function truncate(s, max = 24) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 8 ? cut.slice(0, sp) : cut.slice(0, max - 1)).trim();
}

function isBestsellerCollection(col) {
  const t = String(col.title || col.whatsappMenuLabel || "").toLowerCase();
  return t.includes("best seller") || t.includes("bestseller") || t.includes("top seller");
}

function sortCollectionsForMenu(collections) {
  return [...collections].sort((a, b) => {
    const aBs = isBestsellerCollection(a);
    const bBs = isBestsellerCollection(b);
    if (aBs && !bBs) return -1;
    if (!aBs && bBs) return 1;
    return (b.productsCount || 0) - (a.productsCount || 0);
  });
}

function menuLabelForCollection(col) {
  let raw = String(col.whatsappMenuLabel || col.title || "Products").trim();
  if (isBestsellerCollection(col) && !raw.startsWith("🔥")) raw = `🔥 ${raw}`;
  return truncate(raw, 24);
}

function collectionToRow(col) {
  return {
    id: `collection_${col.shopifyCollectionId}`,
    title: menuLabelForCollection(col),
    description: truncate("Tap to browse", 72),
    collectionId: col.shopifyCollectionId,
  };
}

function buildTwoSectionMenuFromRows(rows) {
  return [
    { title: truncate(TOP_SECTION, 24), rows: rows.slice(0, 5) },
    { title: truncate(MORE_SECTION, 24), rows: rows.slice(5, MAX_EXPLORE_MENU_ROWS) },
  ].filter((s) => s.rows.length > 0);
}

/**
 * @param {Array<{ shopifyCollectionId, title, whatsappMenuLabel?, productsCount? }>} collections
 */
function splitCollectionsForWhatsAppMenu(collections) {
  const sorted = sortCollectionsForMenu(collections || []);
  if (sorted.length <= MAX_EXPLORE_MENU_ROWS) {
    const rows = sorted.map(collectionToRow);
    return {
      sorted,
      primary: sorted,
      overflow: [],
      hasOverflow: false,
      primarySections: buildTwoSectionMenuFromRows(rows),
      overflowSections: [],
      moreRowId: null,
      allCollections: sorted,
    };
  }

  const primary = sorted.slice(0, PRIMARY_WITH_OVERFLOW_SLOTS);
  const overflow = sorted.slice(PRIMARY_WITH_OVERFLOW_SLOTS);
  const primaryRows = [
    ...primary.map(collectionToRow),
    {
      id: MORE_ROW_ID,
      title: truncate("More categories", 24),
      description: truncate(`${overflow.length} more range${overflow.length === 1 ? "" : "s"}`, 72),
    },
  ];
  const overflowRows = overflow.slice(0, MAX_EXPLORE_MENU_ROWS).map(collectionToRow);

  return {
    sorted,
    primary,
    overflow,
    hasOverflow: true,
    primarySections: buildTwoSectionMenuFromRows(primaryRows),
    overflowSections: buildTwoSectionMenuFromRows(overflowRows),
    moreRowId: MORE_ROW_ID,
    allCollections: sorted,
  };
}

module.exports = {
  MAX_EXPLORE_MENU_ROWS,
  PRIMARY_WITH_OVERFLOW_SLOTS,
  MORE_ROW_ID,
  TOP_SECTION,
  MORE_SECTION,
  OVERFLOW_PAGE_TITLE,
  truncate,
  menuLabelForCollection,
  sortCollectionsForMenu,
  collectionToRow,
  buildTwoSectionMenuFromRows,
  splitCollectionsForWhatsAppMenu,
};
