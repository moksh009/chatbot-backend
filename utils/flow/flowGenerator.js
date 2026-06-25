"use strict";

/**
 * FLOW GENERATOR — ZERO-TOUCH MODULAR EDITION v6.0
 * ─────────────────────────────────────────────────────────────────────────
 * Each feature lives in its own pure builder function. The orchestrator
 * reads `client.wizardFeatures.*` (canonical) merged with `wizardData.features`
 * (live wizard payload) and conditionally calls the builders. The main menu
 * rows are assembled dynamically from whichever branches are enabled, so a
 * merchant who toggles features OFF in Settings gets a flow with only enabled
 * branches — no orphan nodes, no dead edges.
 *
 * GUARANTEES
 *   • Deterministic node IDs   — `${prefix}_${clientSeed}` (no Date.now)
 *     → regenerating preserves `lastStepId` on active leads
 *   • No `undefined` IDs       — all keys declared up-front in `buildIDs()`
 *   • No silent dead branches  — every dead-end node fanned to AI fallback
 *   • Verified before return   — `verifyAllEdgesMatchButtonIds` + `verifyFlowIntegrity`
 *
 * EXECUTION CONTRACT (consumed by `utils/commerce/dualBrainEngine.js`)
 *   node.type ∈ { message | interactive | template | trigger | logic |
 *                 capture_input | shopify_call | delay | admin_alert | schedule |
 *                 review | cod_prepaid |
 *                 warranty_check | tag_lead | http_request }
 *   edge.{ id, source, target, sourceHandle? }
 *
 * @param {Object} client     - Mongoose Client doc
 * @param {Object} wizardData - Live wizard form payload (optional overrides)
 * @returns {{ nodes: Array, edges: Array }}
 */

const { generateJSON, generateText } = require('../core/gemini');
const { getCopyPack } = require('./copyPacks');

// ═════════════════════════════════════════════════════════════════════════
// 0. UTILITIES (kept stable from v5 — referenced elsewhere via require)
// ═════════════════════════════════════════════════════════════════════════

function buildProductContext(product, index) {
  const images   = Array.isArray(product.images) ? product.images : [];
  const altTexts = images.map(img => img?.alt).filter(Boolean).join(" ");
  const features = (altTexts || product.description || product.descriptionHtml || "").slice(0, 300);
  const rawName  = product.name || product.title || `Product ${index + 1}`;
  const rawCategory =
    product.category
    || product.productType
    || product.product_type
    || product.collection
    || product.vendor
    || "General";
  const handle   = product.handle
    || rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id:       product.shopifyId || product.id || `prod_${index}`,
    variantId:
      String(product.shopifyVariantId || product.variantId || product.variant_id || product.id || "").trim() || null,
    title:    rawName,
    price:    product.price || "0",
    imageUrl: product.imageUrl || (images[0]?.src || ""),
    handle,
    features,
    category: String(rawCategory || "General").trim() || "General",
  };
}

function stripPlaceholders(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/\[\d+\s*(minutes|mins|days|hours|hrs|pts|points|%)\]/gi, "")
    .replace(/\[X\]/gi, "")
    .replace(/\[YOUR[^\]]*\]/gi, "")
    .replace(/\[BRAND[^\]]*\]/gi, "")
    .replace(/\[INSERT[^\]]*\]/gi, "")
    .trim();
}

const { normalizeFlowNodes: normalizeFlowVariableTokens } = require('./normalizeFlowVariables');

function cleanNodeText(nodes) {
  const stripped = nodes.map(n => {
    if (!n.data) return n;
    if (typeof n.data.text === "string")     n.data.text = stripPlaceholders(n.data.text);
    if (typeof n.data.body === "string")     n.data.body = stripPlaceholders(n.data.body);
    if (typeof n.data.question === "string") n.data.question = stripPlaceholders(n.data.question);
    if (n.data.content && typeof n.data.content.body === "string") {
      n.data.content.body = stripPlaceholders(n.data.content.body);
    }
    if (Array.isArray(n.data.steps)) {
      n.data.steps = n.data.steps.map(s => ({ ...s, text: stripPlaceholders(s.text) }));
    }
    return n;
  });
  return normalizeFlowVariableTokens(stripped);
}

function verifyAllEdgesMatchButtonIds(nodes, edges) {
  const issues = [];
  nodes.forEach(node => {
    if (node.type !== "interactive" && node.type !== "template") return;
    const btns = node.data?.buttonsList || [];
    const rows = (node.data?.sections || []).flatMap(s => s.rows || []);
    const validIds = new Set([...btns, ...rows].map(b => String(b.id)));
    edges.filter(e => e.source === node.id && e.sourceHandle).forEach(edge => {
      const sh = String(edge.sourceHandle);
      if (!validIds.has(sh)) {
        issues.push(`[MISMATCH] Node "${node.id}" edge "${edge.id}" sourceHandle "${sh}" not in [${[...validIds].join(", ")}]`);
      }
    });
  });
  if (issues.length > 0) {
    console.error(`[FlowGenerator] ❌ button-ID mismatch (${issues.length}):\n${issues.join("\n")}`);
    throw new Error(`Flow integrity failed: ${issues.length} button-ID mismatch(es).`);
  }
  return true;
}

function verifyFlowIntegrity(nodes, edges) {
  const nodeIds = new Set(nodes.map(n => n.id));
  const issues  = [];
  const seen    = new Set();
  const PROHIBITED = ["waTemplates","shopifyProducts","teamMembers","availableTags","waFlows","allProducts","catalogItems"];
  nodes.forEach((n, i) => {
    if (!n.id) { issues.push(`Node[${i}] missing id`); return; }
    if (seen.has(n.id)) issues.push(`Duplicate node id: ${n.id}`);
    seen.add(n.id);
    PROHIBITED.forEach(key => {
      if (n.data && Array.isArray(n.data[key]) && n.data[key].length > 0) {
        issues.push(`Node ${n.id} has prohibited data.${key}`);
      }
    });
  });
  edges.forEach(e => {
    if (!e.id)     issues.push(`Edge missing id (source=${e.source}, target=${e.target})`);
    if (!e.source) issues.push(`Edge ${e.id} missing source`);
    if (!e.target) issues.push(`Edge ${e.id} missing target`);
    if (e.source && !nodeIds.has(e.source)) issues.push(`Edge ${e.id}: source "${e.source}" not in nodes`);
    if (e.target && !nodeIds.has(e.target)) issues.push(`Edge ${e.id}: target "${e.target}" not in nodes`);
  });
  if (issues.length > 0) {
    console.error(`[FlowGenerator] ❌ ${issues.length} integrity issue(s):\n${issues.slice(0, 15).join("\n")}`);
    return false;
  }
  console.log(`[FlowGenerator] ✅ Integrity OK — ${nodes.length} nodes, ${edges.length} edges`);
  return true;
}

const truncate = (str, max = 24) => {
  const v = String(str || "");
  return v.length > max ? `${v.slice(0, max - 3)}...` : v;
};

const CATALOG_TOP_SECTION = "⭐ Top picks";
const CATALOG_MORE_SECTION = "🛍️ More to explore";
const MAX_EXPLORE_MENU_ROWS = 10;

function normCollectionTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBestsellerCollection(col) {
  const t = normCollectionTitle(col?.title || col?.whatsappMenuLabel);
  return t.includes("best seller") || t.includes("bestseller") || t.includes("top seller");
}

function sortShopCollectionsForMenu(cols) {
  return [...cols].sort((a, b) => {
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

function buildExploreMenuSections(cols) {
  const rows = cols.slice(0, MAX_EXPLORE_MENU_ROWS).map((c) => ({
    id: `collection_${c.shopifyCollectionId}`,
    title: menuLabelForCollection(c),
    description: "Browse in WhatsApp",
  }));
  return [
    { title: truncate(CATALOG_TOP_SECTION, 24), rows: rows.slice(0, 5) },
    { title: truncate(CATALOG_MORE_SECTION, 24), rows: rows.slice(5, MAX_EXPLORE_MENU_ROWS) },
  ].filter((s) => s.rows.length > 0);
}

function resolveMpmTemplateName(client = {}, wizardData = {}) {
  const explicit = String(wizardData.mpmTemplateName || wizardData.metaTemplateName || "").trim();
  if (explicit) return explicit;
  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const approved = synced.filter((t) => String(t.status || "APPROVED").toUpperCase() === "APPROVED");
  const carousel = approved.find((t) => /carosuel|carousel|mpm/i.test(String(t.name || "")));
  return carousel?.name || approved[0]?.name || "";
}

/** Stable workspace id used in ShopifyCollection queries (matches `clientId` on synced docs). */
function resolvePersistedClientId(client) {
  if (!client) return "";
  const c = client.clientId ?? client.id;
  if (c != null && String(c).trim()) return String(c).trim();
  if (client._id != null) return String(client._id).trim();
  return "";
}

/** Main commerce graph: columns left→right, rows for parallel lanes (ReactFlow). */
function flowPos(col, row) {
  const DX = 400;
  const DY = 200;
  return { x: Math.round(40 + col * DX), y: Math.round(56 + row * DY) };
}

/** Main hub rows — max 8 (WhatsApp list cap). IDs match menu edge sourceHandles. */
function buildMainMenuRows(F) {
  const rows = [];
  if (F.enableCatalog) {
    rows.push({ id: "mnu_browse", title: "🛍️ Browse Products", description: "Shop our full collection" });
  }
  if (F.enableOrderTracking) {
    rows.push({ id: "mnu_track", title: "📦 Check Order Status", description: "View your latest order" });
  }
  if (F.enableCancelOrder) {
    rows.push({ id: "mnu_cancel", title: "✏️ Modify / Cancel Order", description: "Change or cancel an order" });
  }
  if (F.enableInstallSupport) {
    rows.push({ id: "mnu_help", title: "🤝 Order Help", description: "Delivery issues, returns & support" });
  }
  if (F.enableWarranty) {
    rows.push({ id: "mnu_warranty", title: "🛡️ Warranty & Repairs", description: "Coverage details & claims" });
  }
  if (F.enableAIFallback) {
    rows.push({ id: "mnu_ai", title: "💬 Quick Question", description: "Ask our bot anything" });
  }
  if (F.enableSupportEscalation) {
    rows.push({ id: "mnu_agent", title: "👤 Talk to Our Team", description: "Speak with a real person" });
  }
  if (!rows.length) {
    rows.push({ id: "mnu_menu", title: "📋 Main Menu", description: "Get started" });
  }
  return rows.slice(0, 8);
}

/** Automation triggers (cart / order / review) — isolated left stack, no overlap with hub. */
function autoPos(col, row) {
  const DX = 440;
  const DY = 200;
  return { x: Math.round(-760 + col * DX), y: Math.round(72 + row * DY) };
}

// Copy packs live in `utils/flow/copyPacks/*` and are selected deterministically.

// ═════════════════════════════════════════════════════════════════════════
// 1. CONTEXT — fold wizard payload + persisted client config into one object
// ═════════════════════════════════════════════════════════════════════════
function buildContext(client = {}, wizardData = {}) {
  const pv = client.platformVars || {};
  const persona = client.ai?.persona || {};
  const policies = client.policies || {};

  // Features: persisted client.wizardFeatures is the base, wizardData.features overrides.
  const persistedFeatures = (client.wizardFeatures && client.wizardFeatures.toObject)
    ? client.wizardFeatures.toObject()
    : (client.wizardFeatures || {});
  const live = wizardData.features || {};
  const { mergeWizardFeatures } = require('./wizardFeaturePresets');
  // Phase 1.3 — feed canonical storeCategory slug + categoryOverrides into the
  // preset merge so warranty / install defaults match the merchant's vertical.
  const storeCategorySlug =
    wizardData.storeCategory ||
    client.onboardingData?.storeCategory ||
    '';
  const categoryOverrides =
    (wizardData.categoryOverrides && typeof wizardData.categoryOverrides === 'object'
      ? wizardData.categoryOverrides
      : null) ||
    client.onboardingData?.categoryOverrides ||
    {};
  const features = mergeWizardFeatures(
    { ...persistedFeatures, ...live },
    wizardData.businessType || client.businessType,
    wizardData.industry,
    { storeCategory: storeCategorySlug, categoryOverrides }
  );

  // Allow legacy wizardData top-level fields to feed features for backward compat.
  if (typeof features.enableB2BWholesale !== "boolean" && typeof wizardData.b2bEnabled === "boolean") {
    features.enableB2BWholesale = wizardData.b2bEnabled;
  }
  if (typeof features.enable247 !== "boolean" && typeof wizardData.is247 === "boolean") {
    features.enable247 = wizardData.is247;
  }

  // Sane feature defaults so missing fields never short-circuit a builder.
  const F = {
    enableCatalog:           true,
    enableOrderTracking:     false,
    enableReturnsRefunds:    false,
    enableCancelOrder:       true,
    enableCodToPrepaid:      false,
    codDiscountAmount:       50,
    enableAbandonedCart:     true,
    enableCatalogCheckoutRecovery: true,
    catalogCheckoutDelayMin: 20,
    cartNudgeMinutes1:       15,
    cartNudgeHours2:         2,
    cartNudgeHours3:         24,
    enableReferral:          false,
    referralPointsBonus:     500,
    enableReviewCollection:  false,
    reviewDelayDays:         4,
    enableWarranty:          false,
    warrantyDuration:        "1 Year",
    warrantyGeneratePdf:     true,
    warrantySupportPhone:    "",
    warrantySupportEmail:    "",
    warrantyClaimUrl:        "",
    enableInstallSupport:    false,
    installSupportPrompt:    "Need install help? Share your exact product name and I will guide you.",
    enableFAQ:               true,
    enableSupportEscalation: true,
    humanEscalationTimeoutMin: 30,
    enableBusinessHoursGate: true,
    enable247:               false,
    enableInstagramTrigger:  false,
    enableMetaAdsTrigger:    false,
    enableB2BWholesale:      false,
    enableAIFallback:        true,
    enableMultiLanguage:     false,
    enableAdminAlerts:       true,
    enableOrderConfirmTpl:   true,
    /** Webhook-only; see orderEventDispatcher (no flow branch). */
    enableAutoShopifyShippedWhatsApp: true,
    cancelRequireReason: true,
    cancelAllowModify: true,
    warrantyGeneratePdf: true,
    helpIncludeInstallGuide: true,
    ...features
  };

  // Wizard "Cart recovery" step stores `cartTiming.msg1/msg2/msg3` (minutes / hours / hours).
  // Flat `features.cartNudge*` may be stale if the user only changed the timing step — prefer cartTiming.
  const ct = wizardData.cartTiming || {};
  if (ct.msg1 != null && Number(ct.msg1) > 0) F.cartNudgeMinutes1 = Number(ct.msg1);
  if (ct.msg2 != null && Number(ct.msg2) > 0) F.cartNudgeHours2 = Number(ct.msg2);
  if (ct.msg3 != null && Number(ct.msg3) > 0) F.cartNudgeHours3 = Number(ct.msg3);

  const facebookCatalogId = String(
    wizardData.facebookCatalogId || client.facebookCatalogId || client.waCatalogId || ""
  ).trim();
  let productMode = wizardData.productMode;
  if (!productMode) {
    try {
      const { resolveProductMode } = require('../commerce/universalCommerceMapper');
      productMode = resolveProductMode(wizardData.features || {}, client);
    } catch {
      productMode = "text_list";
    }
  }
  const mpmTemplateName = resolveMpmTemplateName(client, wizardData);
  const useMpmCatalog = productMode === "catalog" && !!facebookCatalogId && !!mpmTemplateName;

  const brandProfile =
    wizardData.brandProfile ||
    client.onboardingData?.brandProfile ||
    null;

  return {
    client,
    wizardData,
    brandProfile,
    F,
    flowType:            wizardData.flowType            || "ecommerce",
    riskPosture:         wizardData.riskPosture         || "balanced",
    businessName:        wizardData.businessName        || pv.brandName              || client.businessName || client.name || "My Business",
    businessDescription: wizardData.businessDescription || pv.businessDescription    || persona.description || "",
    botName:             wizardData.botName             || pv.agentName              || persona.name        || "Assistant",
    tone:                wizardData.tone                || pv.defaultTone            || persona.tone        || "friendly",
    botLanguage:         wizardData.botLanguage         || pv.defaultLanguage        || persona.language    || "Hinglish",
    adminPhone:          wizardData.adminPhone          || pv.adminWhatsappNumber    || client.adminPhone   || "",
    googleReviewUrl:     wizardData.googleReviewUrl     || pv.googleReviewUrl        || client.googleReviewUrl || "",
    openTime:            wizardData.openTime            || pv.openTime               || "10:00",
    closeTime:           wizardData.closeTime           || pv.closeTime              || "19:00",
    workingDays:         wizardData.workingDays         || [1, 2, 3, 4, 5, 6],
    checkoutUrl:         wizardData.checkoutUrl         || pv.checkoutUrl            || "",
    currency:            wizardData.currency            || pv.baseCurrency           || "₹",
    warrantyDuration:    F.warrantyDuration             || pv.warrantyDuration       || "1 Year",
    warrantyGeneratePdf: F.warrantyGeneratePdf !== false,
    faqText:
      wizardData.faqText ||
      wizardData.aiKnowledgeBase ||
      persona.knowledgeBase ||
      "",
    returnsInfo:         wizardData.returnsInfo         || policies.returnPolicy     || "",
    fallbackMessage:     wizardData.fallbackMessage     || "I can help with that. Let me route you to the right place.",
    products:            (wizardData.products || []).slice(0, 20).map((p, i) => buildProductContext(p, i)),
    shopCollections:     (Array.isArray(wizardData.collections) ? wizardData.collections : [])
      .map((c) => ({
        shopifyCollectionId: String(c.shopifyCollectionId || c.id || "").trim(),
        title: String(c.title || "").trim(),
        whatsappMenuLabel: String(c.whatsappMenuLabel || c.title || "").trim(),
        productsCount: Number(c.productsCount) || 0,
      }))
      .filter((c) => c.shopifyCollectionId),
    facebookCatalogId,
    productMode,
    mpmTemplateName,
    useMpmCatalog,
    storeUrl:            wizardData.shopDomain
      ? `https://${String(wizardData.shopDomain).replace(/^https?:\/\//, "")}`
      : (wizardData.checkoutUrl || pv.checkoutUrl || "").replace(/\/checkout$/, ""),
    activePersona:       wizardData.activePersona || persona.role || "sidekick",
    formality:           wizardData.formality || persona.formality || "semi-formal",
    emojiLevel:          wizardData.emojiLevel || persona.emojiLevel || "moderate",
    cartTiming: {
      msg1: F.cartNudgeMinutes1,
      msg2: F.cartNudgeHours2,
      msg3: F.cartNudgeHours3
    },
    productGuideLibrary:
      wizardData.productGuideLibrary ||
      client.productGuideLibrary ||
      { version: 1, categories: [] },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 2. DETERMINISTIC ID TABLE — one entry per node, generated from clientId.
//    Adding a new node? Add its key here so it can never be `undefined`.
// ═════════════════════════════════════════════════════════════════════════
function buildIDs(client, wizardData) {
  const seed = String(client.clientId || "default").replace(/[^a-z0-9]/gi, "").substring(0, 12) || "default";
  // wizardData.preserveNodeIds defaults true on regen; turn it off to fork.
  const ts = wizardData.preserveNodeIds === false ? Date.now().toString(36) : seed;

  return {
    seed: ts,
    // Triggers
    trig_main:        `trig_main_${ts}`,
    trig_ad:          `trig_ad_${ts}`,
    trig_ig:          `trig_ig_${ts}`,
    trig_order:       `trig_order_${ts}`,
    trig_cart:        `trig_cart_${ts}`,
    trig_fulfill:     `trig_fulfill_${ts}`,
    // Welcome / menu
    welcome:          `welcome_${ts}`,
    welcome_msg:      `welcome_msg_${ts}`,
    ad_welcome:       `ad_welcome_${ts}`,
    ig_welcome:       `ig_welcome_${ts}`,
    main_menu:        `main_menu_${ts}`,
    // Catalog
    cat_list:         `cat_list_${ts}`,
    cat_category_menu:`cat_category_menu_${ts}`,
    cat_category_menu_more:`cat_category_menu_more_${ts}`,
    cat_featured:     `cat_featured_${ts}`,
    cat_cat_0:        `cat_cat_0_${ts}`,
    cat_cat_1:        `cat_cat_1_${ts}`,
    cat_cat_2:        `cat_cat_2_${ts}`,
    cat_cat_3:        `cat_cat_3_${ts}`,
    cat_cat_4:        `cat_cat_4_${ts}`,
    cat_addr_prompt:  `cat_addr_prompt_${ts}`,
    cat_addr_cap:     `cat_addr_cap_${ts}`,
    cat_addr_done:    `cat_addr_done_${ts}`,
    cat_addr_alert:   `cat_addr_alert_${ts}`,
    cat_ck_delay:     `cat_ck_delay_${ts}`,
    cat_ck_ping:      `cat_ck_ping_${ts}`,
    cat_ck_follow:    `cat_ck_follow_${ts}`,
    cat_shop_by_selection: `cat_shop_by_sel_${ts}`,
    cat_cart_handler: `cat_cart_handler_${ts}`,
    // Order ops
    ord_track:        `ord_track_${ts}`,
    ord_status_msg:   `ord_status_msg_${ts}`,
    ord_notfound:     `ord_notfound_${ts}`,
    ord_hub:          `ord_hub_${ts}`,
    can_confirm:      `can_confirm_${ts}`,
    can_logic:        `can_logic_${ts}`,
    can_shipped:      `can_shipped_${ts}`,
    can_reason:       `can_reason_${ts}`,
    can_action:       `can_action_${ts}`,
    can_succ:         `can_succ_${ts}`,
    can_fail:         `can_fail_${ts}`,
    can_flow_ask:     `can_flow_ask_${ts}`,
    can_flow_lookup:  `can_flow_lookup_${ts}`,
    can_flow_list:    `can_flow_list_${ts}`,
    can_flow_resolve: `can_flow_resolve_${ts}`,
    can_flow_shipped: `can_flow_shipped_${ts}`,
    can_flow_choice:  `can_flow_choice_${ts}`,
    can_flow_reason:  `can_flow_reason_${ts}`,
    can_flow_alert:   `can_flow_alert_${ts}`,
    can_flow_done:    `can_flow_done_${ts}`,
    can_flow_modify:  `can_flow_modify_${ts}`,
    can_flow_mod_capture: `can_flow_mod_capture_${ts}`,
    can_flow_mod_alert: `can_flow_mod_alert_${ts}`,
    can_flow_mod_done: `can_flow_mod_done_${ts}`,
    can_flow_show:    `can_flow_show_${ts}`,
    can_flow_mod_check: `can_flow_mod_check_${ts}`,
    can_flow_addr_sync: `can_flow_addr_sync_${ts}`,
    can_flow_addr_ok: `can_flow_addr_ok_${ts}`,
  // AI help desk
    ai_capture:       `ai_capture_${ts}`,
    ai_respond:       `ai_respond_${ts}`,
    ai_check:         `ai_check_${ts}`,
    ai_escalate:      `ai_escalate_${ts}`,
    ord_ask:          `ord_ask_${ts}`,
    // Returns
    ret_hub:          `ret_hub_${ts}`,
    ret_reason:       `ret_reason_${ts}`,
    ret_photo:        `ret_photo_${ts}`,
    ret_confirm:      `ret_confirm_${ts}`,
    ret_tag:          `ret_tag_${ts}`,
    ret_admin:        `ret_admin_${ts}`,
    ret_policy:       `ret_policy_${ts}`,
    ref_check:        `ref_check_${ts}`,
    ref_result:       `ref_result_${ts}`,
    // Warranty
    war_hub:          `war_hub_${ts}`,
    war_serial:       `war_serial_${ts}`,
    war_date:         `war_date_${ts}`,
    war_tag:          `war_tag_${ts}`,
    war_success:      `war_success_${ts}`,
    war_lookup:       `war_lookup_${ts}`,
    war_engine:       `war_engine_${ts}`,
    war_active:       `war_active_${ts}`,
    war_expired:      `war_expired_${ts}`,
    war_none:         `war_none_${ts}`,
    // Install support
    ins_hub:          `ins_hub_${ts}`,
    ins_lookup:       `ins_lookup_${ts}`,
    ins_confirm:      `ins_confirm_${ts}`,
    ins_capture:      `ins_capture_${ts}`,
    ins_search:       `ins_search_${ts}`,
    ins_search_latest:`ins_search_latest_${ts}`,
    ins_result:       `ins_result_${ts}`,
    ins_no_match:     `ins_no_match_${ts}`,
    help_ask:         `help_ask_${ts}`,
    help_lookup:      `help_lookup_${ts}`,
    help_menu:        `help_menu_${ts}`,
    help_not_found:   `help_not_found_${ts}`,
    help_alert:       `help_alert_${ts}`,
    help_done:        `help_done_${ts}`,
    help_install_msg: `help_install_msg_${ts}`,
    help_other_cap:   `help_other_cap_${ts}`,
    guide_cat_list:   `guide_cat_list_${ts}`,
    guide_prod_list:  `guide_prod_list_${ts}`,
    guide_send:       `guide_send_${ts}`,
    guide_no_guides:  `guide_no_guides_${ts}`,
    war_ask:          `war_ask_${ts}`,
    war_active_hub:   `war_active_hub_${ts}`,
    war_pdf:          `war_pdf_${ts}`,
    war_claim_cap:    `war_claim_cap_${ts}`,
    war_claim_alert:  `war_claim_alert_${ts}`,
    war_claim_done:   `war_claim_done_${ts}`,
    // Support
    sup_sch:          `sup_sch_${ts}`,
    sup_capture:      `sup_capture_${ts}`,
    sup_tag:          `sup_tag_${ts}`,
    sup_alert:        `sup_alert_${ts}`,
    sup_confirm:      `sup_confirm_${ts}`,
    sup_closed:       `sup_closed_${ts}`,
    sup_livechat:     `sup_livechat_${ts}`,
    // FAQ
    faq_msg:          `faq_msg_${ts}`,
    // B2B
    b2b_trigger:      `b2b_trigger_${ts}`,
    b2b_capture:      `b2b_capture_${ts}`,
    b2b_tag:          `b2b_tag_${ts}`,
    b2b_alert:        `b2b_alert_${ts}`,
    b2b_confirm:      `b2b_confirm_${ts}`,
    // AI fallback
    ai_fallback:      `ai_fallback_${ts}`
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 3. AI CONTENT GENERATION (best-effort — falls back to defaults silently)
// ═════════════════════════════════════════════════════════════════════════
function buildDefaultContent(ctx) {
  return getCopyPack(ctx);
}

function normalizeWelcomeCopy(raw, ctx) {
  const brand = ctx?.businessName || ctx?.client?.businessName || "our store";
  const bot = ctx?.botName || "our assistant";
  const text = String(raw || "").trim();
  const hasAidaJargon = /\battention:|\binterest:|\bdesire:|\baction:/i.test(text);
  if (!text || hasAidaJargon) {
    try {
      const { buildIndustryWelcomeA } = require('./copyPacks/industryWelcome');
      return buildIndustryWelcomeA(ctx);
    } catch (_) {
      return `Hi {{first_name}} 👋 Welcome to ${brand}.\nI am ${bot}. I can help you browse products, track an order, or connect you to support.\nTap an option below to continue.`;
    }
  }
  return text;
}

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

function sanitizeInteractiveImageUrl(url) {
  const { sanitizeInteractiveImageUrl: sanitize } = require('./sanitizeFlowMedia');
  return sanitize(url);
}

/** Soft footer on branch endings — avoids spamming the full list menu after every answer. */
function withMenuHint(text) {
  const s = String(text || "").trim();
  if (!s || /reply \*menu\*/i.test(s)) return s;
  return `${s}\n\n_Reply *menu* anytime for more options._`;
}

/** WhatsApp list cap (8 rows) + dedupe overlapping commerce rows. */
function consolidateMenuRows(branches, F) {
  let rows = branches.filter((b) => b.menuRow).map((b) => ({ ...b.menuRow }));

  const hasCancel = rows.some((r) => r.id === "mnu_cancel");
  const hasReturns = rows.some((r) => r.id === "returns");
  if (hasCancel && hasReturns) {
    rows = rows.filter((r) => r.id !== "returns");
    rows = rows.map((r) =>
      r.id === "mnu_cancel"
        ? {
            ...r,
            title: "📦 Orders & returns",
            description: "Cancel, modify, or return",
          }
        : r
    );
  }

  if (F.enableAIFallback && F.enableInstallSupport) {
    rows = rows.filter((r) => r.id !== "mnu_help");
  }

  return rows.slice(0, 8);
}

async function generateAIContent(ctx) {
  const { client, businessName, businessDescription, botName, tone, botLanguage, currency, products } = ctx;
  const productsSummary = products.slice(0, 8)
    .map(p => `"${p.title}" ${currency}${p.price}: ${p.features.slice(0, 80)}`).join("\n");

  const prompt = `You are a top-tier D2C growth copy chief. Create JSON marketing copy for a WhatsApp commerce bot.
Use AIDA (Attention, Interest, Desire, Action) where appropriate. For cart_recovery_1 use empathy + hook (no hard sell).
For cart_recovery_2 add authentic scarcity / velocity (selling fast, cart not held) without fake countdown timers.
For cart_recovery_3 add FOMO + clear CTA (no fabricated coupon codes unless brand-agnostic like "active offers").
For warranty_* strings: confident, legal-safe, enterprise tone — no guarantees beyond stated {{warranty_duration}}.
Keep placeholders EXACTLY as token names: {{first_name}},{{brand_name}},{{bot_name}},{{line_items_list}},{{cart_total}},{{checkout_url}},{{first_product_title}},{{order_number}},{{order_total}},{{payment_method}},{{shipping_address}},{{currency}},{{discount_amount}},{{warranty_duration}} — do not rename.
Do NOT generate copy for order tracking, COD-to-prepaid nudges, or review collection — those are not in V1 flows.
BRAND=${businessName}
DESCRIPTION=${businessDescription}
BOT=${botName}
TONE=${tone}
LANGUAGE=${botLanguage}
PRODUCTS:
${productsSummary}
Return only JSON with keys: welcome_a,welcome_b,product_menu_text,fallback_msg,returns_policy_short,cancellation_confirm,cancellation_success,referral_msg,cart_recovery_1,cart_recovery_2,cart_recovery_3,agent_handoff_msg,faq_response,ad_welcome,ig_welcome,warranty_welcome,warranty_lookup_prompt,warranty_reg_success,warranty_active_msg,warranty_expired_msg,warranty_none_msg,support_hours_msg,return_photo_prompt`;

  try {
    const apiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
    const parsed = await generateJSON(prompt, apiKey, { maxTokens: 3000, temperature: 0.2, timeout: 30000, maxRetries: 1 });
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) { /* swallow — fall back to defaults */ }
  return {};
}

// ═════════════════════════════════════════════════════════════════════════
// 4. FEATURE BUILDERS — one per branch. Each returns:
//    { nodes:[], edges:[], menuRow?: {id,title}, entryNodeId?: string }
//    `menuRow` + `entryNodeId` tell the orchestrator how to wire the main menu.
// ═════════════════════════════════════════════════════════════════════════

function buildEntry(ctx, IDS, content, welcomeTemplate) {
  const { F, client } = ctx;
  const nodes = [];
  const edges = [];

  // Main keyword trigger
  nodes.push({
    id: IDS.trig_main, type: "trigger", position: flowPos(0, 5),
    data: { label: "Main Entry Trigger", triggerType: "keyword", matchMode: "contains",
      keywords: ["hi","hello","hey","start","menu","help","bot","hola","namaste","kem cho","shu che","buy","price","order","shop","offer","catalog"], heatmapCount: 0 }
  });

  if (F.enableMetaAdsTrigger) {
    nodes.push({
      id: IDS.trig_ad, type: "trigger", position: flowPos(0, 2),
      data: { label: "Meta Ad Click Trigger", triggerType: "meta_ad", keywords: ["ad_click"], heatmapCount: 0 }
    });
    nodes.push({
      id: IDS.ad_welcome, type: "message", position: flowPos(1, 2),
      data: { label: "Ad Welcome", text: content.ad_welcome, heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.trig_ad}_aw`, source: IDS.trig_ad,    target: IDS.ad_welcome },
      { id: `e_${IDS.ad_welcome}_mm`, source: IDS.ad_welcome, target: IDS.main_menu }
    );
  }
  if (F.enableInstagramTrigger) {
    nodes.push({
      id: IDS.trig_ig, type: "trigger", position: flowPos(0, 0),
      data: { label: "Instagram Trigger", triggerType: "ig_story_mention", keywords: ["story_mention"], heatmapCount: 0 }
    });
    nodes.push({
      id: IDS.ig_welcome, type: "message", position: flowPos(1, 0),
      data: { label: "Instagram Welcome", text: content.ig_welcome, heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.trig_ig}_iw`, source: IDS.trig_ig,    target: IDS.ig_welcome },
      { id: `e_${IDS.ig_welcome}_mm`, source: IDS.ig_welcome, target: IDS.main_menu }
    );
  }

  // Welcome — template if available, else interactive list menu
  const wTpl = welcomeTemplate;
  const safeWelcomeImage = sanitizeInteractiveImageUrl(
    ctx?.wizardData?.businessLogo ||
      client.brand?.businessLogo ||
      client.brand?.logoUrl ||
      client.businessLogo ||
      ""
  );
  const welcomeText = normalizeWelcomeCopy(content.welcome_a, ctx);
  const welcomeCaption = String(welcomeText || "")
    .split("\n")
    .slice(0, 2)
    .join("\n")
    .substring(0, 900);

  if (wTpl) {
    nodes.push({
      id: IDS.welcome, type: "template", position: flowPos(2, 5),
      data: {
        label: "Welcome Template",
        templateName: wTpl.name,
        imageUrl: safeWelcomeImage,
        variables: ["{{brand_name}}", "{{bot_name}}"],
        heatmapCount: 0
      }
    });
    edges.push({ id: `e_${IDS.trig_main}_w`, source: IDS.trig_main, target: IDS.welcome });
    edges.push({ id: `e_${IDS.welcome}_mm_tpl`, source: IDS.welcome, target: IDS.main_menu });
  } else if (safeWelcomeImage) {
    ctx.hasWelcomeBrandImage = true;
    nodes.push({
      id: IDS.welcome_msg,
      type: "message",
      position: flowPos(2, 5),
      data: {
        label: "Welcome (brand image)",
        text: welcomeCaption || `Hi {{first_name}} 👋 Welcome to {{brand_name}}.`,
        imageUrl: safeWelcomeImage,
        heatmapCount: 0,
      },
    });
    edges.push({ id: `e_${IDS.trig_main}_wm`, source: IDS.trig_main, target: IDS.welcome_msg });
    edges.push({ id: `e_${IDS.welcome_msg}_mm`, source: IDS.welcome_msg, target: IDS.main_menu });
  } else {
    edges.push({ id: `e_${IDS.trig_main}_mm`, source: IDS.trig_main, target: IDS.main_menu });
  }

  return { nodes, edges, label: "Welcome → {{brand_name}}", hasWelcomeTemplate: !!wTpl };
}

function buildMainMenu(ctx, IDS, menuRows, content = {}) {
  const rows = (menuRows && menuRows.length ? menuRows : buildMainMenuRows(ctx.F)).slice(0, 8);
  if (!rows.length) return { nodes: [], edges: [] };
  const { client } = ctx;
  const safeLogo = sanitizeInteractiveImageUrl(
    ctx?.wizardData?.businessLogo ||
      client.brand?.businessLogo ||
      client.brand?.logoUrl ||
      client.businessLogo ||
      ""
  );
  const welcomeText = ctx.hasWelcomeBrandImage
    ? String(content.product_menu_text || `*${ctx.businessName || "our store"}* — what would you like to do?`).trim()
    : normalizeWelcomeCopy(content.welcome_a, ctx);
  const node = {
    id: IDS.main_menu,
    type: "interactive",
    position: flowPos(3, 5),
    data: {
      label: "Main Hub Menu",
      interactiveType: "list",
      imageUrl: safeLogo,
      listHeaderType: safeLogo ? "image" : undefined,
      text: welcomeText,
      buttonText: "Menu",
      sections: [{ title: "How can we help?", rows }],
      heatmapCount: 0,
    },
  };
  return { nodes: [node], edges: [] };
}

function buildCatalogBranch(ctx, IDS) {
  const { F, products, storeUrl, shopCollections = [], useMpmCatalog, mpmTemplateName } = ctx;
  const {
    splitCollectionsForWhatsAppMenu,
    MORE_ROW_ID,
    OVERFLOW_PAGE_TITLE,
    collectionToRow,
  } = require('../commerce/catalogMenuBuilder');
  const nodes = [];
  const edges = [];
  const MAX_CATEGORY_ROWS = 10;
  const categoryNodeIds = [IDS.cat_cat_0, IDS.cat_cat_1, IDS.cat_cat_2, IDS.cat_cat_3, IDS.cat_cat_4];
  const useShopCols = Array.isArray(shopCollections) && shopCollections.length > 0;
  const menuSplit = useShopCols ? splitCollectionsForWhatsAppMenu(sortShopCollectionsForMenu(shopCollections)) : null;
  const shopColsForMpm = menuSplit?.allCollections || [];
  const collectionMpmNodeId = (col) => `cat_mpm_${IDS.seed}_${String(col.shopifyCollectionId || "").replace(/\W/g, "")}`;

  const productBuckets = new Map();
  products.forEach((p) => {
    const key = String(p.category || "General").trim() || "General";
    if (!productBuckets.has(key)) productBuckets.set(key, []);
    productBuckets.get(key).push(p);
  });
  const sortedCategories = Array.from(productBuckets.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_CATEGORY_ROWS);
  const featuredProducts = products.slice(0, 8);
  const featuredVariantIds = featuredProducts
    .map((p) => String(p.variantId || p.id || "").trim())
    .filter(Boolean);

  const listRows = [];
  let menuSections;
  const hasOverflowMenu = !!menuSplit?.hasOverflow;
  if (useShopCols && menuSplit) {
    menuSections = menuSplit.primarySections;
    menuSplit.primary.forEach((c) => listRows.push(collectionToRow(c)));
  } else {
    listRows.push({ id: "all", title: "🛍️ View All Products", description: "Browse our full range" });
    listRows.push({ id: "featured", title: "⭐ Featured picks", description: "Bestsellers & trending" });
    if (sortedCategories.length) {
      sortedCategories.forEach(([name, items], idx) => {
        listRows.push({
          id: `cat_${idx}`,
          title: truncate(name, 24),
          description: `${items.length} item${items.length > 1 ? "s" : ""}`,
        });
      });
    } else {
      listRows.push({ id: "cat_0", title: "General", description: "All products" });
    }
    menuSections = [{ title: "{{brand_name}} collections", rows: listRows }];
  }

  const featuredCatalogData =
    useMpmCatalog && featuredVariantIds.length
      ? {
          catalogType: "mpm_template",
          metaTemplateName: mpmTemplateName,
          languageCode: "en",
          header: "Featured picks",
          sectionTitle: "Featured picks",
          body: "Checkout our best-performing products from {{brand_name}}. Tap *View items* for the carousel.",
          text: "Checkout our best-performing products from {{brand_name}}. Tap *View items* for the carousel.",
          productIds: featuredVariantIds.join(","),
          thumbnailProductRetailerId: featuredVariantIds[0],
          heatmapCount: 0,
        }
      : {
          catalogType: featuredVariantIds.length ? "multi" : "full",
          header: "Featured picks",
          body: "Checkout our best-performing products from {{brand_name}}.",
          footer: "Tap to view items",
          productIds: featuredVariantIds.join(","),
          heatmapCount: 0,
        };

  nodes.push(
    {
      id: IDS.cat_cart_handler,
      type: "cart_handler",
      position: flowPos(6, 2),
      data: {
        label: "Cart & checkout",
        checkoutMessage:
          "Complete your checkout 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}\n\nThis link is valid for a short time.",
        heatmapCount: 0
      }
    },
    {
      id: IDS.cat_list, type: "catalog", position: flowPos(5, 1),
      data: {
        label: "Full Catalog",
        catalogType: "full",
        header: "{{brand_name}}",
        body: "Browse all *{{brand_name}}* products — add to cart and tap *Checkout* when you're ready. 🛍️",
        footer: "Secure checkout",
        heatmapCount: 0
      }
    },
    {
      id: IDS.cat_category_menu,
      type: "interactive",
      position: flowPos(6, 0),
      data: {
        label: "Category menu",
        interactiveType: "list",
        text: useShopCols
          ? useMpmCatalog
            ? hasOverflowMenu
              ? "✨ *{{brand_name}} store*\n\nBrowse by collection — tap *More categories* for additional ranges."
              : "✨ *{{brand_name}} store*\n\nPick a collection, then *View items* to browse the WhatsApp carousel."
            : hasOverflowMenu
              ? "✨ *{{brand_name}} store*\n\nPick a collection — tap *More categories* for the full list."
              : "✨ *{{brand_name}} store*\n\nPick a collection to browse products in WhatsApp. 👇"
          : "✨ *{{brand_name}} store*\n\nPick a category or tap *View All* to see everything. 👇",
        buttonText: "Explore products",
        populateFromShopify: useShopCols,
        sections: menuSections,
        heatmapCount: 0
      }
    },
    ...(hasOverflowMenu
      ? [
          {
            id: IDS.cat_category_menu_more,
            type: "interactive",
            position: flowPos(6, 1),
            data: {
              label: "More categories",
              interactiveType: "list",
              text: `*${OVERFLOW_PAGE_TITLE}*\n\nAdditional collections from {{brand_name}}.`,
              buttonText: "View more",
              populateFromShopify: true,
              sections: menuSplit.overflowSections,
              heatmapCount: 0,
            },
          },
        ]
      : []),
    {
      id: IDS.cat_featured,
      type: "catalog",
      position: flowPos(7, 0),
      data: { label: "Featured collection", ...featuredCatalogData },
    },
    {
      id: IDS.cat_addr_prompt,
      type: "interactive",
      position: flowPos(6, 1),
      data: {
        label: "Catalog next actions",
        interactiveType: "button",
        text: "Found something you like? 🛒 Get your checkout link below, or ask if you need help first.",
        buttonsList: [
          { id: "checkout", title: "🛒 Get checkout link" },
          { id: "support", title: "🎧 Ask a question" },
          { id: "menu", title: "⬅️ Main Menu" }
        ],
        heatmapCount: 0
      }
    },
    {
      id: IDS.cat_addr_done,
      type: "message",
      position: flowPos(7, 0),
      data: {
        label: "Checkout link",
        text:
          "Complete your checkout here 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}\n\nThis link is for your cart only and expires soon.",
        heatmapCount: 0
      }
    }
  );
  if (useShopCols && useMpmCatalog) {
    shopColsForMpm.forEach((c, idx) => {
      const label = menuLabelForCollection(c);
      const nid = collectionMpmNodeId(c);
      nodes.push({
        id: nid,
        type: "catalog",
        position: flowPos(7, 1 + idx * 0.12),
        data: {
          label: `MPM — ${truncate(c.title, 22)}`,
          catalogType: "mpm_template",
          metaTemplateName: mpmTemplateName,
          languageCode: "en",
          header: label,
          sectionTitle: label,
          body: `Here are our *${label}* — tap *View items* for the WhatsApp carousel.`,
          text: `Here are our *${label}* — tap *View items* for the WhatsApp carousel.`,
          metaCollectionId: c.shopifyCollectionId,
          productIds: "",
          thumbnailProductRetailerId: "",
          heatmapCount: 0,
        },
      });
    });
  } else if (useShopCols) {
    nodes.push({
      id: IDS.cat_shop_by_selection,
      type: "catalog",
      position: flowPos(7, 1),
      data: {
        label: "Collection (from menu)",
        catalogType: "collection",
        useSelectedCollection: true,
        collectionId: String(shopCollections[0]?.shopifyCollectionId || shopCollections[0]?.id || "").trim(),
        maxItems: 30,
        header: "{{brand_name}}",
        body: "Tap a product to view details and add to cart in WhatsApp.",
        footer: "Secure checkout",
        heatmapCount: 0
      }
    });
  } else {
    sortedCategories.forEach(([name, items], idx) => {
      const targetNodeId = categoryNodeIds[idx];
      const productIds = items
        .slice(0, 8)
        .map((p) => String(p.variantId || p.id || "").trim())
        .filter(Boolean);
      const catLabel = truncate(name, 40);
      const catBody = `Browse ${name} from {{brand_name}}.`;
      nodes.push({
        id: targetNodeId,
        type: "catalog",
        position: flowPos(7, 1 + idx),
        data: useMpmCatalog && productIds.length
          ? {
              label: `MPM — ${truncate(name, 22)}`,
              catalogType: "mpm_template",
              metaTemplateName: mpmTemplateName,
              languageCode: "en",
              header: catLabel,
              sectionTitle: catLabel,
              body: `${catBody} Tap *View items* for the carousel.`,
              text: `${catBody} Tap *View items* for the carousel.`,
              productIds: productIds.join(","),
              thumbnailProductRetailerId: productIds[0],
              heatmapCount: 0,
            }
          : {
              label: `Collection: ${truncate(name, 22)}`,
              catalogType: productIds.length ? "multi" : "full",
              header: catLabel,
              body: catBody,
              footer: "Tap to view items",
              productIds: productIds.join(","),
              heatmapCount: 0,
            },
      });
    });
  }

  const supEntryProduct = F.enableSupportEscalation
    ? (F.enableBusinessHoursGate && !F.enable247 ? IDS.sup_sch : IDS.sup_capture)
    : IDS.ai_fallback;

  const isCatalogUnavailable = products.length === 0 && !useShopCols;
  if (isCatalogUnavailable) {
    nodes.push({
      id: IDS.cat_addr_cap,
      type: "message",
      position: flowPos(7, 2),
      data: {
        label: "Catalog unavailable",
        text: "Catalog is not synced yet. Connect your store to load products, or ask support to share direct links.",
        heatmapCount: 0
      }
    });
  }

  edges.push(
    { id: `e_${IDS.cat_list}_done`, source: IDS.cat_list, target: IDS.cat_addr_prompt },
    { id: `e_${IDS.cat_featured}_next`, source: IDS.cat_featured, target: IDS.cat_addr_prompt },
    { id: `e_${IDS.cat_list}_cart`, source: IDS.cat_list, target: IDS.cat_cart_handler, sourceHandle: "cart" },
    { id: `e_${IDS.cat_featured}_cart`, source: IDS.cat_featured, target: IDS.cat_cart_handler, sourceHandle: "cart" },
    { id: `e_${IDS.cat_cart_handler}_next`, source: IDS.cat_cart_handler, target: IDS.cat_addr_prompt, sourceHandle: "a" },
    { id: `e_${IDS.cat_addr_prompt}_checkout`, source: IDS.cat_addr_prompt, target: IDS.cat_addr_done, sourceHandle: "checkout" },
    { id: `e_${IDS.cat_addr_prompt}_support`, source: IDS.cat_addr_prompt, target: supEntryProduct, sourceHandle: "support" },
    { id: `e_${IDS.cat_addr_prompt}_menu`, source: IDS.cat_addr_prompt, target: IDS.main_menu, sourceHandle: "menu" }
  );
  if (!useShopCols) {
    edges.push(
      {
        id: `e_${IDS.cat_category_menu}_all`,
        source: IDS.cat_category_menu,
        target: IDS.cat_list,
        sourceHandle: "all",
      },
      {
        id: `e_${IDS.cat_category_menu}_featured`,
        source: IDS.cat_category_menu,
        target: IDS.cat_featured,
        sourceHandle: "featured",
      }
    );
  }

  if (hasOverflowMenu) {
    edges.push({
      id: `e_${IDS.cat_category_menu}_more`,
      source: IDS.cat_category_menu,
      target: IDS.cat_category_menu_more,
      sourceHandle: MORE_ROW_ID,
    });
  }

  if (useShopCols && useMpmCatalog) {
    const wireMenuToMpm = (menuId, col) => {
      const hid = `collection_${col.shopifyCollectionId}`;
      const nid = collectionMpmNodeId(col);
      edges.push(
        {
          id: `e_${menuId}_${hid}`,
          source: menuId,
          target: nid,
          sourceHandle: hid,
        },
        { id: `e_${nid}_next`, source: nid, target: IDS.cat_addr_prompt },
        { id: `e_${nid}_cart`, source: nid, target: IDS.cat_cart_handler, sourceHandle: "cart" }
      );
    };
    menuSplit.primary.forEach((c) => wireMenuToMpm(IDS.cat_category_menu, c));
    if (hasOverflowMenu) {
      menuSplit.overflow.forEach((c) => wireMenuToMpm(IDS.cat_category_menu_more, c));
    }
  } else if (useShopCols) {
    const wireColToShop = (menuId, col) => {
      const hid = `collection_${col.shopifyCollectionId}`;
      edges.push({
        id: `e_${menuId}_${hid}`,
        source: menuId,
        target: IDS.cat_shop_by_selection,
        sourceHandle: hid,
      });
    };
    shopColsForMpm.forEach((c) => wireColToShop(IDS.cat_category_menu, c));
    if (hasOverflowMenu) {
      menuSplit.overflow.forEach((c) => wireColToShop(IDS.cat_category_menu_more, c));
    }
    edges.push(
      { id: `e_${IDS.cat_shop_by_selection}_next`, source: IDS.cat_shop_by_selection, target: IDS.cat_addr_prompt },
      {
        id: `e_${IDS.cat_shop_by_selection}_cart`,
        source: IDS.cat_shop_by_selection,
        target: IDS.cat_cart_handler,
        sourceHandle: "cart",
      }
    );
  } else {
    sortedCategories.forEach(([_, __], idx) => {
      const targetNodeId = categoryNodeIds[idx];
      edges.push(
        { id: `e_${IDS.cat_category_menu}_cat_${idx}`, source: IDS.cat_category_menu, target: targetNodeId, sourceHandle: `cat_${idx}` },
        { id: `e_${targetNodeId}_next`, source: targetNodeId, target: IDS.cat_addr_prompt },
        {
          id: `e_${targetNodeId}_cart`,
          source: targetNodeId,
          target: IDS.cat_cart_handler,
          sourceHandle: "cart"
        }
      );
    });

    if (sortedCategories.length === 0) {
      edges.push({
        id: `e_${IDS.cat_category_menu}_cat_0`,
        source: IDS.cat_category_menu,
        target: IDS.cat_featured,
        sourceHandle: "cat_0"
      });
    }
  }

  if (isCatalogUnavailable) {
    edges.push({ id: `e_${IDS.cat_addr_done}_na`, source: IDS.cat_addr_done, target: IDS.cat_addr_cap });
    edges.push({ id: `e_${IDS.cat_addr_cap}_mm`, source: IDS.cat_addr_cap, target: IDS.main_menu });
  } else {
    edges.push({ id: `e_${IDS.cat_addr_done}_mm`, source: IDS.cat_addr_done, target: IDS.main_menu });
    if (F.enableCatalogCheckoutRecovery) {
      const followupMinutes = Math.max(1, Number(F.catalogCheckoutDelayMin || 20));
      nodes.push(
        {
          id: IDS.cat_ck_delay,
          type: "delay",
          position: flowPos(8, 0),
          data: {
            label: `Wait ${followupMinutes} min`,
            duration: followupMinutes,
            unit: "minutes",
            waitValue: followupMinutes,
            waitUnit: "minutes",
            heatmapCount: 0
          }
        },
        {
          id: IDS.cat_ck_ping,
          type: "interactive",
          position: flowPos(9, 0),
          data: {
            label: "Checkout follow-up",
            interactiveType: "button",
            text: "Still need help finishing your purchase? 🛒 Let us know and we'll get you sorted.",
            buttonsList: [
              { id: "resend", title: "🔁 Resend checkout link" },
              { id: "support", title: "🎧 I have a question" },
              { id: "done", title: "✅ Already purchased" }
            ],
            heatmapCount: 0
          }
        },
        {
          id: IDS.cat_ck_follow,
          type: "cart_handler",
          position: flowPos(10, 0),
          data: {
            label: "Resend checkout link",
            checkoutMessage:
              "Here is your checkout link again 👉 {{checkout_url}}\n\nTotal: {{currency}} {{cart_total}}",
            heatmapCount: 0
          }
        }
      );
      edges.push(
        { id: `e_${IDS.cat_addr_done}_ckd`, source: IDS.cat_addr_done, target: IDS.cat_ck_delay },
        { id: `e_${IDS.cat_ck_delay}_ckp`, source: IDS.cat_ck_delay, target: IDS.cat_ck_ping },
        { id: `e_${IDS.cat_ck_ping}_resend`, source: IDS.cat_ck_ping, target: IDS.cat_ck_follow, sourceHandle: "resend" },
        { id: `e_${IDS.cat_ck_ping}_support`, source: IDS.cat_ck_ping, target: supEntryProduct, sourceHandle: "support" },
        { id: `e_${IDS.cat_ck_ping}_done`, source: IDS.cat_ck_ping, target: IDS.main_menu, sourceHandle: "done" },
        { id: `e_${IDS.cat_ck_follow}_mm`, source: IDS.cat_ck_follow, target: IDS.main_menu }
      );
      const directMainMenuIdx = edges.findIndex((e) => e.id === `e_${IDS.cat_addr_done}_mm`);
      if (directMainMenuIdx >= 0) edges.splice(directMainMenuIdx, 1);
    }
  }

  return {
    nodes,
    edges,
    menuRow: { id: "mnu_browse", title: "🛍️ Browse Products" },
    entryNodeId: IDS.cat_category_menu,
    sourceHandle: "mnu_browse",
  };
}

function buildCancelOrderBranch(ctx, IDS, content) {
  const { F, adminPhone, client } = ctx;
  const nodes = [];
  const edges = [];
  const requireReason = F.cancelRequireReason !== false;
  const allowModify = F.cancelAllowModify !== false;
  const useAdminAlerts = F.enableAdminAlerts !== false;
  const postCancelNode = useAdminAlerts ? IDS.can_flow_alert : IDS.can_flow_done;
  const postModFailNode = useAdminAlerts ? IDS.can_flow_mod_alert : IDS.can_flow_mod_done;

  nodes.push(
    {
      id: IDS.can_flow_ask,
      type: "capture_input",
      position: flowPos(5, 10),
      data: {
        label: "Cancel — ask identifier",
        variable: "cancel_identifier",
        question:
          "To find your order, share your *Order ID* (e.g. #1042) or the *mobile number* used at checkout.",
        text:
          "To find your order, share your *Order ID* (e.g. #1042) or the *mobile number* used at checkout.",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_lookup,
      type: "shopify_call",
      position: flowPos(6, 10),
      data: {
        label: "Fetch customer orders",
        action: "GET_CUSTOMER_ORDERS",
        queryVariable: "cancel_identifier",
        variable: "customer_orders",
        silent: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_list,
      type: "interactive",
      position: flowPos(7, 10),
      data: {
        label: "Select order to cancel",
        interactiveType: "list",
        buttonText: "Select order",
        text: "Hi *{{first_name|there}}*! 👋\n\nHere are your recent orders. Which one would you like to cancel or modify?",
        sections: [{ title: "Your orders", rows: [] }],
        dynamicSections: true,
        dynamicSectionsVariable: "customer_orders",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_resolve,
      type: "shopify_call",
      position: flowPos(8, 10),
      data: {
        label: "Load selected order",
        action: "CHECK_ORDER_STATUS",
        queryVariable: "selected_order_name",
        silent: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_show,
      type: "message",
      position: flowPos(8, 10),
      data: {
        label: "Order summary",
        text:
          "📦 *Order {{order_number|selected}}*\nStatus: *{{order_status|Processing}}*\nTotal: *{{order_total|—}}*\n\nWhat would you like to do with this order?",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_shipped,
      type: "interactive",
      position: flowPos(9, 11),
      data: {
        label: "Already shipped",
        interactiveType: "button",
        text:
          "😕 *Order {{order_number|your order}}* has already been processed for delivery and cannot be cancelled or modified at this stage.\n\nYou can refuse delivery when the courier arrives — it will return to us and your refund will be processed in 5–7 business days.\n\nWhat would you like to do next?",
        buttonsList: [
          { id: "shipped_menu", title: "🏠 Main menu" },
          { id: "shipped_agent", title: "👨‍💼 Talk to agent" },
        ],
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_choice,
      type: "interactive",
      position: flowPos(9, 10),
      data: {
        label: "Cancel or modify",
        interactiveType: "list",
        buttonText: "Choose action",
        text: "✅ *Order {{order_number|selected}}* can still be changed.\n\nWhat would you like to do?",
        sections: [
          {
            title: "Order options",
            rows: [
              { id: "action_cancel", title: "❌ Cancel order", description: "Request cancellation" },
              ...(allowModify
                ? [{ id: "action_modify", title: "✏️ Modify order", description: "Address, size, etc." }]
                : []),
              ...(F.enableReturnsRefunds
                ? [{ id: "action_return", title: "↩️ Start return", description: "Return or exchange" }]
                : []),
              { id: "action_back", title: "⬅️ Main menu", description: "" },
            ],
          },
        ],
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_reason,
      type: "interactive",
      position: flowPos(10, 10),
      data: {
        label: "Cancellation reason",
        interactiveType: "list",
        buttonText: "Select reason",
        text: "We're sorry to see you go 😔\n\nCould you tell us why you'd like to cancel? This helps us improve.",
        sections: [
          {
            title: "Reason",
            rows: [
              { id: "reason_wrong", title: "Ordered by mistake", description: "" },
              { id: "reason_price", title: "Found better price", description: "" },
              { id: "reason_delay", title: "Delivery too slow", description: "" },
              { id: "reason_address", title: "Wrong address", description: "" },
              { id: "reason_mind", title: "Changed my mind", description: "" },
              { id: "reason_other", title: "Other reason", description: "" },
            ],
          },
        ],
        heatmapCount: 0,
      },
    },
    ...(useAdminAlerts
      ? [{
      id: IDS.can_flow_alert,
      type: "admin_alert",
      position: flowPos(11, 10),
      data: {
        label: "Cancel request — admin",
        priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "Cancellation request — {{order_number}}",
        customMessage:
          "Customer {{customer_name|Unknown}} ({{phone}}) requested cancellation for *{{order_number}}*.\nReason: {{cancel_reason|Not provided}}\nStatus: {{order_status|unknown}}",
        phone: adminPhone || client.adminPhone || "",
        heatmapCount: 0,
      },
    }]
      : []),
    {
      id: IDS.can_flow_done,
      type: "message",
      position: flowPos(12, 10),
      data: {
        label: "Cancel request received",
        text:
          "✅ *Your cancellation request has been received.*\n\nOur team will review it within *2–4 hours*. Please describe any urgent details below — a support agent will join this chat shortly.",
        heatmapCount: 0,
      },
    },
    ...(allowModify
      ? [
    {
      id: IDS.can_flow_modify,
      type: "interactive",
      position: flowPos(10, 12),
      data: {
        label: "Modify order menu",
        interactiveType: "list",
        buttonText: "What to change",
        text: "What would you like to change about *{{order_number|your order}}*?",
        sections: [
          {
            title: "Modification",
            rows: [
              { id: "mod_address", title: "📍 Delivery address", description: "Before shipping" },
              { id: "mod_phone", title: "📱 Contact number", description: "" },
              { id: "mod_variant", title: "👕 Size / variant", description: "Subject to stock" },
              { id: "mod_other", title: "✏️ Other changes", description: "" },
            ],
          },
        ],
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_mod_capture,
      type: "capture_input",
      position: flowPos(11, 12),
      data: {
        label: "Modify — capture details",
        variable: "modify_details",
        question:
          "✏️ *{{modify_type|Order change}}*\n\nPlease type the updated details for order *{{order_number|your order}}*.\n\nFor *address*, send street, city, and PIN on separate lines.",
        text:
          "✏️ *{{modify_type|Order change}}*\n\nPlease type the updated details for order *{{order_number|your order}}*.\n\nFor *address*, send street, city, and PIN on separate lines.",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_mod_check,
      type: "logic",
      position: flowPos(11, 12),
      data: {
        label: "Address change?",
        variable: "modification_type",
        operator: "eq",
        value: "mod_address",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_addr_sync,
      type: "shopify_call",
      position: flowPos(12, 11),
      data: {
        label: "Sync address to Shopify",
        action: "UPDATE_ORDER_ADDRESS",
        queryVariable: "modify_details",
        silent: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.can_flow_addr_ok,
      type: "message",
      position: flowPos(13, 11),
      data: {
        label: "Address updated",
        text:
          "✅ *Delivery address updated* for order *{{order_number|your order}}*.\n\nWe synced the change with your store order. You'll get a confirmation here once dispatch is scheduled.",
        heatmapCount: 0,
      },
    },
    ...(useAdminAlerts
      ? [{
      id: IDS.can_flow_mod_alert,
      type: "admin_alert",
      position: flowPos(12, 12),
      data: {
        label: "Modify request — admin",
        priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "Modification request — {{order_number}} ({{modify_type}})",
        customMessage:
          "Customer {{customer_name|Unknown}} ({{phone}}) requested a *modification* on *{{order_number}}*.\nType: {{modify_type|Not specified}}\nDetails: {{modify_details|Not provided}}",
        phone: adminPhone || client.adminPhone || "",
        heatmapCount: 0,
      },
    }]
      : []),
    {
      id: IDS.can_flow_mod_done,
      type: "message",
      position: flowPos(13, 12),
      data: {
        label: "Modify request received",
        text:
          "✅ *Your modification request has been received.*\n\nOur team will update order *{{order_number|your order}}* and confirm on WhatsApp within *2–4 hours*.",
        heatmapCount: 0,
      },
    },
      ]
      : []),
  );

  edges.push(
    { id: `e_${IDS.can_flow_ask}_lk`, source: IDS.can_flow_ask, target: IDS.can_flow_lookup },
    { id: `e_${IDS.can_flow_lookup}_ls`, source: IDS.can_flow_lookup, target: IDS.can_flow_list },
    { id: `e_${IDS.can_flow_list}_rs`, source: IDS.can_flow_list, target: IDS.can_flow_resolve },
    { id: `e_${IDS.can_flow_resolve}_sh`, source: IDS.can_flow_resolve, target: IDS.can_flow_show, sourceHandle: "success" },
    { id: `e_${IDS.can_flow_show}_lg`, source: IDS.can_flow_show, target: IDS.can_logic },
    { id: `e_${IDS.can_flow_resolve}_nf`, source: IDS.can_flow_resolve, target: IDS.can_flow_ask, sourceHandle: "not_found" },
    { id: `e_${IDS.can_logic}_ship`, source: IDS.can_logic, target: IDS.can_flow_shipped, sourceHandle: "true" },
    { id: `e_${IDS.can_logic}_ok`, source: IDS.can_logic, target: IDS.can_flow_choice, sourceHandle: "false" },
    { id: `e_${IDS.can_flow_choice}_cn`, source: IDS.can_flow_choice, target: requireReason ? IDS.can_flow_reason : postCancelNode, sourceHandle: "action_cancel" },
    ...(allowModify
      ? [{ id: `e_${IDS.can_flow_choice}_md`, source: IDS.can_flow_choice, target: IDS.can_flow_modify, sourceHandle: "action_modify" }]
      : []),
    ...(F.enableReturnsRefunds
      ? [{ id: `e_${IDS.can_flow_choice}_ret`, source: IDS.can_flow_choice, target: IDS.ret_hub, sourceHandle: "action_return" }]
      : []),
    { id: `e_${IDS.can_flow_choice}_mm`, source: IDS.can_flow_choice, target: IDS.main_menu, sourceHandle: "action_back" },
    { id: `e_${IDS.can_flow_reason}_al`, source: IDS.can_flow_reason, target: postCancelNode },
    ...(useAdminAlerts
      ? [{ id: `e_${IDS.can_flow_alert}_dn`, source: IDS.can_flow_alert, target: IDS.can_flow_done }]
      : []),
    { id: `e_${IDS.can_flow_done}_sp`, source: IDS.can_flow_done, target: IDS.sup_capture },
    { id: `e_${IDS.can_flow_shipped}_mm`, source: IDS.can_flow_shipped, target: IDS.main_menu, sourceHandle: "shipped_menu" },
    { id: `e_${IDS.can_flow_shipped}_ag`, source: IDS.can_flow_shipped, target: IDS.sup_capture, sourceHandle: "shipped_agent" },
    ...(allowModify
      ? [
          { id: `e_${IDS.can_flow_modify}_addr`, source: IDS.can_flow_modify, target: IDS.can_flow_mod_capture, sourceHandle: "mod_address" },
          { id: `e_${IDS.can_flow_modify}_phone`, source: IDS.can_flow_modify, target: IDS.can_flow_mod_capture, sourceHandle: "mod_phone" },
          { id: `e_${IDS.can_flow_modify}_var`, source: IDS.can_flow_modify, target: IDS.can_flow_mod_capture, sourceHandle: "mod_variant" },
          { id: `e_${IDS.can_flow_modify}_oth`, source: IDS.can_flow_modify, target: IDS.can_flow_mod_capture, sourceHandle: "mod_other" },
          { id: `e_${IDS.can_flow_mod_capture}_chk`, source: IDS.can_flow_mod_capture, target: IDS.can_flow_mod_check },
          { id: `e_${IDS.can_flow_mod_check}_addr`, source: IDS.can_flow_mod_check, target: IDS.can_flow_addr_sync, sourceHandle: "true" },
          { id: `e_${IDS.can_flow_mod_check}_oth`, source: IDS.can_flow_mod_check, target: postModFailNode, sourceHandle: "false" },
          { id: `e_${IDS.can_flow_addr_sync}_ok`, source: IDS.can_flow_addr_sync, target: IDS.can_flow_addr_ok, sourceHandle: "success" },
          { id: `e_${IDS.can_flow_addr_sync}_fail`, source: IDS.can_flow_addr_sync, target: postModFailNode, sourceHandle: "error" },
          { id: `e_${IDS.can_flow_addr_ok}_mm`, source: IDS.can_flow_addr_ok, target: IDS.main_menu },
          ...(useAdminAlerts
            ? [{ id: `e_${IDS.can_flow_mod_alert}_dn`, source: IDS.can_flow_mod_alert, target: IDS.can_flow_mod_done }]
            : []),
          { id: `e_${IDS.can_flow_mod_done}_mm`, source: IDS.can_flow_mod_done, target: IDS.main_menu },
        ]
      : []),
  );

  nodes.push({
    id: IDS.can_logic,
    type: "logic",
    position: flowPos(8, 11),
    data: {
      label: "Order already shipped?",
      variable: "is_shipped",
      operator: "eq",
      value: "true",
      heatmapCount: 0,
    },
  });

  return {
    nodes,
    edges,
    menuRow: {
      id: "mnu_cancel",
      title: F.enableReturnsRefunds ? "📦 Orders & returns" : "❌ Cancel / Modify Order",
      description: F.enableReturnsRefunds ? "Cancel, modify, or return" : "Change or cancel an order",
    },
    entryNodeId: IDS.can_flow_ask,
    sourceHandle: "mnu_cancel",
  };
}

function buildAiHelpDeskBranch(ctx, IDS) {
  const { F } = ctx;
  const nodes = [
    {
      id: IDS.ai_capture,
      type: "capture_input",
      position: flowPos(5, 20),
      data: {
        label: "AI help — describe issue",
        variable: "customer_issue",
        question:
          "🆘 *I'm here to help!*\n\nTell me what's going on — describe your issue in as much detail as you like.",
        text:
          "🆘 *I'm here to help!*\n\nTell me what's going on — describe your issue in as much detail as you like.",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.ai_respond,
      type: "message",
      position: flowPos(6, 20),
      data: {
        label: "AI response",
        text: "{{ai_response}}",
        isAiResponse: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.ai_check,
      type: "logic",
      position: flowPos(7, 20),
      data: {
        label: "Needs human?",
        variable: "ai_needs_human",
        operator: "eq",
        value: "true",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.ai_escalate,
      type: "message",
      position: flowPos(8, 20),
      data: {
        label: "Escalate to human",
        text:
          "🤔 That's a tricky one — I'm connecting you with our support team now. They'll reply on this chat shortly!",
        heatmapCount: 0,
      },
    },
  ];
  const edges = [
    { id: `e_${IDS.ai_capture}_rsp`, source: IDS.ai_capture, target: IDS.ai_respond },
    { id: `e_${IDS.ai_respond}_chk`, source: IDS.ai_respond, target: IDS.ai_check },
    { id: `e_${IDS.ai_check}_esc`, source: IDS.ai_check, target: IDS.ai_escalate, sourceHandle: "true" },
    { id: `e_${IDS.ai_check}_mm`, source: IDS.ai_check, target: IDS.main_menu, sourceHandle: "false" },
    { id: `e_${IDS.ai_escalate}_sp`, source: IDS.ai_escalate, target: IDS.sup_capture },
  ];
  return {
    nodes,
    edges,
    menuRow: { id: "mnu_ai", title: "💬 Quick Question" },
    entryNodeId: IDS.ai_capture,
    sourceHandle: "mnu_ai",
  };
}

function buildOrderBranch(ctx, IDS, content) {
  const { F } = ctx;
  const nodes = [], edges = [];

  nodes.push(
    {
      id: IDS.ord_ask,
      type: "capture_input",
      position: flowPos(4, 4),
      data: {
        label: "Track — ask identifier",
        variable: "order_identifier",
        question:
          "📦 *Let's track your order!*\n\nShare your *Order ID* (e.g. #1042) or the *mobile number* used at checkout.",
        text:
          "📦 *Let's track your order!*\n\nShare your *Order ID* (e.g. #1042) or the *mobile number* used at checkout.",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.ord_track,
      type: "shopify_call",
      position: flowPos(5, 4),
      data: {
        label: "Check Order Status",
        action: "CHECK_ORDER_STATUS",
        queryVariable: "order_identifier",
        silent: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.ord_status_msg,
      type: "message",
      position: flowPos(6, 4),
      data: {
        label: "Order status (flow)",
        text: withMenuHint(content.order_status_msg),
        heatmapCount: 0
      }
    },
    {
      id: IDS.ord_notfound,
      type: "capture_input",
      position: flowPos(6, 3),
      data: {
        label: "Order ID Request",
        variable: "order_id_manual",
        question: content.order_not_found_prompt,
        text: content.order_not_found_prompt,
        heatmapCount: 0,
      },
    },
    {
      id: `${IDS.ord_track}_retry`,
      type: "shopify_call",
      position: flowPos(5, 3),
      data: {
        label: "Retry order lookup",
        action: "CHECK_ORDER_STATUS",
        queryVariable: "order_id_manual",
        silent: true,
        heatmapCount: 0,
      },
    }
  );
  edges.push(
    { id: `e_${IDS.ord_ask}_tr`, source: IDS.ord_ask, target: IDS.ord_track },
    { id: `e_${IDS.ord_track}_nf`, source: IDS.ord_track, target: IDS.ord_notfound, sourceHandle: "not_found" },
    { id: `e_${IDS.ord_track}_ok`, source: IDS.ord_track, target: IDS.ord_status_msg, sourceHandle: "success" },
    { id: `e_${IDS.ord_notfound}_retry`, source: IDS.ord_notfound, target: `${IDS.ord_track}_retry` },
    { id: `e_${IDS.ord_track}_retry_ok`, source: `${IDS.ord_track}_retry`, target: IDS.ord_status_msg, sourceHandle: "success" },
    { id: `e_${IDS.ord_track}_retry_nf`, source: `${IDS.ord_track}_retry`, target: IDS.main_menu, sourceHandle: "not_found" }
  );

  return {
    nodes,
    edges,
    menuRow: { id: "mnu_track", title: "📦 Track My Order" },
    entryNodeId: IDS.ord_ask,
    sourceHandle: "mnu_track",
  };
}

function buildReturnsBranch(ctx, IDS, content) {
  const { F, returnsInfo, adminPhone, client } = ctx;
  const nodes = [], edges = [];

  nodes.push(
    { id: IDS.ret_hub, type: "interactive", position: flowPos(5, 8),
      data: { label: "Returns Hub", interactiveType: "button",
        text: "How can {{brand_name}} help with returns or refunds?",
        buttonsList: [
          { id: "return", title: "📸 Start Return" },
          { id: "refund", title: "💸 Refund Status" },
          { id: "menu",   title: "⬅️ Main Menu" }
        ], heatmapCount: 0 } },
    { id: IDS.ret_reason, type: "capture_input", position: flowPos(6, 7),
      data: { label: "Return Reason", variable: "return_reason",
        question: "Briefly describe why you want to return this item.",
        text: "Briefly describe why you want to return this item.", heatmapCount: 0 } },
    { id: IDS.ret_photo, type: "capture_input", position: flowPos(7, 7),
      data: { label: "Return Photo", variable: "return_photo",
        question: content.return_photo_prompt, text: content.return_photo_prompt, heatmapCount: 0 } },
    { id: IDS.ret_confirm, type: "message", position: flowPos(8, 7),
      data: { label: "Return Confirmed",
        text: "✅ Return request logged for *{{order_number}}*. Our team will update you within 24–48 hours on WhatsApp.",
        heatmapCount: 0 } },
    { id: IDS.ret_tag, type: "tag_lead", position: flowPos(9, 7),
      data: { label: "Tag return", action: "add", tag: "return-open", heatmapCount: 0 } },
    { id: IDS.ref_check, type: "shopify_call", position: flowPos(6, 9),
      data: { label: "Refund Status", action: "ORDER_REFUND_STATUS", heatmapCount: 0 } },
    { id: IDS.ref_result, type: "message", position: flowPos(7, 9),
      data: { label: "Refund Result", text: "For *{{brand_name}}* orders, refunds usually post within *5–7 business days* depending on your bank.", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_${IDS.ret_hub}_r`,     source: IDS.ret_hub,    target: IDS.ret_reason, sourceHandle: "return" },
    { id: `e_${IDS.ret_hub}_ref`,   source: IDS.ret_hub,    target: IDS.ref_check,  sourceHandle: "refund" },
    { id: `e_${IDS.ret_hub}_menu`,  source: IDS.ret_hub,    target: IDS.main_menu,  sourceHandle: "menu" },
    { id: `e_${IDS.ret_reason}_p`,  source: IDS.ret_reason, target: IDS.ret_photo },
    { id: `e_${IDS.ret_photo}_c`,   source: IDS.ret_photo,  target: IDS.ret_confirm },
    { id: `e_${IDS.ret_confirm}_tg`, source: IDS.ret_confirm, target: IDS.ret_tag },
    { id: `e_${IDS.ref_check}_r`,   source: IDS.ref_check,  target: IDS.ref_result },
    { id: `e_${IDS.ref_result}_mm`, source: IDS.ref_result, target: IDS.main_menu }
  );

  if (F.enableAdminAlerts) {
    nodes.push({
      id: IDS.ret_admin,
      type: "admin_alert",
      position: flowPos(10, 8),
      data: {
        label: "Return admin alert",
        priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "Return request — {{brand_name}}",
        messageBody: "Customer {{customer_name|Unknown}} ({{phone}}) started a return for *{{order_number}}*.",
        heatmapCount: 0
      }
    });
    edges.push({ id: `e_${IDS.ret_tag}_ad`, source: IDS.ret_tag, target: IDS.ret_admin });
    if (returnsInfo) {
      nodes.push({
        id: IDS.ret_policy,
        type: "message",
        position: flowPos(11, 8),
        data: { label: "Return Policy", text: returnsInfo, heatmapCount: 0 }
      });
      edges.push(
        { id: `e_${IDS.ret_admin}_pol`, source: IDS.ret_admin, target: IDS.ret_policy },
        { id: `e_${IDS.ret_policy}_mm`, source: IDS.ret_policy, target: IDS.main_menu }
      );
    } else {
      edges.push({ id: `e_${IDS.ret_admin}_mm`, source: IDS.ret_admin, target: IDS.main_menu });
    }
  } else if (returnsInfo) {
    nodes.push({
      id: IDS.ret_policy, type: "message", position: flowPos(11, 8),
      data: { label: "Return Policy", text: returnsInfo, heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.ret_tag}_pol`, source: IDS.ret_tag, target: IDS.ret_policy },
      { id: `e_${IDS.ret_policy}_mm`, source: IDS.ret_policy, target: IDS.main_menu }
    );
  } else {
    edges.push({ id: `e_${IDS.ret_tag}_mm`, source: IDS.ret_tag, target: IDS.main_menu });
  }

  const out = {
    nodes,
    edges,
    entryNodeId: IDS.ret_hub,
    sourceHandle: "returns",
  };
  if (!F.enableCancelOrder) {
    out.menuRow = { id: "returns", title: "🔄 Return / Refund", description: "Start a return or check refund" };
  }
  return out;
}

function buildWarrantyBranch(ctx, IDS, content) {
  void content;
  const nodes = [
    {
      id: IDS.war_engine,
      type: "warranty_check",
      position: flowPos(6, 11),
      data: {
        label: "Warranty Lookup",
        heatmapCount: 0,
      },
    },
  ];

  const edges = [
    {
      id: `e_${IDS.war_engine}_mm`,
      source: IDS.war_engine,
      target: IDS.main_menu,
      sourceHandle: "bottom",
    },
  ];

  return {
    nodes,
    edges,
    menuRow: { id: "mnu_warranty", title: "🛡️ Warranty Details" },
    entryNodeId: IDS.war_engine,
    sourceHandle: "mnu_warranty",
  };
}

/** Help with order — tracking issues, returns, optional install guide (wizard: enableInstallSupport). */
function buildInstallSupportBranch(ctx, IDS, content) {
  const { F, adminPhone, client } = ctx;
  const nodes = [];
  const edges = [];
  const useAdminAlerts = F.enableAdminAlerts !== false;
  const postHelpNode = useAdminAlerts ? IDS.help_alert : IDS.help_done;
  const hasInstall = F.helpIncludeInstallGuide !== false;
  const lib = ctx.productGuideLibrary || client?.productGuideLibrary || {};
  const guideCategories = Array.isArray(lib.categories)
    ? lib.categories.filter((c) => (c.products || []).some((p) => {
        const g = p.installGuide || {};
        return g.summary || (g.steps && g.steps.length) || g.videoUrl || g.manualUrl;
      }))
    : [];
  const hasGuideLibrary = guideCategories.length > 0;

  const helpRows = [
    { id: "help_not_received", title: "📦 Order not received", description: "Delayed or missing" },
    { id: "help_damaged", title: "💔 Damaged / wrong item", description: "Report an issue" },
    { id: "help_return", title: "↩️ Return / exchange", description: "Start a return" },
  ];
  if (hasInstall) {
    helpRows.push({
      id: "help_install",
      title: "🔧 Installation help",
      description: "Setup guidance",
    });
  }
  helpRows.push({ id: "help_other", title: "❓ Something else", description: "Describe issue" });

  nodes.push(
    {
      id: IDS.help_ask,
      type: "capture_input",
      position: flowPos(5, 16),
      data: {
        label: "Help — identifier",
        variable: "help_identifier",
        question:
          "🤝 *I'm here to help!*\n\nShare your *Order ID* or *phone number*, then tell us what you need.",
        text:
          "🤝 *I'm here to help!*\n\nShare your *Order ID* or *phone number*, then tell us what you need.",
        heatmapCount: 0,
      },
    },
    {
      id: IDS.help_lookup,
      type: "shopify_call",
      position: flowPos(6, 16),
      data: {
        label: "Help order lookup",
        action: "CHECK_ORDER_STATUS",
        queryVariable: "help_identifier",
        silent: true,
        heatmapCount: 0,
      },
    },
    {
      id: IDS.help_menu,
      type: "interactive",
      position: flowPos(7, 16),
      data: {
        label: "Help issue menu",
        interactiveType: "list",
        buttonText: "Select issue",
        text: "I found your order *{{order_number|details}}*. What do you need help with?",
        sections: [{ title: "Select your issue", rows: helpRows }],
        heatmapCount: 0,
      },
    },
    {
      id: IDS.help_not_found,
      type: "message",
      position: flowPos(7, 17),
      data: {
        label: "Order not found (help)",
        text:
          "🔍 We couldn't find that order.\n\nDouble-check your *Order ID* or try the phone used at checkout. Type *menu* to go back.",
        heatmapCount: 0,
      },
    }
  );

  if (hasInstall && hasGuideLibrary) {
    nodes.push(
      {
        id: IDS.guide_cat_list,
        type: "install_guide_entry",
        position: flowPos(8, 14),
        data: {
          label: "Install guide — categories",
          text: "🔧 *Installation help*\n\nWhich product category?",
          heatmapCount: 0,
        },
      },
      {
        id: IDS.guide_prod_list,
        type: "interactive",
        position: flowPos(9, 14),
        data: {
          label: "Install guide — products",
          interactiveType: "list",
          buttonText: "Choose product",
          text: "Pick the product you need setup help for.",
          dynamicSections: true,
          dynamicSectionsVariable: "guide_products",
          heatmapCount: 0,
        },
      },
      {
        id: IDS.guide_send,
        type: "message",
        position: flowPos(10, 14),
        data: {
          label: "Install guide message",
          text: "🔧 Setup steps are sent dynamically from your product guide library.",
          heatmapCount: 0,
        },
      }
    );
  } else if (hasInstall) {
    nodes.push({
      id: IDS.help_install_msg,
      type: "message",
      position: flowPos(8, 15),
      data: {
        label: "Install guide",
        text:
          String(F.installSupportPrompt || "").trim() ||
          "🔧 For setup help, share your *product name* and a short video/photo of the issue. Our team will guide you step by step on *{{support_phone|our support line}}*.",
        heatmapCount: 0,
      },
    });
  }

  nodes.push(
    {
      id: IDS.help_other_cap,
      type: "capture_input",
      position: flowPos(8, 15),
      data: {
        label: "Help — describe issue",
        variable: "help_issue_detail",
        question: "Please describe your issue in a few words so our team can help faster.",
        text: "Please describe your issue in a few words so our team can help faster.",
        heatmapCount: 0,
      },
    },
    ...(useAdminAlerts
      ? [{
      id: IDS.help_alert,
      type: "admin_alert",
      position: flowPos(8, 16),
      data: {
        label: "Help request alert",
        priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "Order help — {{order_number}}",
        customMessage:
          "Customer ({{phone}}) needs help with order *{{order_number}}*.\nIssue: {{help_issue_type|General}}\nDetails: {{help_issue_detail|—}}",
        phone: adminPhone || client.adminPhone || "",
        heatmapCount: 0,
      },
    }]
      : []),
    {
      id: IDS.help_done,
      type: "message",
      position: flowPos(9, 16),
      data: {
        label: "Help request received",
        text:
          "✅ *We've received your request.*\n\nOur team will reply on this chat within *2–4 hours*. For urgent issues, call *{{support_phone|our support line}}*.",
        heatmapCount: 0,
      },
    }
  );

  edges.push(
    { id: `e_${IDS.help_ask}_lk`, source: IDS.help_ask, target: IDS.help_lookup },
    { id: `e_${IDS.help_lookup}_ok`, source: IDS.help_lookup, target: IDS.help_menu, sourceHandle: "success" },
    { id: `e_${IDS.help_lookup}_nf`, source: IDS.help_lookup, target: IDS.help_not_found, sourceHandle: "not_found" },
    { id: `e_${IDS.help_not_found}_mm`, source: IDS.help_not_found, target: IDS.main_menu },
  );

  if (hasInstall && hasGuideLibrary) {
    edges.push(
      { id: `e_${IDS.help_menu}_inst`, source: IDS.help_menu, target: IDS.guide_cat_list, sourceHandle: "help_install" },
      { id: `e_${IDS.guide_cat_list}_mm`, source: IDS.guide_cat_list, target: IDS.main_menu },
      { id: `e_${IDS.guide_prod_list}_mm`, source: IDS.guide_prod_list, target: IDS.main_menu },
      { id: `e_${IDS.guide_send}_mm`, source: IDS.guide_send, target: IDS.main_menu }
    );
  } else if (hasInstall) {
    edges.push(
      { id: `e_${IDS.help_menu}_inst`, source: IDS.help_menu, target: IDS.help_install_msg, sourceHandle: "help_install" },
      { id: `e_${IDS.help_install_msg}_mm`, source: IDS.help_install_msg, target: IDS.main_menu }
    );
  }

  edges.push(
    { id: `e_${IDS.help_menu}_nr`, source: IDS.help_menu, target: postHelpNode, sourceHandle: "help_not_received" },
    { id: `e_${IDS.help_menu}_dm`, source: IDS.help_menu, target: postHelpNode, sourceHandle: "help_damaged" },
    {
      id: `e_${IDS.help_menu}_rt`,
      source: IDS.help_menu,
      target: F.enableReturnsRefunds ? IDS.ret_hub : postHelpNode,
      sourceHandle: "help_return",
    },
    { id: `e_${IDS.help_menu}_ot`, source: IDS.help_menu, target: IDS.help_other_cap, sourceHandle: "help_other" },
    { id: `e_${IDS.help_other_cap}_al`, source: IDS.help_other_cap, target: postHelpNode },
    ...(useAdminAlerts
      ? [{ id: `e_${IDS.help_alert}_dn`, source: IDS.help_alert, target: IDS.help_done }]
      : []),
    { id: `e_${IDS.help_done}_mm`, source: IDS.help_done, target: IDS.main_menu }
  );

  const out = {
    nodes,
    edges,
    entryNodeId: IDS.help_ask,
    sourceHandle: "mnu_help",
  };
  if (!F.enableAIFallback) {
    out.menuRow = { id: "mnu_help", title: "🤝 Order Help", description: "Delivery issues, returns & support" };
  }
  return out;
}

function buildSupportBranch(ctx, IDS, content) {
  const { F, openTime, closeTime, workingDays, adminPhone, client } = ctx;
  const nodes = [], edges = [];

  // Optional business-hours gate
  if (F.enableBusinessHoursGate && !F.enable247) {
    nodes.push(
      { id: IDS.sup_sch, type: "schedule", position: flowPos(5, 17),
        data: { label: "Business Hours Gate", openTime, closeTime, days: workingDays,
          closedMessage: content.support_schedule_closed_nudge, heatmapCount: 0 } },
      { id: IDS.sup_closed, type: "message", position: flowPos(6, 18),
        data: { label: "After Hours", text: content.support_hours_msg, heatmapCount: 0 } }
    );
    edges.push(
      { id: `e_${IDS.sup_sch}_open`, source: IDS.sup_sch, target: IDS.sup_capture, sourceHandle: "open" },
      { id: `e_${IDS.sup_sch}_cl`,   source: IDS.sup_sch, target: IDS.sup_closed,  sourceHandle: "closed" }
    );
  }

  nodes.push(
    { id: IDS.sup_capture, type: "capture_input", position: flowPos(6, 17),
      data: {
        label: "Agent — describe issue",
        variable: "agent_issue_description",
        question:
          "👨‍💼 *Connect with our team*\n\nBriefly describe what you need help with (e.g. damaged product, wrong item, return label).",
        text:
          "👨‍💼 *Connect with our team*\n\nBriefly describe what you need help with (e.g. damaged product, wrong item, return label).",
        heatmapCount: 0,
      } },
    { id: IDS.sup_tag, type: "tag_lead", position: flowPos(7, 17),
      data: { label: "Tag Pending Human", action: "add", tag: "pending-human", heatmapCount: 0 } },
    { id: IDS.sup_confirm, type: "message", position: flowPos(9, 17),
      data: { label: "Handoff Confirmed", text: content.agent_handoff_msg,
        humanEscalationTimeoutMin: F.humanEscalationTimeoutMin, heatmapCount: 0 } },
    { id: IDS.sup_livechat, type: "livechat", position: flowPos(10, 17),
      data: {
        label: "Live chat handoff",
        topic: "Customer requested human support — {{brand_name}}",
        handoffMessage:
          content.livechat_queue_body ||
          content.agent_handoff_msg ||
          "Connecting you with our team on WhatsApp. Please stay on this chat — an agent will reply shortly.",
        text:
          content.livechat_queue_body ||
          content.agent_handoff_msg ||
          "Connecting you with our team on WhatsApp. Please stay on this chat — an agent will reply shortly.",
        flowTerminal: true,
        suppressAIFallbackLink: true,
        heatmapCount: 0,
      } }
  );
  edges.push({ id: `e_${IDS.sup_capture}_tag`, source: IDS.sup_capture, target: IDS.sup_tag });

  if (F.enableAdminAlerts) {
    nodes.push({
      id: IDS.sup_alert,
      type: "admin_alert",
      position: flowPos(8, 17),
      data: {
        label: "Admin Alert",
        priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "Agent request — {{brand_name}}",
        customMessage:
          "Customer {{customer_name|Unknown}} ({{phone}}) requested an agent.\n\nIssue: {{agent_issue_description|No details provided}}",
        phone: adminPhone || client.adminPhone || "",
        heatmapCount: 0,
      },
    });
    edges.push(
      { id: `e_${IDS.sup_tag}_al`, source: IDS.sup_tag, target: IDS.sup_alert },
      { id: `e_${IDS.sup_alert}_cf`, source: IDS.sup_alert, target: IDS.sup_confirm },
      { id: `e_${IDS.sup_confirm}_lc`, source: IDS.sup_confirm, target: IDS.sup_livechat }
    );
  } else {
    edges.push(
      { id: `e_${IDS.sup_tag}_cf`, source: IDS.sup_tag, target: IDS.sup_confirm },
      { id: `e_${IDS.sup_confirm}_lc`, source: IDS.sup_confirm, target: IDS.sup_livechat }
    );
  }

  if (F.enableBusinessHoursGate && !F.enable247) {
    edges.push({ id: `e_${IDS.sup_closed}_mm`, source: IDS.sup_closed, target: IDS.main_menu });
  }

  return {
    nodes,
    edges,
    menuRow: { id: "mnu_agent", title: "👤 Talk to Our Team" },
    entryNodeId: F.enableBusinessHoursGate && !F.enable247 ? IDS.sup_sch : IDS.sup_capture,
    sourceHandle: "mnu_agent",
  };
}

function buildFAQBranch(ctx, IDS, content) {
  const { faqText } = ctx;
  const faqBody = (typeof faqText === 'string' && faqText.trim())
    ? faqText.trim()
    : (content.faq_response || 'Here are quick answers — type *menu* anytime to go back.');
  const nodes = [{
    id: IDS.faq_msg, type: "message", position: flowPos(5, 19),
    data: { label: "General FAQ", text: faqBody, heatmapCount: 0 }
  }];
  const edges = [{ id: `e_${IDS.faq_msg}_mm`, source: IDS.faq_msg, target: IDS.main_menu }];
  return {
    nodes, edges,
    menuRow: { id: "faq", title: "❓ FAQs" },
    entryNodeId: IDS.faq_msg,
    sourceHandle: "faq"
  };
}

function buildAbandonedCart(ctx, IDS, content, opts = {}) {
  const { cartTiming } = ctx;
  const terminalId = opts.terminalNodeId || IDS.main_menu;
  const nodes = [{
    id: IDS.trig_cart, type: "trigger", position: autoPos(0, 2),
    data: { label: "Abandoned Cart Trigger", triggerType: "abandoned_cart", heatmapCount: 0 }
  }];
  const edges = [];
  const maxSteps = typeof opts.maxSteps === "number" ? Math.min(3, Math.max(1, opts.maxSteps)) : 3;
  const steps = [
    { delay: cartTiming.msg1, unit: "minutes", text: content.cart_recovery_1 },
    { delay: cartTiming.msg2, unit: "hours",   text: content.cart_recovery_2 },
    { delay: cartTiming.msg3, unit: "hours",   text: content.cart_recovery_3 }
  ].slice(0, maxSteps);
  let prev = IDS.trig_cart;
  steps.forEach((step, i) => {
    const dId = `cart_delay_${i}_${IDS.seed}`;
    const mId = `cart_msg_${i}_${IDS.seed}`;
    const msgData = {
      label: `Cart Recovery ${i + 1}`,
      text: step.text,
      heatmapCount: 0,
      suppressAIFallbackLink: false,
    };
    if (i === 0) {
      msgData.imageUrl = '{{first_product_image}}';
    }
    nodes.push(
      { id: dId, type: "delay", position: autoPos(i * 2, 4),
        data: { label: `Wait ${step.delay} ${step.unit}`, duration: step.delay, unit: step.unit, waitValue: step.delay, waitUnit: step.unit, heatmapCount: 0 } },
      { id: mId, type: "message", position: autoPos(i * 2 + 1, 4),
        data: msgData }
    );
    edges.push({ id: `e_${prev}_d${i}`, source: prev, target: dId });
    edges.push({ id: `e_${dId}_m${i}`,  source: dId,  target: mId });
    prev = mId;
  });
  const lastMsgId = `cart_msg_${steps.length - 1}_${IDS.seed}`;
  edges.push({ id: `e_${lastMsgId}_term`, source: lastMsgId, target: terminalId });
  return { nodes, edges };
}

function buildB2BBranch(ctx, IDS) {
  const { adminPhone, client } = ctx;
  const nodes = [
    { id: IDS.b2b_trigger, type: "trigger", position: autoPos(0, 9),
      data: { label: "B2B Trigger", triggerType: "keyword",
        keywords: ["wholesale", "bulk", "b2b", "dealer", "distributor"], matchMode: "contains", heatmapCount: 0 } },
    { id: IDS.b2b_capture, type: "capture_input", position: autoPos(1, 9),
      data: { label: "B2B Requirement", variable: "b2b_requirement",
        question: "Please share company name and monthly requirement.",
        text: "Please share company name and monthly requirement.", heatmapCount: 0 } },
    { id: IDS.b2b_tag, type: "tag_lead", position: autoPos(2, 9),
      data: { label: "Tag B2B", action: "add", tag: "b2b-prospect", heatmapCount: 0 } },
    { id: IDS.b2b_alert, type: "admin_alert", position: autoPos(3, 9),
      data: { label: "B2B Alert", priority: "high",
        notifyChannels: ["Email", "Dashboard"],
        topic: "B2B Lead — {{brand_name}}",
        messageBody: "New wholesale inquiry from {{phone}}: {{b2b_requirement}}",
        heatmapCount: 0 } },
    { id: IDS.b2b_confirm, type: "message", position: autoPos(4, 9),
      data: { label: "B2B Confirm",
        text: "Thanks — *{{brand_name}}* wholesale will reach out on WhatsApp with pricing and MOQs.", heatmapCount: 0 } }
  ];
  const edges = [
    { id: `e_${IDS.b2b_trigger}_c`, source: IDS.b2b_trigger, target: IDS.b2b_capture },
    { id: `e_${IDS.b2b_capture}_t`, source: IDS.b2b_capture, target: IDS.b2b_tag },
    { id: `e_${IDS.b2b_tag}_a`,     source: IDS.b2b_tag,     target: IDS.b2b_alert },
    { id: `e_${IDS.b2b_alert}_cf`,  source: IDS.b2b_alert,   target: IDS.b2b_confirm },
    { id: `e_${IDS.b2b_confirm}_mm`, source: IDS.b2b_confirm, target: IDS.main_menu }
  ];
  return { nodes, edges };
}

function buildAIFallback(ctx, IDS) {
  const fb =
    (ctx.fallbackMessage && String(ctx.fallbackMessage).trim()) ||
    "Thanks for your message — *{{bot_name}}* at *{{brand_name}}* is here to help. Tap *menu* to see options.";
  return {
    nodes: [{
      id: IDS.ai_fallback, type: "message", position: flowPos(1, -1),
      data: { label: "🤖 AI Smart Reply", action: "AI_FALLBACK",
        text: fb, heatmapCount: 0 }
    }],
    edges: []
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 5. ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════════
async function generateEcommerceFlow(client, wizardData = {}) {
  const mergedWizard = { ...wizardData };
  const rawProducts = mergedWizard.products;
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) {
    const clientIdStr = resolvePersistedClientId(client);
    if (clientIdStr) {
      try {
        const ShopifyProduct = require("../../models/ShopifyProduct");
        const docs = await ShopifyProduct.find({ clientId: clientIdStr, status: { $ne: "draft" } })
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(120)
          .lean();
        const picked = docs
          .filter((d) => d && (d.shopifyId || d.id))
          .slice(0, 40)
          .map((d, i) => buildProductContext(d, i));
        if (picked.length) mergedWizard.products = picked;
      } catch (err) {
        console.warn("[flowGenerator] ShopifyProduct preload skipped:", err?.message || err);
      }
    }
  }

  const rawCols = mergedWizard.collections;
  if ((!Array.isArray(rawCols) || rawCols.length === 0)) {
    const clientIdStr = resolvePersistedClientId(client);
    if (clientIdStr) {
      try {
        const ShopifyCollection = require("../../models/ShopifyCollection");
        const docs = await ShopifyCollection.find({ clientId: clientIdStr })
          .sort({ sortOrder: 1, title: 1 })
          .limit(200)
          .lean();
        const picked = sortShopCollectionsForMenu(
          docs
            .filter((d) => d && d.shopifyCollectionId && d.whatsappEnabled !== false)
            .map((d) => ({
              shopifyCollectionId: String(d.shopifyCollectionId || "").trim(),
              title: String(d.title || "").trim(),
              whatsappMenuLabel: String(d.whatsappMenuLabel || d.title || "").trim(),
              productsCount: Number(d.productsCount) || 0,
            }))
            .filter((c) => c.shopifyCollectionId)
        );
        if (picked.length) mergedWizard.collections = picked;
      } catch (err) {
        console.warn("[flowGenerator] ShopifyCollection preload skipped:", err?.message || err);
      }
    }
  }

  const ctx = buildContext(client, mergedWizard);
  const IDS = buildIDs(client, mergedWizard);
  const F = ctx.F;

  // Marketing copy (best-effort)
  const defaults = buildDefaultContent(ctx);
  const ai = mergedWizard.useAiCopy === true ? await generateAIContent(ctx) : {};
  const content = { ...defaults, ...ai };

  // AI fallback first so other branches can reference IDS.ai_fallback
  const fallbackOut = buildAIFallback(ctx, IDS);

  // Always use interactive/message welcome path (no welcome template dependency).
  const entryOut   = buildEntry(ctx, IDS, content, null);

  // Branch builders — call only the enabled ones
  const branches = [];
  if (F.enableCatalog)           branches.push(buildCatalogBranch(ctx, IDS));
  if (F.enableOrderTracking)     branches.push(buildOrderBranch(ctx, IDS, content));
  if (F.enableCancelOrder)       branches.push(buildCancelOrderBranch(ctx, IDS, content));
  if (F.enableReturnsRefunds)    branches.push(buildReturnsBranch(ctx, IDS, content));
  if (F.enableWarranty)          branches.push(buildWarrantyBranch(ctx, IDS, content));
  if (F.enableInstallSupport)    branches.push(buildInstallSupportBranch(ctx, IDS, content));
  if (F.enableAIFallback)        branches.push(buildAiHelpDeskBranch(ctx, IDS));
  if (F.enableFAQ && !F.enableInstallSupport) branches.push(buildFAQBranch(ctx, IDS, content));
  if (F.enableSupportEscalation) branches.push(buildSupportBranch(ctx, IDS, content));

  // Build the menu using only enabled branches' rows (deduped, ≤8 for WhatsApp).
    const menuRows = consolidateMenuRows(branches, F);
    const menuOut  = buildMainMenu(ctx, IDS, menuRows, content);

  // Wire menu → branch entries
  const menuEdges = branches
    .filter(b => b.menuRow && b.entryNodeId)
    .map(b => ({
      id: `e_${IDS.main_menu}_${b.sourceHandle}`,
      source: IDS.main_menu,
      target: b.entryNodeId,
      sourceHandle: b.sourceHandle
    }));

  // Commerce automations (cart, order confirm, reviews) are merged into this single graph
  // so merchants publish one WhatsApp flow document. Webhooks still match triggers by node.
  const commerceSlices = [];
  const splitAuto = !!mergedWizard._splitAutomations;
  if (!splitAuto && F.enableAbandonedCart) commerceSlices.push(buildAbandonedCart(ctx, IDS, content));
  // Order placed + COD confirmation run via Order messages (sys_commerce_*), not embedded flow triggers.

  const b2bParallel = F.enableB2BWholesale ? buildB2BBranch(ctx, IDS) : { nodes: [], edges: [] };

  const allNodes = [
    ...fallbackOut.nodes,
    ...entryOut.nodes,
    ...menuOut.nodes,
    ...branches.flatMap(b => b.nodes),
    ...b2bParallel.nodes,
    ...commerceSlices.flatMap((g) => g.nodes),
  ];
  const allEdges = [
    ...fallbackOut.edges,
    ...entryOut.edges,
    ...menuOut.edges,
    ...menuEdges,
    ...branches.flatMap(b => b.edges),
    ...b2bParallel.edges,
    ...commerceSlices.flatMap((g) => g.edges),
  ];

  // De-duplicate by ID (defensive — should never fire if builders behave)
  const seenN = new Set();
  const dedupNodes = allNodes.filter(n => { if (!n.id || seenN.has(n.id)) return false; seenN.add(n.id); return true; });
  const seenE = new Set();
  const dedupEdges = allEdges.filter(e => { if (!e.id || seenE.has(e.id)) return false; seenE.add(e.id); return true; });

  // Wire remaining dead-ends to main menu (keeps inbox flows resumable; AI fallback still exists for unwired taps)
  if (F.enableAIFallback) {
    const sources = new Set(dedupEdges.map(e => e.source));
    const deadEndTypes = ["shopify_call", "tag_lead", "review", "warranty_check", "cod_prepaid", "admin_alert"];
    dedupNodes.forEach(node => {
      if (node.data?.suppressAIFallbackLink) return;
      if (deadEndTypes.includes(node.type) && !sources.has(node.id) && node.id !== IDS.ai_fallback && node.id !== IDS.main_menu) {
        dedupEdges.push({
          id: `e_menu_autowire_${node.id}`,
          source: node.id,
          target: IDS.main_menu,
          animated: false,
          style: { strokeDasharray: "4 4", stroke: "#94a3b8", opacity: 0.35 }
        });
      }
    });
  }

  // Verify
  verifyAllEdgesMatchButtonIds(dedupNodes, dedupEdges);
  if (!verifyFlowIntegrity(dedupNodes, dedupEdges)) {
    throw new Error("Flow integrity validation failed");
  }

  // Strip orphans (nodes with no edges, except triggers + fallback)
  const connected = new Set([...dedupEdges.map(e => e.source), ...dedupEdges.map(e => e.target)]);
  const cleanNodes = dedupNodes.filter(n => connected.has(n.id) || n.type === "trigger" || n.id === IDS.ai_fallback);
  const cleanEdges = dedupEdges.filter(e => connected.has(e.source) && connected.has(e.target));

  const { stampLayoutSections } = require('./flowLayoutOrganize');
  return {
    nodes: stampLayoutSections(cleanNodeText(cleanNodes)),
    edges: cleanEdges,
    automationFlows: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 5b. COMMERCE WIZARD PACK — one publishable WhatsApp flow (Meta allows one active).
//     Cart / COD / review automations live in the same graph; triggerEngine matches
//     trigger nodes by event type. Canvas folders (parentId) mirror Apex Light layout.
// ═════════════════════════════════════════════════════════════════════════

async function generateCommerceWizardPack(client, body = {}) {
  const { buildWizardDataFromUniversal } = require('../commerce/universalCommerceMapper');
  const { organizeFlowGraph, stampLayoutSections } = require('./flowLayoutOrganize');
  const merged = buildWizardDataFromUniversal(client, body);

  // Keep all commerce slices in one graph — do NOT split into separate WhatsAppFlow docs.
  const mainWizard = { ...merged, _splitAutomations: false };
  const main = await generateEcommerceFlow(client, mainWizard);
  const stamped = stampLayoutSections(main.nodes);
  const folderized = organizeFlowGraph(stamped, main.edges, {
    keepPositions: true,
    addEntryEdges: true,
    stampSections: false,
  });

  verifyAllEdgesMatchButtonIds(folderized.nodes, folderized.edges);
  if (!verifyFlowIntegrity(folderized.nodes, folderized.edges)) {
    throw new Error("Flow integrity validation failed for main_commerce");
  }

  const flows = [
    {
      slug: "main_commerce",
      name: body.mainFlowName || `${merged.businessName || "Store"} — WhatsApp bot`,
      isAutomation: false,
      automationTrigger: "",
      nodes: folderized.nodes,
      edges: folderized.edges,
    },
  ];

  return { flows, automationFlows: [] };
}

// ═════════════════════════════════════════════════════════════════════════
// 6. SYSTEM PROMPT (used by wizard)
// ═════════════════════════════════════════════════════════════════════════
async function generateSystemPrompt(client, wizardData = {}) {
  const ctx = buildContext(client, wizardData);
  const policies = client.policies || {};
  const persona = client.ai?.persona || {};

  const featureLines = Object.entries(ctx.F)
    .filter(([k, v]) => typeof v === "boolean" && v)
    .map(([k]) => `  • ${k.replace(/^enable/, "").replace(/([A-Z])/g, " $1").trim()}`)
    .join("\n");

  const prompt = `Write a professional WhatsApp chatbot system prompt for ${ctx.businessName}.
Description: ${ctx.businessDescription}
Bot Name: ${ctx.botName}
Tone: ${ctx.tone}
Persona: ${wizardData.activePersona || persona.role || "customer support specialist"} | Formality: ${wizardData.formality || persona.formality || "semi-formal"}
Language: ${ctx.botLanguage}
Business Hours: ${ctx.openTime}–${ctx.closeTime}
Currency: ${ctx.currency}
Return Policy: ${policies.returnPolicy || ctx.returnsInfo || "Standard 7-day return"}
Shipping Policy: ${policies.shippingPolicy || wizardData.shippingTime || "Standard 3-5 day shipping"}
Warranty: ${ctx.warrantyDuration}
Warranty Support Phone: ${ctx.F.warrantySupportPhone || ctx.adminPhone || "Not provided"}
Warranty Support Email: ${ctx.F.warrantySupportEmail || ctx.client?.platformVars?.supportEmail || "Not provided"}
Warranty Claim URL: ${ctx.F.warrantyClaimUrl || ctx.client?.brand?.warrantyClaimUrl || "Not provided"}
Enabled Features:
${featureLines || "  • (default e-commerce flow)"}

Products: ${ctx.products.slice(0, 5).map(p => p.title).join(", ") || "(catalog being synced)"}

Avoid these topics: ${(persona.avoidTopics || []).join(", ") || "(none specified)"}

Write a single comprehensive system prompt (4-7 sentences) that the bot will follow on every conversation. Be specific to this brand. No generic filler.`;

  try {
    const apiKey = client.ai?.geminiKey || client.geminiApiKey || process.env.GEMINI_API_KEY;
    const res = await generateText(prompt, apiKey);
    return res || `You are ${ctx.botName}, the ${ctx.tone} WhatsApp assistant for ${ctx.businessName}.`;
  } catch (_) {
    return `You are ${ctx.botName}, the ${ctx.tone} WhatsApp assistant for ${ctx.businessName}. Help customers shop, track orders, handle returns and warranty, and escalate to a human when needed.`;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 7. PRE-BUILT META TEMPLATES — catalog + library SSOT (wizardPackTemplates)
// ═════════════════════════════════════════════════════════════════════════
const { getWizardPackTemplates } = require("./wizardPackTemplates");

function getPrebuiltTemplates(wizardData = {}) {
  return getWizardPackTemplates(wizardData);
}

// ═════════════════════════════════════════════════════════════════════════
module.exports = {
  generateEcommerceFlow,
  generateCommerceWizardPack,
  generateSystemPrompt,
  getPrebuiltTemplates,
  verifyFlowIntegrity,
  buildProductContext,
  stripPlaceholders
};
