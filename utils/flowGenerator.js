"use strict";

/**
 * FLOW GENERATOR — ZERO-TOUCH MODULAR EDITION v6.0
 * ─────────────────────────────────────────────────────────────────────────
 * Each feature lives in its own pure builder function. The orchestrator
 * reads `client.wizardFeatures.*` (canonical) merged with `wizardData.features`
 * (live wizard payload) and conditionally calls the builders. The main menu
 * rows are assembled dynamically from whichever branches are enabled, so a
 * merchant who toggles loyalty OFF in Settings will instantly get a flow with
 * the loyalty row removed — no orphan nodes, no dead edges.
 *
 * GUARANTEES
 *   • Deterministic node IDs   — `${prefix}_${clientSeed}` (no Date.now)
 *     → regenerating preserves `lastStepId` on active leads
 *   • No `undefined` IDs       — all keys declared up-front in `buildIDs()`
 *   • No silent dead branches  — every dead-end node fanned to AI fallback
 *   • Verified before return   — `verifyAllEdgesMatchButtonIds` + `verifyFlowIntegrity`
 *
 * EXECUTION CONTRACT (consumed by `utils/dualBrainEngine.js`)
 *   node.type ∈ { message | interactive | template | trigger | logic |
 *                 capture_input | shopify_call | delay | loyalty_action |
 *                 admin_alert | schedule | review | cod_prepaid |
 *                 warranty_check | tag_lead | http_request }
 *   edge.{ id, source, target, sourceHandle? }
 *
 * @param {Object} client     - Mongoose Client doc
 * @param {Object} wizardData - Live wizard form payload (optional overrides)
 * @returns {{ nodes: Array, edges: Array }}
 */

const { generateJSON, generateText } = require("./gemini");
const { getCopyPack } = require("./copyPacks");

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

function cleanNodeText(nodes) {
  return nodes.map(n => {
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

/** Automation triggers (cart / order / review) — isolated left stack, no overlap with hub. */
function autoPos(col, row) {
  const DX = 440;
  const DY = 200;
  return { x: Math.round(-760 + col * DX), y: Math.round(72 + row * DY) };
}

// Copy packs live in `utils/copyPacks/*` and are selected deterministically.

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
  const features = { ...persistedFeatures, ...live };

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
    enableOrderTracking:     true,
    enableReturnsRefunds:    true,
    enableCancelOrder:       true,
    enableCodToPrepaid:      false,
    codDiscountAmount:       50,
    enableAbandonedCart:     true,
    enableCatalogCheckoutRecovery: true,
    catalogCheckoutDelayMin: 20,
    cartNudgeMinutes1:       15,
    cartNudgeHours2:         2,
    cartNudgeHours3:         24,
    enableLoyalty:           false,
    loyaltyPointsPerUnit:    10,
    loyaltySignupBonus:      100,
    loyaltySilverThreshold:  500,
    loyaltyGoldThreshold:    1500,
    enableReferral:          false,
    referralPointsBonus:     500,
    enableReviewCollection:  false,
    reviewDelayDays:         4,
    enableWarranty:          false,
    warrantyDuration:        "1 Year",
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
    ...features
  };

  return {
    client,
    wizardData,
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
    faqText:             wizardData.faqText             || persona.knowledgeBase     || "",
    returnsInfo:         wizardData.returnsInfo         || policies.returnPolicy     || "",
    fallbackMessage:     wizardData.fallbackMessage     || "I can help with that. Let me route you to the right place.",
    products:            (wizardData.products || []).slice(0, 20).map((p, i) => buildProductContext(p, i)),
    shopCollections:     (Array.isArray(wizardData.collections) ? wizardData.collections : [])
      .map((c) => ({
        shopifyCollectionId: String(c.shopifyCollectionId || c.id || "").trim(),
        title: String(c.title || "").trim(),
        whatsappMenuLabel: String(c.whatsappMenuLabel || c.title || "").trim()
      }))
      .filter((c) => c.shopifyCollectionId)
      .slice(0, 10),
    storeUrl:            wizardData.shopDomain
      ? `https://${String(wizardData.shopDomain).replace(/^https?:\/\//, "")}`
      : (wizardData.checkoutUrl || pv.checkoutUrl || "").replace(/\/checkout$/, ""),
    activePersona:       wizardData.activePersona || "sidekick",
    cartTiming: {
      msg1: F.cartNudgeMinutes1,
      msg2: F.cartNudgeHours2,
      msg3: F.cartNudgeHours3
    }
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
    ad_welcome:       `ad_welcome_${ts}`,
    ig_welcome:       `ig_welcome_${ts}`,
    main_menu:        `main_menu_${ts}`,
    // Catalog
    cat_list:         `cat_list_${ts}`,
    cat_category_menu:`cat_category_menu_${ts}`,
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
    // Loyalty
    loy_menu:         `loy_menu_${ts}`,
    loy_balance:      `loy_balance_${ts}`,
    loy_redeem:       `loy_redeem_${ts}`,
    loy_redeem_ok:    `loy_redeem_ok_${ts}`,
    loy_redeem_fail:  `loy_redeem_fail_${ts}`,
    loy_refer:        `loy_refer_${ts}`,
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
    // Order confirm + COD
    conf_msg:         `conf_msg_${ts}`,
    cod_check:        `cod_check_${ts}`,
    cod_node:         `cod_node_${ts}`,
    cod_paid_msg:     `cod_paid_msg_${ts}`,
    // Review
    rev_request:      `rev_request_${ts}`,
    rev_positive:     `rev_positive_${ts}`,
    rev_negative:     `rev_negative_${ts}`,
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

async function generateAIContent(ctx) {
  const { client, businessName, businessDescription, botName, tone, botLanguage, currency, products } = ctx;
  const productsSummary = products.slice(0, 8)
    .map(p => `"${p.title}" ${currency}${p.price}: ${p.features.slice(0, 80)}`).join("\n");

  const prompt = `You are a top-tier D2C growth copy chief. Create JSON marketing copy for a WhatsApp commerce bot.
Use AIDA (Attention, Interest, Desire, Action) where appropriate. For cart_recovery_1 use empathy + hook (no hard sell).
For cart_recovery_2 add authentic scarcity / velocity (selling fast, cart not held) without fake countdown timers.
For cart_recovery_3 add FOMO + clear CTA + optional incentive framing (no fabricated coupon codes unless brand-agnostic like "active offers").
For cod_nudge: contrast COD friction (slower dispatch, verification) vs prepaid benefits (priority ship, cashback using {{currency}}{{discount_amount}} placeholders).
For order_confirmed_msg: premium reassurance + anticipation of tracking.
For warranty_* strings: confident, legal-safe, enterprise tone — no guarantees beyond stated {{warranty_duration}}.
Keep placeholders EXACTLY as token names: {{first_name}},{{brand_name}},{{bot_name}},{{line_items_list}},{{cart_total}},{{checkout_url}},{{first_product_title}},{{order_number}},{{order_total}},{{payment_method}},{{shipping_address}},{{currency}},{{discount_amount}},{{payment_link}},{{warranty_duration}} — do not rename.
BRAND=${businessName}
DESCRIPTION=${businessDescription}
BOT=${botName}
TONE=${tone}
LANGUAGE=${botLanguage}
PRODUCTS:
${productsSummary}
Return only JSON with keys: welcome_a,welcome_b,product_menu_text,order_status_msg,fallback_msg,returns_policy_short,cancellation_confirm,cancellation_success,loyalty_welcome,loyalty_points_msg,referral_msg,sentiment_ask,review_positive,review_negative,cart_recovery_1,cart_recovery_2,cart_recovery_3,cod_nudge,order_confirmed_msg,agent_handoff_msg,faq_response,ad_welcome,ig_welcome,warranty_welcome,warranty_lookup_prompt,warranty_reg_success,warranty_active_msg,warranty_expired_msg,warranty_none_msg,support_hours_msg,return_photo_prompt`;

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

  // Welcome — template if available, else interactive button bubble
  const wTpl = welcomeTemplate;
  if (wTpl) {
    nodes.push({
      id: IDS.welcome, type: "template", position: flowPos(2, 5),
      data: {
        label: "Welcome Template",
        templateName: wTpl.name,
        imageUrl: client.brand?.businessLogo || client.brand?.logoUrl || client.businessLogo || "",
        variables: ["{{brand_name}}", "{{bot_name}}"],
        heatmapCount: 0
      }
    });
  } else {
    const btnShop = F.enableCatalog ? [{ id: "shop", title: "🛍️ Browse Products" }] : [];
    const btnTrack = F.enableOrderTracking ? [{ id: "track", title: "📦 Track Order" }] : [];
    const btnSupport = F.enableSupportEscalation ? [{ id: "support", title: "🎧 Get Support" }] : [];
    let buttonsList = [...btnShop, ...btnTrack, ...btnSupport];
    if (buttonsList.length === 0) {
      buttonsList = [{ id: "menu", title: "📋 Open Menu" }];
    } else if (!buttonsList.find((b) => b.id === "menu")) {
      buttonsList = [...buttonsList, { id: "menu", title: "📋 Main Menu" }];
    }
    if (buttonsList.length > 3) {
      buttonsList = buttonsList.slice(0, 3);
    }
    nodes.push({
      id: IDS.welcome, type: "interactive", position: flowPos(2, 5),
      data: {
        label: "Welcome Message", interactiveType: "button",
        imageUrl: client.brand?.businessLogo || client.brand?.logoUrl || client.businessLogo || "",
        text: content.welcome_a,
        buttonsList,
        heatmapCount: 0
      }
    });
    const tgtShop = F.enableCatalog ? IDS.cat_list : IDS.main_menu;
    const tgtTrack = F.enableOrderTracking ? IDS.ord_track : IDS.main_menu;
    const supEntry = F.enableBusinessHoursGate && !F.enable247 ? IDS.sup_sch : IDS.sup_capture;
    const tgtSupport = F.enableSupportEscalation ? supEntry : IDS.main_menu;
    buttonsList.forEach((b) => {
      let target = IDS.main_menu;
      if (b.id === "shop") target = tgtShop;
      else if (b.id === "track") target = tgtTrack;
      else if (b.id === "support") target = tgtSupport;
      else if (b.id === "menu") target = IDS.main_menu;
      edges.push({
        id: `e_${IDS.welcome}_${b.id}`,
        source: IDS.welcome,
        target,
        sourceHandle: b.id
      });
    });
  }
  edges.push({ id: `e_${IDS.trig_main}_w`, source: IDS.trig_main, target: IDS.welcome });
  if (wTpl) {
    edges.push({ id: `e_${IDS.welcome}_mm`, source: IDS.welcome, target: IDS.main_menu });
  }

  return { nodes, edges, label: "Welcome → {{brand_name}}", hasWelcomeTemplate: !!wTpl };
}

function buildMainMenu(ctx, IDS, menuRows) {
  if (!menuRows.length) return { nodes: [], edges: [] };
  const node = {
    id: IDS.main_menu, type: "interactive", position: flowPos(3, 5),
    data: {
      label: "Main Hub Menu", interactiveType: "list",
      text: "How can {{bot_name}} help you today? Tap an option below 👇",
      buttonText: "Open Menu",
      sections: [{ title: "{{brand_name}}", rows: menuRows }],
      heatmapCount: 0
    }
  };
  return { nodes: [node], edges: [] };
}

function buildCatalogBranch(ctx, IDS) {
  const { F, products, storeUrl, shopCollections = [] } = ctx;
  const nodes = [];
  const edges = [];
  const MAX_CATEGORY_ROWS = 5;
  const categoryNodeIds = [IDS.cat_cat_0, IDS.cat_cat_1, IDS.cat_cat_2, IDS.cat_cat_3, IDS.cat_cat_4];
  const useShopCols = Array.isArray(shopCollections) && shopCollections.length > 0;
  const shopCols = useShopCols ? shopCollections.slice(0, 9) : [];

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

  const listRows = [{ id: "featured", title: "Featured", description: "Bestsellers and trending picks" }];
  if (useShopCols) {
    shopCols.forEach((c) => {
      listRows.push({
        id: `collection_${c.shopifyCollectionId}`,
        title: truncate(c.whatsappMenuLabel || c.title, 24),
        description: "Browse in WhatsApp"
      });
    });
  } else if (sortedCategories.length) {
    sortedCategories.forEach(([name, items], idx) => {
      listRows.push({
        id: `cat_${idx}`,
        title: truncate(name, 24),
        description: `${items.length} item${items.length > 1 ? "s" : ""}`
      });
    });
  } else {
    listRows.push({ id: "cat_0", title: "General", description: "Core products" });
  }

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
        label: "WhatsApp Catalog",
        catalogType: "full",
        header: "{{brand_name}}",
        body: "Browse {{brand_name}} products directly in WhatsApp. Add to cart and continue when ready.",
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
          ? "Pick a collection to see products in WhatsApp (no templates per product)."
          : "Want curated products? Pick a collection:",
        buttonText: "View collections",
        populateFromShopify: useShopCols,
        sections: [{ title: "{{brand_name}} store", rows: listRows }],
        heatmapCount: 0
      }
    },
    {
      id: IDS.cat_featured,
      type: "catalog",
      position: flowPos(7, 0),
      data: {
        label: "Featured collection",
        catalogType: featuredVariantIds.length ? "multi" : "full",
        header: "Featured picks",
        body: "Checkout our best-performing products from {{brand_name}}.",
        footer: "Tap to view items",
        productIds: featuredVariantIds.join(","),
        heatmapCount: 0
      }
    },
    {
      id: IDS.cat_addr_prompt,
      type: "interactive",
      position: flowPos(6, 1),
      data: {
        label: "Catalog next actions",
        interactiveType: "button",
        text: "Opened the catalog. What should I help you with next?",
        buttonsList: [
          { id: "checkout", title: "🛒 Checkout link" },
          { id: "support", title: "🎧 Product help" },
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
        text: storeUrl
          ? `Complete checkout here: ${storeUrl}/cart`
          : "Your checkout link is ready in store settings. Meanwhile, I can help with product details or connect you to support.",
        heatmapCount: 0
      }
    }
  );
  if (useShopCols) {
    nodes.push({
      id: IDS.cat_shop_by_selection,
      type: "catalog",
      position: flowPos(7, 1),
      data: {
        label: "Collection (from menu)",
        catalogType: "collection",
        useSelectedCollection: true,
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
      nodes.push({
        id: targetNodeId,
        type: "catalog",
        position: flowPos(7, 1 + idx),
        data: {
          label: `Collection: ${truncate(name, 22)}`,
          catalogType: productIds.length ? "multi" : "full",
          header: truncate(name, 40),
          body: `Browse ${name} from {{brand_name}}.`,
          footer: "Tap to view items",
          productIds: productIds.join(","),
          heatmapCount: 0
        }
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
    { id: `e_${IDS.cat_list}_cats`, source: IDS.cat_list, target: IDS.cat_category_menu },
    { id: `e_${IDS.cat_category_menu}_featured`, source: IDS.cat_category_menu, target: IDS.cat_featured, sourceHandle: "featured" },
    { id: `e_${IDS.cat_featured}_next`, source: IDS.cat_featured, target: IDS.cat_addr_prompt },
    { id: `e_${IDS.cat_list}_cart`, source: IDS.cat_list, target: IDS.cat_cart_handler, sourceHandle: "cart" },
    { id: `e_${IDS.cat_featured}_cart`, source: IDS.cat_featured, target: IDS.cat_cart_handler, sourceHandle: "cart" },
    { id: `e_${IDS.cat_cart_handler}_next`, source: IDS.cat_cart_handler, target: IDS.cat_addr_prompt, sourceHandle: "a" },
    { id: `e_${IDS.cat_addr_prompt}_checkout`, source: IDS.cat_addr_prompt, target: IDS.cat_addr_done, sourceHandle: "checkout" },
    { id: `e_${IDS.cat_addr_prompt}_support`, source: IDS.cat_addr_prompt, target: supEntryProduct, sourceHandle: "support" },
    { id: `e_${IDS.cat_addr_prompt}_menu`, source: IDS.cat_addr_prompt, target: IDS.main_menu, sourceHandle: "menu" }
  );
  if (useShopCols) {
    shopCols.forEach((c) => {
      const hid = `collection_${c.shopifyCollectionId}`;
      edges.push({
        id: `e_${IDS.cat_category_menu}_${hid}`,
        source: IDS.cat_category_menu,
        target: IDS.cat_shop_by_selection,
        sourceHandle: hid
      });
    });
    edges.push(
      { id: `e_${IDS.cat_shop_by_selection}_next`, source: IDS.cat_shop_by_selection, target: IDS.cat_addr_prompt },
      {
        id: `e_${IDS.cat_shop_by_selection}_cart`,
        source: IDS.cat_shop_by_selection,
        target: IDS.cat_cart_handler,
        sourceHandle: "cart"
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
            text: "Need help finishing checkout?",
            buttonsList: [
              { id: "resend", title: "🔁 Resend checkout link" },
              { id: "support", title: "🎧 Talk to support" },
              { id: "done", title: "✅ Already done" }
            ],
            heatmapCount: 0
          }
        },
        {
          id: IDS.cat_ck_follow,
          type: "message",
          position: flowPos(10, 0),
          data: {
            label: "Resend checkout link",
            text: storeUrl
              ? `Here is your checkout link again: ${storeUrl}/cart`
              : "Checkout link is not configured yet. Share your issue and support will help you complete the order.",
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
    nodes, edges,
    menuRow: { id: "shop", title: "🛍️ Shop Collection" },
    entryNodeId: IDS.cat_list,
    sourceHandle: "shop"
  };
}

function buildOrderBranch(ctx, IDS, content) {
  const { F } = ctx;
  const nodes = [], edges = [];

  nodes.push(
    {
      id: IDS.ord_track,
      type: "shopify_call",
      position: flowPos(5, 4),
      data: {
        label: "Check Order Status",
        action: "CHECK_ORDER_STATUS",
        silent: true,
        heatmapCount: 0
      }
    },
    {
      id: IDS.ord_status_msg,
      type: "message",
      position: flowPos(6, 4),
      data: {
        label: "Order status (flow)",
        text: content.order_status_msg,
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
        heatmapCount: 0
      }
    }
  );
  edges.push(
    { id: `e_${IDS.ord_track}_nf`, source: IDS.ord_track, target: IDS.ord_notfound, sourceHandle: "not_found" },
    { id: `e_${IDS.ord_track}_ok`, source: IDS.ord_track, target: IDS.ord_status_msg, sourceHandle: "success" },
    // After manual order id, re-run lookup (engine merges order_id_manual into metadata).
    { id: `e_${IDS.ord_notfound}_retry`, source: IDS.ord_notfound, target: IDS.ord_track }
  );

  if (F.enableCancelOrder) {
    const hubButtons = [
      { id: "cancel", title: "❌ Cancel Order" },
      ...(F.enableReturnsRefunds ? [{ id: "returns", title: "🔄 Returns" }] : []),
      { id: "menu", title: "⬅️ Main Menu" }
    ];
    nodes.push(
      {
        id: IDS.ord_hub,
        type: "interactive",
        position: flowPos(7, 5),
        data: {
          label: "Order Management",
          interactiveType: "button",
          text: content.order_hub_prompt,
          buttonsList: hubButtons,
          heatmapCount: 0
        }
      },
      {
        id: IDS.can_confirm,
        type: "interactive",
        position: flowPos(8, 5),
        data: {
          label: "Confirm Cancellation",
          interactiveType: "button",
          text: content.cancellation_confirm,
          buttonsList: [
            { id: "yes", title: "✅ Yes, Cancel It" },
            { id: "no", title: "❌ Keep My Order" }
          ],
          heatmapCount: 0
        }
      },
      {
        id: IDS.can_logic,
        type: "logic",
        position: flowPos(9, 5),
        data: {
          label: "Shipped? (Shopify)",
          variable: "is_shipped",
          operator: "eq",
          value: "true",
          heatmapCount: 0
        }
      },
      {
        id: IDS.can_shipped,
        type: "message",
        position: flowPos(11, 6),
        data: { label: "Already Shipped Error", text: content.in_transit_error, heatmapCount: 0 }
      },
      {
        id: IDS.can_reason,
        type: "capture_input",
        position: flowPos(10, 5),
        data: {
          label: "Cancellation Reason",
          variable: "cancel_reason",
          question: content.cancel_reason_prompt,
          text: content.cancel_reason_prompt,
          heatmapCount: 0
        }
      },
      {
        id: IDS.can_action,
        type: "shopify_call",
        position: flowPos(11, 5),
        data: { label: "Process Cancellation", action: "CANCEL_ORDER", heatmapCount: 0 }
      },
      {
        id: IDS.can_succ,
        type: "message",
        position: flowPos(12, 5),
        data: { label: "Cancel Success", text: content.cancellation_success, heatmapCount: 0 }
      },
      {
        id: IDS.can_fail,
        type: "message",
        position: flowPos(12, 6),
        data: {
          label: "Cancel Failed",
          text: content.cancel_failed_user,
          heatmapCount: 0
        }
      }
    );
    edges.push(
      { id: `e_${IDS.ord_status_msg}_hub`, source: IDS.ord_status_msg, target: IDS.ord_hub },
      { id: `e_${IDS.ord_hub}_can`, source: IDS.ord_hub, target: IDS.can_confirm, sourceHandle: "cancel" },
      { id: `e_${IDS.ord_hub}_menu`, source: IDS.ord_hub, target: IDS.main_menu, sourceHandle: "menu" }
    );
    if (F.enableReturnsRefunds && hubButtons.some((b) => b.id === "returns")) {
      edges.push({
        id: `e_${IDS.ord_hub}_ret`,
        source: IDS.ord_hub,
        target: IDS.ret_hub,
        sourceHandle: "returns"
      });
    }
    edges.push(
      { id: `e_${IDS.can_confirm}_y`, source: IDS.can_confirm, target: IDS.can_logic, sourceHandle: "yes" },
      { id: `e_${IDS.can_confirm}_n`, source: IDS.can_confirm, target: IDS.main_menu, sourceHandle: "no" },
      { id: `e_${IDS.can_logic}_t`, source: IDS.can_logic, target: IDS.can_shipped, sourceHandle: "true" },
      { id: `e_${IDS.can_logic}_f`, source: IDS.can_logic, target: IDS.can_reason, sourceHandle: "false" },
      { id: `e_${IDS.can_reason}_act`, source: IDS.can_reason, target: IDS.can_action },
      { id: `e_${IDS.can_action}_s`, source: IDS.can_action, target: IDS.can_succ, sourceHandle: "success" },
      { id: `e_${IDS.can_action}_f`, source: IDS.can_action, target: IDS.can_fail, sourceHandle: "fail" },
      { id: `e_${IDS.can_shipped}_mm`, source: IDS.can_shipped, target: IDS.main_menu },
      { id: `e_${IDS.can_succ}_mm`, source: IDS.can_succ, target: IDS.main_menu },
      { id: `e_${IDS.can_fail}_mm`, source: IDS.can_fail, target: IDS.main_menu }
    );
  } else {
    edges.push({ id: `e_${IDS.ord_status_msg}_mm`, source: IDS.ord_status_msg, target: IDS.main_menu });
  }

  return {
    nodes, edges,
    menuRow: { id: "track", title: "📦 Track My Order" },
    entryNodeId: IDS.ord_track,
    sourceHandle: "track"
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
        topic: "Return request — {{brand_name}}",
        phone: adminPhone || client.adminPhone || "",
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

  return {
    nodes, edges,
    menuRow: { id: "returns", title: "🔄 Return / Cancel" },
    entryNodeId: IDS.ret_hub,
    sourceHandle: "returns"
  };
}

function buildWarrantyBranch(ctx, IDS, content) {
  const nodes = [], edges = [];
  nodes.push(
    { id: IDS.war_hub, type: "interactive", position: flowPos(5, 11),
      data: { label: "Warranty Hub", interactiveType: "button",
        text: content.warranty_welcome,
        buttonsList: [
          { id: "reg",   title: "✅ Register" },
          { id: "check", title: "🔍 Check Status" },
          { id: "menu",  title: "⬅️ Main Menu" }
        ], heatmapCount: 0 } },
    { id: IDS.war_serial,  type: "capture_input", position: flowPos(6, 10),
      data: { label: "Warranty Serial", variable: "warranty_serial",
        question: "Enter serial number or order id.", text: "Enter serial number or order id.", heatmapCount: 0 } },
    { id: IDS.war_date,    type: "capture_input", position: flowPos(7, 10),
      data: { label: "Purchase Date", variable: "purchase_date",
        question: "Enter purchase date (DD/MM/YYYY).", text: "Enter purchase date (DD/MM/YYYY).", heatmapCount: 0 } },
    { id: IDS.war_tag,     type: "tag_lead", position: flowPos(8, 10),
      data: { label: "Warranty Tag", action: "add", tag: "warranty-enrolled", heatmapCount: 0 } },
    { id: IDS.war_success, type: "message", position: flowPos(9, 10),
      data: { label: "Warranty Success", text: content.warranty_reg_success, heatmapCount: 0 } },
    { id: IDS.war_lookup,  type: "capture_input", position: flowPos(6, 12),
      data: { label: "Lookup Serial", variable: "lookup_serial",
        question: content.warranty_lookup_prompt, text: content.warranty_lookup_prompt, heatmapCount: 0 } },
    { id: IDS.war_engine,  type: "warranty_check", position: flowPos(7, 12),
      data: { label: "Warranty Check", action: "WARRANTY_CHECK", heatmapCount: 0 } },
    { id: IDS.war_active,  type: "message", position: flowPos(8, 11),
      data: { label: "Warranty Active",
        text: content.warranty_active_msg, heatmapCount: 0 } },
    { id: IDS.war_expired, type: "message", position: flowPos(8, 12),
      data: { label: "Warranty Expired",
        text: content.warranty_expired_msg, heatmapCount: 0 } },
    { id: IDS.war_none,    type: "message", position: flowPos(8, 13),
      data: { label: "No Warranty",
        text: content.warranty_none_msg, heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_${IDS.war_hub}_reg`,   source: IDS.war_hub,    target: IDS.war_serial, sourceHandle: "reg" },
    { id: `e_${IDS.war_hub}_chk`,   source: IDS.war_hub,    target: IDS.war_lookup, sourceHandle: "check" },
    { id: `e_${IDS.war_hub}_menu`,  source: IDS.war_hub,    target: IDS.main_menu,  sourceHandle: "menu" },
    { id: `e_${IDS.war_serial}_d`,  source: IDS.war_serial, target: IDS.war_date },
    { id: `e_${IDS.war_date}_t`,    source: IDS.war_date,   target: IDS.war_tag },
    { id: `e_${IDS.war_tag}_s`,     source: IDS.war_tag,    target: IDS.war_success },
    { id: `e_${IDS.war_lookup}_e`,  source: IDS.war_lookup, target: IDS.war_engine },
    { id: `e_${IDS.war_engine}_a`,  source: IDS.war_engine, target: IDS.war_active,  sourceHandle: "active" },
    { id: `e_${IDS.war_engine}_x`,  source: IDS.war_engine, target: IDS.war_expired, sourceHandle: "expired" },
    { id: `e_${IDS.war_engine}_n`,  source: IDS.war_engine, target: IDS.war_none,    sourceHandle: "none" },
    { id: `e_${IDS.war_success}_mm`, source: IDS.war_success, target: IDS.main_menu },
    { id: `e_${IDS.war_active}_mm`, source: IDS.war_active, target: IDS.main_menu },
    { id: `e_${IDS.war_expired}_mm`, source: IDS.war_expired, target: IDS.main_menu },
    { id: `e_${IDS.war_none}_mm`, source: IDS.war_none, target: IDS.main_menu }
  );

  return {
    nodes, edges,
    menuRow: { id: "warranty", title: "🛡️ Warranty" },
    entryNodeId: IDS.war_hub,
    sourceHandle: "warranty"
  };
}

function buildLoyaltyBranch(ctx, IDS, content) {
  const { F } = ctx;
  const nodes = [], edges = [];

  // Build menu rows dynamically: referral row appears only if enabled.
  const loyRows = [
    { id: "pts", title: "💎 My Points" },
    { id: "red", title: "🎁 Redeem" }
  ];
  if (F.enableReferral) loyRows.push({ id: "ref", title: "📢 Refer & Earn" });
  loyRows.push({ id: "menu", title: "⬅️ Main Menu" });

  nodes.push(
    { id: IDS.loy_menu, type: "interactive", position: flowPos(5, 14),
      data: { label: "Rewards Hub", interactiveType: "list",
        text: content.loyalty_welcome, buttonText: "My Rewards",
        sections: [{ title: "{{brand_name}} — Rewards", rows: loyRows }], heatmapCount: 0 } },
    { id: IDS.loy_balance, type: "message", position: flowPos(6, 13),
      data: { label: "Points Balance", text: content.loyalty_points_msg, heatmapCount: 0 } },
    { id: IDS.loy_redeem, type: "loyalty_action", position: flowPos(6, 14),
      data: { label: "Redeem Loyalty", actionType: "REDEEM_POINTS", pointsRequired: 100, heatmapCount: 0 } },
    { id: IDS.loy_redeem_ok, type: "message", position: flowPos(7, 13),
      data: { label: "Redeem Success", text: "🎁 *{{brand_name}}* — redemption locked in. Your checkout discount is live on the next cart we see from this number.", heatmapCount: 0 } },
    { id: IDS.loy_redeem_fail, type: "message", position: flowPos(7, 15),
      data: { label: "Insufficient Points", text: "You’re close 💎 You have *{{loyalty_points}} pts* — keep shopping *{{brand_name}}* and this reward unlocks automatically.", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_${IDS.loy_menu}_pts`, source: IDS.loy_menu, target: IDS.loy_balance, sourceHandle: "pts" },
    { id: `e_${IDS.loy_menu}_red`, source: IDS.loy_menu, target: IDS.loy_redeem,  sourceHandle: "red" },
    { id: `e_${IDS.loy_menu}_mn`,  source: IDS.loy_menu, target: IDS.main_menu,   sourceHandle: "menu" },
    { id: `e_${IDS.loy_redeem}_s`, source: IDS.loy_redeem, target: IDS.loy_redeem_ok,   sourceHandle: "success" },
    { id: `e_${IDS.loy_redeem}_f`, source: IDS.loy_redeem, target: IDS.loy_redeem_fail, sourceHandle: "fail" },
    { id: `e_${IDS.loy_balance}_mm`, source: IDS.loy_balance, target: IDS.main_menu },
    { id: `e_${IDS.loy_redeem_ok}_mm`, source: IDS.loy_redeem_ok, target: IDS.main_menu },
    { id: `e_${IDS.loy_redeem_fail}_mm`, source: IDS.loy_redeem_fail, target: IDS.main_menu }
  );

  if (F.enableReferral) {
    nodes.push({
      id: IDS.loy_refer, type: "message", position: flowPos(6, 16),
      data: { label: "Refer", text: content.referral_msg, heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.loy_menu}_ref`, source: IDS.loy_menu, target: IDS.loy_refer, sourceHandle: "ref" },
      { id: `e_${IDS.loy_refer}_mm`, source: IDS.loy_refer, target: IDS.main_menu }
    );
  }

  return {
    nodes, edges,
    menuRow: { id: "loyalty", title: "💎 My Rewards" },
    entryNodeId: IDS.loy_menu,
    sourceHandle: "loyalty"
  };
}

function buildInstallSupportBranch(ctx, IDS) {
  const { F } = ctx;
  const nodes = [], edges = [];
  const supportPrompt =
    String(F.installSupportPrompt || "").trim() ||
    "Need install help? Share your exact product name and I will guide you.";

  nodes.push(
    {
      id: IDS.ins_hub,
      type: "interactive",
      position: flowPos(5, 16),
      data: {
        label: "Install Support Hub",
        interactiveType: "button",
        text: supportPrompt,
        buttonsList: [
          { id: "last_order", title: "🧾 Use my latest order" },
          { id: "type_name", title: "⌨️ Type product name" },
          { id: "menu", title: "⬅️ Main Menu" }
        ],
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_lookup,
      type: "shopify_call",
      position: flowPos(6, 15),
      data: {
        label: "Latest purchase lookup",
        action: "CHECK_ORDER_STATUS",
        silent: true,
        variable: "latest_order_ctx",
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_confirm,
      type: "interactive",
      position: flowPos(7, 15),
      data: {
        label: "Install product confirm",
        interactiveType: "button",
        text: "We found your recent product: {{first_product_title|latest purchased product}}. Need setup help for this item?",
        buttonsList: [
          { id: "yes", title: "✅ Yes, this product" },
          { id: "no", title: "❌ Different product" },
          { id: "menu", title: "⬅️ Main Menu" }
        ],
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_capture,
      type: "capture_input",
      position: flowPos(8, 16),
      data: {
        label: "Capture product for install",
        variable: "install_product_query",
        question: "Type the full product name exactly as shown on your order.",
        text: "Type the full product name exactly as shown on your order.",
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_search,
      type: "shopify_call",
      position: flowPos(9, 16),
      data: {
        label: "Search product support context",
        action: "search_products",
        query: "{{install_product_query}}",
        variable: "install_product_result",
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_search_latest,
      type: "shopify_call",
      position: flowPos(9, 15),
      data: {
        label: "Search latest ordered product support context",
        action: "search_products",
        query: "{{first_product_title}}",
        variable: "install_product_result",
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_result,
      type: "message",
      position: flowPos(10, 15),
      data: {
        label: "Install support response",
        text: "Got it. For *{{install_product_query|this product}}*, follow your package QR/video guide first, then app pairing (2.4GHz Wi-Fi if required), and power-cycle once before retry. If you share a short issue video, we can resolve it faster.",
        heatmapCount: 0
      }
    },
    {
      id: IDS.ins_no_match,
      type: "message",
      position: flowPos(10, 17),
      data: {
        label: "Install no match",
        text: "I could not auto-match that product yet. I am routing this to support for a precise installation walkthrough.",
        action: "ESCALATE_HUMAN",
        heatmapCount: 0
      }
    }
  );

  edges.push(
    { id: `e_${IDS.ins_hub}_lo`, source: IDS.ins_hub, target: IDS.ins_lookup, sourceHandle: "last_order" },
    { id: `e_${IDS.ins_hub}_tn`, source: IDS.ins_hub, target: IDS.ins_capture, sourceHandle: "type_name" },
    { id: `e_${IDS.ins_hub}_mm`, source: IDS.ins_hub, target: IDS.main_menu, sourceHandle: "menu" },
    { id: `e_${IDS.ins_lookup}_ok`, source: IDS.ins_lookup, target: IDS.ins_confirm },
    { id: `e_${IDS.ins_lookup}_nf`, source: IDS.ins_lookup, target: IDS.ins_capture, sourceHandle: "no_order" },
    { id: `e_${IDS.ins_confirm}_y`, source: IDS.ins_confirm, target: IDS.ins_search_latest, sourceHandle: "yes" },
    { id: `e_${IDS.ins_confirm}_n`, source: IDS.ins_confirm, target: IDS.ins_capture, sourceHandle: "no" },
    { id: `e_${IDS.ins_confirm}_mm`, source: IDS.ins_confirm, target: IDS.main_menu, sourceHandle: "menu" },
    { id: `e_${IDS.ins_capture}_sr`, source: IDS.ins_capture, target: IDS.ins_search },
    { id: `e_${IDS.ins_search_latest}_ok`, source: IDS.ins_search_latest, target: IDS.ins_result, sourceHandle: "success" },
    { id: `e_${IDS.ins_search_latest}_fail`, source: IDS.ins_search_latest, target: IDS.ins_no_match, sourceHandle: "not_found" },
    { id: `e_${IDS.ins_search}_ok`, source: IDS.ins_search, target: IDS.ins_result, sourceHandle: "success" },
    { id: `e_${IDS.ins_search}_fail`, source: IDS.ins_search, target: IDS.ins_no_match, sourceHandle: "not_found" },
    { id: `e_${IDS.ins_result}_mm`, source: IDS.ins_result, target: IDS.main_menu },
    { id: `e_${IDS.ins_no_match}_mm`, source: IDS.ins_no_match, target: IDS.main_menu }
  );

  return {
    nodes, edges,
    menuRow: { id: "install_help", title: "🛠️ Install Help" },
    entryNodeId: IDS.ins_hub,
    sourceHandle: "install_help"
  };
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
      data: { label: "Support Query", variable: "support_query",
        question: content.support_capture_prompt,
        text: content.support_capture_prompt, heatmapCount: 0 } },
    { id: IDS.sup_tag, type: "tag_lead", position: flowPos(7, 17),
      data: { label: "Tag Pending Human", action: "add", tag: "pending-human", heatmapCount: 0 } },
    { id: IDS.sup_confirm, type: "message", position: flowPos(9, 17),
      data: { label: "Handoff Confirmed", text: content.agent_handoff_msg,
        humanEscalationTimeoutMin: F.humanEscalationTimeoutMin, heatmapCount: 0 } },
    { id: IDS.sup_livechat, type: "livechat", position: flowPos(10, 17),
      data: {
        label: "Live chat handoff",
        topic: "Customer requested human support — {{brand_name}}",
        text: content.livechat_queue_body,
        heatmapCount: 0,
      } }
  );
  edges.push({ id: `e_${IDS.sup_capture}_tag`, source: IDS.sup_capture, target: IDS.sup_tag });

  if (F.enableAdminAlerts) {
    nodes.push({
      id: IDS.sup_alert, type: "admin_alert", position: flowPos(8, 17),
      data: { label: "Admin Alert", priority: "high",
        topic: "Human request — {{brand_name}}",
        phone: adminPhone || client.adminPhone || "", heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.sup_tag}_al`, source: IDS.sup_tag, target: IDS.sup_alert },
      { id: `e_${IDS.sup_alert}_cf`, source: IDS.sup_alert, target: IDS.sup_confirm },
      { id: `e_${IDS.sup_confirm}_lc`, source: IDS.sup_confirm, target: IDS.sup_livechat },
      { id: `e_${IDS.sup_livechat}_mm`, source: IDS.sup_livechat, target: IDS.main_menu }
    );
  } else {
    edges.push(
      { id: `e_${IDS.sup_tag}_cf`, source: IDS.sup_tag, target: IDS.sup_confirm },
      { id: `e_${IDS.sup_confirm}_lc`, source: IDS.sup_confirm, target: IDS.sup_livechat },
      { id: `e_${IDS.sup_livechat}_mm`, source: IDS.sup_livechat, target: IDS.main_menu }
    );
  }

  if (F.enableBusinessHoursGate && !F.enable247) {
    edges.push({ id: `e_${IDS.sup_closed}_mm`, source: IDS.sup_closed, target: IDS.main_menu });
  }

  return {
    nodes, edges,
    menuRow: { id: "support", title: "🎧 Talk to Human" },
    entryNodeId: F.enableBusinessHoursGate && !F.enable247 ? IDS.sup_sch : IDS.sup_capture,
    sourceHandle: "support"
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

function buildAbandonedCart(ctx, IDS, content) {
  const { cartTiming } = ctx;
  const nodes = [{
    id: IDS.trig_cart, type: "trigger", position: autoPos(0, 2),
    data: { label: "Abandoned Cart Trigger", triggerType: "abandoned_cart", heatmapCount: 0 }
  }];
  const edges = [];
  const steps = [
    { delay: cartTiming.msg1, unit: "minutes", text: content.cart_recovery_1 },
    { delay: cartTiming.msg2, unit: "hours",   text: content.cart_recovery_2 },
    { delay: cartTiming.msg3, unit: "hours",   text: content.cart_recovery_3 }
  ];
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
  edges.push({ id: `e_${lastMsgId}_mm`, source: lastMsgId, target: IDS.main_menu });
  return { nodes, edges };
}

function buildOrderConfirmAndCod(ctx, IDS, content) {
  const { F } = ctx;
  const nodes = [
    { id: IDS.trig_order, type: "trigger", position: autoPos(0, 0),
      data: { label: "Order Placed Trigger", triggerType: "order_placed", heatmapCount: 0 } },
    { id: IDS.conf_msg, type: "message", position: autoPos(1, 0),
      data: {
        label: "Order Confirmed",
        text: content.order_confirmed_msg,
        heatmapCount: 0,
        suppressAIFallbackLink: true,
        imageUrl: '{{first_product_image}}',
      } }
  ];
  let edges = [
    { id: `e_${IDS.trig_order}_cm`, source: IDS.trig_order, target: IDS.conf_msg },
    { id: `e_${IDS.conf_msg}_mm`, source: IDS.conf_msg, target: IDS.main_menu }
  ];

  if (F.enableCodToPrepaid) {
    nodes.push(
      { id: IDS.cod_check, type: "logic", position: autoPos(2, 0),
        data: { label: "Is COD?", variable: "payment_method", operator: "contains", value: "cod", heatmapCount: 0 } },
      { id: IDS.cod_node, type: "cod_prepaid", position: autoPos(3, 0),
        data: { label: "COD Nudge", action: "CONVERT_COD_TO_PREPAID",
          discountAmount: F.codDiscountAmount, text: content.cod_nudge, heatmapCount: 0 } },
      { id: IDS.cod_paid_msg, type: "message", position: autoPos(4, 0),
        data: {
          label: "Paid Online Confirmed",
          text: "🎉 Amazing! Payment confirmed for {{order_number}}! Your order gets priority shipping. Thank you!",
          heatmapCount: 0,
          suppressAIFallbackLink: true,
        } }
    );
    edges.push(
      { id: `e_${IDS.conf_msg}_cod`, source: IDS.conf_msg, target: IDS.cod_check },
      { id: `e_${IDS.cod_check}_t`,  source: IDS.cod_check, target: IDS.cod_node, sourceHandle: "true" },
      { id: `e_${IDS.cod_node}_pd`,  source: IDS.cod_node, target: IDS.cod_paid_msg, sourceHandle: "paid" },
      { id: `e_${IDS.cod_node}_cd`,  source: IDS.cod_node, target: IDS.main_menu, sourceHandle: "cod" }
    );
    // Remove straight conf→menu when COD branch takes over (first edge wins in engine — keep menu after paid path)
    edges = edges.filter((e) => e.id !== `e_${IDS.conf_msg}_mm`);
    edges.push(
      { id: `e_${IDS.cod_check}_f`, source: IDS.cod_check, target: IDS.main_menu, sourceHandle: "false" },
      { id: `e_${IDS.cod_paid_msg}_mm`, source: IDS.cod_paid_msg, target: IDS.main_menu }
    );
  }

  return { nodes, edges };
}

function buildReviewAutomation(ctx, IDS, content) {
  const { googleReviewUrl } = ctx;
  const nodes = [
    { id: IDS.trig_fulfill, type: "trigger", position: autoPos(0, 6),
      data: { label: "Order Fulfilled Trigger", triggerType: "order_fulfilled", heatmapCount: 0 } },
    { id: IDS.rev_request, type: "review", position: autoPos(1, 6),
      data: { label: "Review Request", action: "SEND_REVIEW_REQUEST",
        text: content.sentiment_ask, googleReviewUrl, heatmapCount: 0 } },
    { id: IDS.rev_positive, type: "message", position: autoPos(2, 5),
      data: {
        label: "Positive",
        text: content.review_positive + (googleReviewUrl ? `\n${googleReviewUrl}` : ""),
        action: "LOG_REVIEW_POSITIVE",
        heatmapCount: 0,
        suppressAIFallbackLink: true,
      } },
    { id: IDS.rev_negative, type: "message", position: autoPos(2, 7),
      data: {
        label: "Negative",
        text: content.review_negative,
        action: "LOG_REVIEW_NEGATIVE",
        heatmapCount: 0,
        suppressAIFallbackLink: true,
      } }
  ];
  const edges = [
    { id: `e_${IDS.trig_fulfill}_rv`, source: IDS.trig_fulfill, target: IDS.rev_request },
    { id: `e_${IDS.rev_request}_p`,   source: IDS.rev_request,  target: IDS.rev_positive, sourceHandle: "positive" },
    { id: `e_${IDS.rev_request}_n`,   source: IDS.rev_request,  target: IDS.rev_negative, sourceHandle: "negative" },
    { id: `e_${IDS.rev_positive}_mm`, source: IDS.rev_positive, target: IDS.main_menu },
    { id: `e_${IDS.rev_negative}_mm`, source: IDS.rev_negative, target: IDS.main_menu }
  ];
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
        topic: "B2B Lead — {{brand_name}}",
        phone: adminPhone || client.adminPhone || "", heatmapCount: 0 } },
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
        const ShopifyProduct = require("../models/ShopifyProduct");
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
        const ShopifyCollection = require("../models/ShopifyCollection");
        const docs = await ShopifyCollection.find({ clientId: clientIdStr })
          .sort({ sortOrder: 1, title: 1 })
          .limit(12)
          .lean();
        const picked = docs
          .filter((d) => d && d.shopifyCollectionId && d.whatsappEnabled !== false)
          .slice(0, 10)
          .map((d) => ({
            shopifyCollectionId: String(d.shopifyCollectionId || "").trim(),
            title: String(d.title || "").trim(),
            whatsappMenuLabel: String(d.whatsappMenuLabel || d.title || "").trim()
          }))
          .filter((c) => c.shopifyCollectionId);
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

  // Welcome template lookup
  const syncTpl = (client.syncedMetaTemplates || []).map((t) => ({
    ...t,
    _st: String(t.status || "").toUpperCase()
  }));
  const welcomeTemplate =
    syncTpl.find((t) => t.name === "welcome_with_logo" && t._st === "APPROVED")
    || syncTpl.find((t) => String(t.name || "").toLowerCase().includes("welcome") && t._st === "APPROVED")
    || null;

  const entryOut   = buildEntry(ctx, IDS, content, welcomeTemplate);

  // Branch builders — call only the enabled ones
  const branches = [];
  if (F.enableCatalog)           branches.push(buildCatalogBranch(ctx, IDS));
  if (F.enableOrderTracking)     branches.push(buildOrderBranch(ctx, IDS, content));
  if (F.enableReturnsRefunds)    branches.push(buildReturnsBranch(ctx, IDS, content));
  if (F.enableWarranty)          branches.push(buildWarrantyBranch(ctx, IDS, content));
  if (F.enableInstallSupport)    branches.push(buildInstallSupportBranch(ctx, IDS));
  if (F.enableLoyalty)           branches.push(buildLoyaltyBranch(ctx, IDS, content));
  if (F.enableSupportEscalation) branches.push(buildSupportBranch(ctx, IDS, content));
  if (F.enableFAQ)               branches.push(buildFAQBranch(ctx, IDS, content));

  // Build the menu using only enabled branches' rows.
  const menuRows = branches.filter(b => b.menuRow).map(b => b.menuRow);
  const menuOut  = buildMainMenu(ctx, IDS, menuRows);

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
  if (F.enableAbandonedCart) commerceSlices.push(buildAbandonedCart(ctx, IDS, content));
  if (F.enableOrderConfirmTpl) commerceSlices.push(buildOrderConfirmAndCod(ctx, IDS, content));
  if (F.enableReviewCollection) commerceSlices.push(buildReviewAutomation(ctx, IDS, content));

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
    const deadEndTypes = ["message", "shopify_call", "loyalty_action", "tag_lead", "review", "warranty_check", "cod_prepaid", "admin_alert", "livechat"];
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

  return {
    nodes: cleanNodeText(cleanNodes),
    edges: cleanEdges,
    automationFlows: [],
  };
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
Persona: ${persona.role || "customer support specialist"} | Formality: ${persona.formality || "semi-formal"}
Language: ${ctx.botLanguage}
Business Hours: ${ctx.openTime}–${ctx.closeTime}
Currency: ${ctx.currency}
Return Policy: ${policies.returnPolicy || ctx.returnsInfo || "Standard 7-day return"}
Shipping Policy: ${policies.shippingPolicy || wizardData.shippingTime || "Standard 3-5 day shipping"}
Warranty: ${ctx.warrantyDuration}
Warranty Support Phone: ${ctx.F.warrantySupportPhone || ctx.adminPhone || "Not provided"}
Warranty Support Email: ${ctx.F.warrantySupportEmail || ctx.client?.platformVars?.supportEmail || "Not provided"}
Warranty Claim URL: ${ctx.F.warrantyClaimUrl || ctx.client?.brand?.warrantyClaimUrl || "Not provided"}
Loyalty: ${ctx.F.enableLoyalty ? `Enabled | ${ctx.F.loyaltyPointsPerUnit} pts per unit | signup ${ctx.F.loyaltySignupBonus} | tiers ${ctx.F.loyaltySilverThreshold}/${ctx.F.loyaltyGoldThreshold}` : "Disabled"}
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
// 7. PRE-BUILT META TEMPLATES (unchanged from v5 — Meta-compliant payloads)
// ═════════════════════════════════════════════════════════════════════════
function getPrebuiltTemplates(wizardData = {}) {
  const {
    businessName    = "Our Brand",
    googleReviewUrl = "",
    checkoutUrl     = "",
    shopDomain      = "",
    businessLogo    = "",
    products        = [],
    currency        = "₹",
  } = wizardData;

  const brandSafe = businessName || "Our Brand";
  const storeBase = shopDomain
    ? `https://${shopDomain.replace(/^https?:\/\//, "")}`
    : (checkoutUrl || "");

  const allProducts = products.map((p, i) => buildProductContext(p, i));
  const legacyProductTemplateMode = wizardData.productMode === "template_legacy";
  const copy = getCopyPack({
    F: wizardData.features || {},
    tone: wizardData.tone || "friendly",
    riskPosture: wizardData.riskPosture || "balanced",
    flowType: wizardData.flowType || "ecommerce",
  });

  const productTemplates = allProducts.map((p) => {
    const safeName = `prod_${p.handle.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`.substring(0, 50);
    const buyUrl   = storeBase ? `${storeBase}/products/${p.handle}` : "";
    const featureLine = (p.features || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    const bodyText = `✨ *${p.title}*\n\n` +
      `Price: *${currency}${p.price}*\n\n` +
      `${featureLine || "Built for everyday reliability, comfort, and performance."}\n\n` +
      `Want this in your cart? Tap below to view full details and checkout in one step.`;
    return {
      id: safeName, name: safeName, category: "MARKETING", language: "en",
      status: "not_submitted", required: true,
      description: `Rich product card for "${p.title}" — IMAGE header + buy button.`,
      components: [
        { type: "HEADER", format: "IMAGE", _imageUrl: p.imageUrl || "" },
        { type: "BODY",   text: bodyText },
        { type: "FOOTER", text: brandSafe },
        { type: "BUTTONS", buttons: [
          ...(buyUrl
            ? [{ type: "URL", text: "🛒 Buy Now", url: buyUrl }]
            : [{ type: "QUICK_REPLY", text: "🛒 Buy Now" }]),
          { type: "QUICK_REPLY", text: "⬅️ Main Menu" }
        ]}
      ],
      body: bodyText,
      variables: []
    };
  });

  return [
    {
      id: "welcome_with_logo", name: "welcome_with_logo",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "Branded welcome — IMAGE header (your logo) + quick-reply main menu.",
      components: [
        { type: "HEADER", format: "IMAGE", _imageUrl: businessLogo || "" },
        { type: "BODY",   text: copy.template_welcome_with_logo_body },
        { type: "BUTTONS", buttons: [
          { type: "QUICK_REPLY", text: "Browse products" },
          { type: "QUICK_REPLY", text: "Track my order" },
          { type: "QUICK_REPLY", text: "Talk to support" }
        ]}
      ],
      body: copy.template_welcome_with_logo_body,
      variables: ["business_name"]
    },
    ...(legacyProductTemplateMode ? productTemplates : []),
    {
      id: "order_confirmed", name: "order_confirmed",
      category: "UTILITY", language: "en", status: "not_submitted", required: true,
      description: "Sent immediately after order is placed.",
      components: [{
        type: "BODY",
        text: `🎉 *Order confirmed* — #{{1}}\n\nHi from ${brandSafe}. Thank you for trusting us with your purchase.\n\n📦 *Items*\n{{2}}\n\n💰 *Total*  ${currency}{{3}}\n\nWe're preparing everything carefully and will message you as soon as your order moves. Questions? Just reply here.`
      }],
      body: `🎉 *Order confirmed* — #{{1}}\n\nHi from ${brandSafe}. Thank you for trusting us with your purchase.\n\n📦 *Items*\n{{2}}\n\n💰 *Total*  ${currency}{{3}}\n\nWe're preparing everything carefully and will message you as soon as your order moves. Questions? Just reply here.`,
      variables: ["order_id", "cart_items", "order_total"]
    },
    {
      id: "cart_recovery_1", name: "cart_recovery_1",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "Sent if checkout is started but not completed.",
      components: [
        { type: "BODY", text: copy.template_cart_recovery_1_body.replace(/{{brand_name}}/g, brandSafe) },
        ...(storeBase ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Complete Purchase", url: `${storeBase}/cart` }] }] : [])
      ],
      body: copy.template_cart_recovery_1_body.replace(/{{brand_name}}/g, brandSafe),
      variables: []
    },
    {
      id: "cart_recovery_2", name: "cart_recovery_2",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "Follow-up reminder with urgency for cart recovery.",
      components: [
        { type: "BODY", text: copy.template_cart_recovery_2_body.replace(/{{brand_name}}/g, brandSafe) },
        ...(storeBase ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Complete Purchase", url: `${storeBase}/cart` }] }] : [])
      ],
      body: copy.template_cart_recovery_2_body.replace(/{{brand_name}}/g, brandSafe),
      variables: []
    },
    {
      id: "admin_handoff", name: "admin_human_alert",
      category: "UTILITY", language: "en", status: "not_submitted", required: true,
      description: "🚨 CRITICAL — sent to admin when customer requests human help.",
      components: [{
        type: "BODY",
        text: `🚨 *Human Agent Requested!*\n\nCustomer: {{1}}\nPhone: {{2}}\nContext: {{3}}\n\nPlease reply in the dashboard immediately.`
      }],
      body: `🚨 *Human Agent Requested!*\n\nCustomer: {{1}}\nPhone: {{2}}\nContext: {{3}}\n\nPlease reply in the dashboard immediately.`,
      variables: ["customer_name", "customer_phone", "last_message"]
    },
    {
      id: "cod_to_prepaid", name: "cod_to_prepaid",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "COD → prepaid: incentive stack, urgency, two-tap choice (enterprise / Delitech-style).",
      components: [
        {
          type: "HEADER",
          format: "IMAGE",
          _imageUrl: businessLogo || "",
        },
        {
          type: "BODY",
          text: `💳 *Save on your order!*

Hi {{1}} 👋

Your order *#{{2}}* for *{{3}}* ({{4}}) is confirmed as COD.

🎁 *Pay via UPI right now and get:*
✅ {{5}}
✅ {{6}}

⏰ *Offer expires in {{7}}!*

${brandSafe} prioritises prepaid orders for dispatch — choose below when you are ready.`,
        },
        {
          type: "FOOTER",
          text: "Secured checkout · Reply STOP to opt out of promos",
        },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "💳 Pay via UPI Now" },
            { type: "QUICK_REPLY", text: "Keep COD" },
          ],
        },
      ],
      body: `💳 *Save on your order!*\n\nHi {{1}} 👋\n\nYour order *#{{2}}* for *{{3}}* ({{4}}) is confirmed as COD.\n\n🎁 *Pay via UPI right now and get:*\n✅ {{5}}\n✅ {{6}}\n\n⏰ *Offer expires in {{7}}!*`,
      variables: [
        "customer_first_name",
        "order_id",
        "product_line",
        "order_total_formatted",
        "incentive_cashback",
        "incentive_shipping",
        "urgency_window",
      ],
    },
    ...(googleReviewUrl ? [{
      id: "review_request", name: "review_request",
      category: "MARKETING", language: "en", status: "not_submitted", required: false,
      description: "Sent 3-4 days after delivery fulfilled.",
      components: [
        { type: "BODY", text: `Hi {{1}}! How was your experience with ${brandSafe}? 😊\n\nLeave us a quick review — it means a lot!` },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Leave a Review", url: googleReviewUrl }] }
      ],
      body: `Hi {{1}}! How was your experience with ${brandSafe}? 😊\n\nLeave us a quick review — it means a lot!`,
      variables: ["customer_name"]
    }] : [])
  ];
}

// ═════════════════════════════════════════════════════════════════════════
module.exports = {
  generateEcommerceFlow,
  generateSystemPrompt,
  getPrebuiltTemplates,
  verifyFlowIntegrity,
  buildProductContext,
  stripPlaceholders
};
