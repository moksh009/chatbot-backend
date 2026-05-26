"use strict";

/**
 * Canonical canvas layout taxonomy for all tenants (SaaS).
 * Sidebar list folders (Client.flowFolders / flow.folderId) are separate from
 * in-canvas layout sections (parentId + type folder).
 */

const LAYOUT_SPEC_VERSION = "v1";

/** @typedef {{ key: string, label: string, color: string, childHint: string, position: { x: number, y: number } }} LayoutSectionSpec */

/** @type {LayoutSectionSpec[]} */
const FLOW_LAYOUT_SECTIONS = [
  {
    key: "entry",
    label: "🏠 Entry & menus",
    color: "indigo",
    childHint: "Triggers · welcome · hub menu",
    position: { x: 80, y: 40 },
  },
  {
    key: "catalog",
    label: "🛍️ Catalog & checkout",
    color: "emerald",
    childHint: "Browse · MPM · cart · address",
    position: { x: 720, y: 40 },
  },
  {
    key: "orders",
    label: "📦 Orders & fulfillment",
    color: "blue",
    childHint: "Track · status · cancel · Shopify",
    position: { x: 80, y: 420 },
  },
  {
    key: "returns",
    label: "↩️ Returns & refunds",
    color: "amber",
    childHint: "Return hub · refund check",
    position: { x: 720, y: 420 },
  },
  {
    key: "warranty",
    label: "🛡️ Warranty",
    color: "violet",
    childHint: "Lookup · claims · PDF",
    position: { x: 1360, y: 420 },
  },
  {
    key: "install",
    label: "🔧 Install & product help",
    color: "cyan",
    childHint: "Install guides · help desk",
    position: { x: 80, y: 800 },
  },
  {
    key: "support",
    label: "🎧 Support & FAQ",
    color: "rose",
    childHint: "Live chat · schedule · FAQ",
    position: { x: 1360, y: 40 },
  },
  {
    key: "automation",
    label: "⚡ Automations",
    color: "orange",
    childHint: "Cart · COD · reviews · webhooks",
    position: { x: 1360, y: 800 },
  },
  {
    key: "ai",
    label: "🤖 AI fallback",
    color: "slate",
    childHint: "AI capture · escalate",
    position: { x: 720, y: 1160 },
  },
  {
    key: "misc",
    label: "📎 Other steps",
    color: "gray",
    childHint: "Uncategorized builder steps",
    position: { x: 80, y: 1520 },
  },
];

const SECTION_KEYS = new Set(FLOW_LAYOUT_SECTIONS.map((s) => s.key));
const SECTION_BY_KEY = Object.fromEntries(FLOW_LAYOUT_SECTIONS.map((s) => [s.key, s]));
const LAYOUT_FOLDER_PREFIX = "f_layout_";

function layoutFolderId(sectionKey) {
  return `${LAYOUT_FOLDER_PREFIX}${sectionKey}`;
}

function normalizeLayoutSection(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return SECTION_KEYS.has(key) ? key : null;
}

module.exports = {
  LAYOUT_SPEC_VERSION,
  FLOW_LAYOUT_SECTIONS,
  SECTION_KEYS,
  SECTION_BY_KEY,
  LAYOUT_FOLDER_PREFIX,
  layoutFolderId,
  normalizeLayoutSection,
};
