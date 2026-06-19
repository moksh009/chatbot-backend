"use strict";

/**
 * WhatsApp install guide picker — category → product → formatted guide + video link.
 * Data: Client.productGuideLibrary (wizard + runtime).
 */

const Conversation = require("../../models/Conversation");
const WhatsApp = require("../meta/whatsapp");
const log = require("../core/logger")("InstallGuideFlow");
const { normalizeLibrary, countGuideReadyProducts } = require("./productGuideGenerator");

const MENU_BUTTON_ID = "guide_menu";
const LIST_MORE_ID = "guide_list_more";
const CAT_ROW_PREFIX = "guide_cat_";
const PROD_ROW_PREFIX = "guide_prod_";
const WA_TEXT_MAX = 4096;
const LIST_PAGE_SIZE = 8;

function resolveLibrary(client) {
  return normalizeLibrary(client?.productGuideLibrary || {});
}

function hasInstallGuideLibrary(client) {
  const lib = resolveLibrary(client);
  return countGuideReadyProducts(lib) > 0;
}

function encodeCatRowId(catId) {
  return `${CAT_ROW_PREFIX}${String(catId || "").slice(0, 80)}`;
}

function decodeCatRowId(rowId) {
  const raw = String(rowId || "");
  if (!raw.startsWith(CAT_ROW_PREFIX)) return "";
  return raw.slice(CAT_ROW_PREFIX.length);
}

function encodeProdRowId(productId) {
  return `${PROD_ROW_PREFIX}${Buffer.from(String(productId || ""), "utf8")
    .toString("base64url")
    .replace(/=/g, "")
    .slice(0, 120)}`;
}

function decodeProdRowId(rowId, products = []) {
  const raw = String(rowId || "");
  if (!raw.startsWith(PROD_ROW_PREFIX)) return "";
  const b64 = raw.slice(PROD_ROW_PREFIX.length);
  try {
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const decoded = Buffer.from(b64 + pad, "base64url").toString("utf8");
    if (decoded) return decoded;
  } catch {
    /* fall through */
  }
  const suffix = raw.slice(PROD_ROW_PREFIX.length);
  const match = products.find((p) => String(p.productId) === suffix);
  return match ? match.productId : suffix;
}

function isMenuSelection({ buttonId, buttonTitle, userText }) {
  const id = String(buttonId || "").toLowerCase();
  const title = String(buttonTitle || "").toLowerCase().trim();
  const text = String(userText || "").toLowerCase().trim();
  return (
    id === MENU_BUTTON_ID ||
    id === "menu" ||
    id === "main_menu" ||
    title === "menu" ||
    text === "menu"
  );
}

function isListMoreSelection({ buttonId, buttonTitle }) {
  const id = String(buttonId || "").toLowerCase();
  const title = String(buttonTitle || "").toLowerCase().trim();
  return id === LIST_MORE_ID || title.includes("more");
}

function categoriesWithGuides(lib) {
  return (lib.categories || [])
    .map((c) => ({
      ...c,
      products: (c.products || []).filter((p) => {
        const g = p.installGuide || {};
        return g.summary || (g.steps && g.steps.length) || g.videoUrl || g.manualUrl;
      }),
    }))
    .filter((c) => c.products.length > 0);
}

async function sendText(client, phone, text) {
  const body = String(text || "");
  if (!body) return;
  if (body.length <= WA_TEXT_MAX) {
    await WhatsApp.sendText(client, phone, body);
    return;
  }
  let offset = 0;
  while (offset < body.length) {
    await WhatsApp.sendText(client, phone, body.slice(offset, offset + WA_TEXT_MAX));
    offset += WA_TEXT_MAX;
  }
}

function buildCategoryRows(categories, page = 0) {
  const start = page * LIST_PAGE_SIZE;
  const slice = categories.slice(start, start + LIST_PAGE_SIZE);
  const hasMore = start + LIST_PAGE_SIZE < categories.length;
  const rows = slice.map((c) => ({
    id: encodeCatRowId(c.id),
    title: String(c.label || c.id).substring(0, 24),
    description: `${c.products.length} product${c.products.length === 1 ? "" : "s"}`.substring(0, 72),
  }));
  if (hasMore) rows.push({ id: LIST_MORE_ID, title: "More categories" });
  rows.push({ id: MENU_BUTTON_ID, title: "Menu" });
  return rows;
}

function buildProductRows(products, page = 0) {
  const start = page * LIST_PAGE_SIZE;
  const slice = products.slice(start, start + LIST_PAGE_SIZE);
  const hasMore = start + LIST_PAGE_SIZE < products.length;
  const rows = slice.map((p) => ({
    id: encodeProdRowId(p.productId),
    title: String(p.title || "Product").substring(0, 24),
  }));
  if (hasMore) rows.push({ id: LIST_MORE_ID, title: "More products" });
  rows.push({ id: MENU_BUTTON_ID, title: "Menu" });
  return rows;
}

function formatGuideMessage(product) {
  const g = product?.installGuide || {};
  const lines = [`🔧 *${product?.title || "Product"} — Setup guide*`, ""];
  if (g.summary) lines.push(g.summary, "");
  (g.steps || []).forEach((step, i) => {
    if (step) lines.push(`${i + 1}. ${step}`);
  });
  if (g.videoUrl) lines.push("", `📺 Video: ${g.videoUrl}`);
  if (g.manualUrl) lines.push(`📄 Manual: ${g.manualUrl}`);
  const faqs = (g.faqs || []).slice(0, 2);
  if (faqs.length) {
    lines.push("");
    faqs.forEach((f) => {
      if (f.question && f.answer) lines.push(`❓ ${f.question}`, f.answer, "");
    });
  }
  lines.push("", "Reply *menu* anytime.");
  return lines.join("\n");
}

async function sendCategoryList(client, phone, categories, page = 0) {
  const rows = buildCategoryRows(categories, page);
  await WhatsApp.sendInteractive(
    client,
    phone,
    {
      type: "list",
      action: { button: "Choose category", sections: [{ title: "Categories", rows }] },
    },
    "🔧 *Installation help*\n\nWhich product category do you need setup help for?"
  );
}

async function sendProductList(client, phone, category, page = 0) {
  const rows = buildProductRows(category.products || [], page);
  await WhatsApp.sendInteractive(
    client,
    phone,
    {
      type: "list",
      action: { button: "Choose product", sections: [{ title: "Products", rows }] },
    },
    `Pick the product you need setup help for — *${category.label || "Category"}*`
  );
}

async function setGuideState(convoId, nodeId, patch = {}) {
  const setFields = {
    lastStepId: nodeId,
    lastInteraction: new Date(),
    status: "BOT_ACTIVE",
    ...patch,
  };
  await Conversation.findByIdAndUpdate(convoId, { $set: setFields });
  return setFields;
}

async function clearGuideState(convoId) {
  await Conversation.findByIdAndUpdate(convoId, {
    $unset: {
      "metadata._install_guide_phase": "",
      "metadata._install_guide_cat_id": "",
      "metadata._install_guide_list_page": "",
      "metadata.guide_products": "",
    },
  });
}

function isInstallGuideInteractionActive(convo) {
  return !!String(convo?.metadata?._install_guide_phase || "").trim();
}

function findInstallGuideOutputEdge(flowEdges, nodeId) {
  const out = (flowEdges || []).filter((e) => e.source === nodeId);
  return (
    out.find((e) => {
      const h = String(e.sourceHandle || "").toLowerCase();
      return !h || ["bottom", "output", "default", "a"].includes(h);
    }) || null
  );
}

async function runInstallGuideEntry({ nodeId, client, phone, convo }) {
  const lib = resolveLibrary(client);
  const categories = categoriesWithGuides(lib);

  if (!categories.length) {
    const fallback =
      String(client?.wizardFeatures?.installSupportPrompt || "").trim() ||
      "🔧 For setup help, share your *product name* and a short video or photo of the issue. Our team will guide you step by step.";
    await sendText(client, phone, fallback);
    return { phase: null, convoPatch: null };
  }

  await sendCategoryList(client, phone, categories, 0);
  const patch = await setGuideState(convo._id, nodeId || "install_guide_entry", {
    "metadata._install_guide_phase": "pick_category",
    "metadata._install_guide_list_page": 0,
  });
  return {
    phase: "pick_category",
    convoPatch: {
      metadata: {
        ...(convo.metadata || {}),
        _install_guide_phase: "pick_category",
        _install_guide_list_page: 0,
      },
      lastStepId: nodeId || "install_guide_entry",
      status: patch.status,
    },
  };
}

async function handleInstallGuideReply({
  nodeId,
  client,
  phone,
  convo,
  flowEdges,
  buttonId,
  buttonTitle,
  userText,
}) {
  const meta = convo?.metadata || {};
  const phase = String(meta._install_guide_phase || "");
  if (!phase) return { handled: false };

  const lib = resolveLibrary(client);
  const categories = categoriesWithGuides(lib);
  let listPage = Number(meta._install_guide_list_page) || 0;
  const guideNodeId = nodeId || convo?.lastStepId;

  if (isMenuSelection({ buttonId, buttonTitle, userText })) {
    await clearGuideState(convo._id);
    return { handled: true, advanceToNext: true };
  }

  if (phase === "pick_category") {
    if (isListMoreSelection({ buttonId, buttonTitle })) {
      listPage += 1;
      await sendCategoryList(client, phone, categories, listPage);
      await setGuideState(convo._id, guideNodeId, {
        "metadata._install_guide_phase": "pick_category",
        "metadata._install_guide_list_page": listPage,
      });
      return { handled: true, advanceToNext: false };
    }

    const catId = decodeCatRowId(buttonId);
    const category = categories.find((c) => String(c.id) === String(catId));
    if (!category) {
      await sendCategoryList(client, phone, categories, listPage);
      return { handled: true, advanceToNext: false };
    }

    await sendProductList(client, phone, category, 0);
    await setGuideState(convo._id, guideNodeId, {
      "metadata._install_guide_phase": "pick_product",
      "metadata._install_guide_cat_id": category.id,
      "metadata._install_guide_list_page": 0,
      "metadata.guide_products": category.products,
    });
    return { handled: true, advanceToNext: false };
  }

  if (phase === "pick_product") {
    const catId = meta._install_guide_cat_id;
    const category = categories.find((c) => String(c.id) === String(catId));
    const products = category?.products || meta.guide_products || [];

    if (isListMoreSelection({ buttonId, buttonTitle })) {
      listPage += 1;
      if (category) await sendProductList(client, phone, category, listPage);
      await setGuideState(convo._id, guideNodeId, {
        "metadata._install_guide_list_page": listPage,
      });
      return { handled: true, advanceToNext: false };
    }

    const prodId = decodeProdRowId(buttonId, products);
    const product = products.find((p) => String(p.productId) === String(prodId));
    if (!product) {
      if (category) await sendProductList(client, phone, category, listPage);
      return { handled: true, advanceToNext: false };
    }

    await sendText(client, phone, formatGuideMessage(product));
    await setGuideState(convo._id, guideNodeId, {
      "metadata._install_guide_phase": "awaiting_menu",
    });
    return { handled: true, advanceToNext: false };
  }

  if (phase === "awaiting_menu") {
    if (isMenuSelection({ buttonId, buttonTitle, userText })) {
      await clearGuideState(convo._id);
      return { handled: true, advanceToNext: true };
    }
    return { handled: true, advanceToNext: false };
  }

  return { handled: false };
}

module.exports = {
  hasInstallGuideLibrary,
  isInstallGuideInteractionActive,
  runInstallGuideEntry,
  handleInstallGuideReply,
  findInstallGuideOutputEdge,
  formatGuideMessage,
  categoriesWithGuides,
};
