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

// ═════════════════════════════════════════════════════════════════════════
// 0. UTILITIES (kept stable from v5 — referenced elsewhere via require)
// ═════════════════════════════════════════════════════════════════════════

function buildProductContext(product, index) {
  const images   = Array.isArray(product.images) ? product.images : [];
  const altTexts = images.map(img => img?.alt).filter(Boolean).join(" ");
  const features = (altTexts || product.description || product.descriptionHtml || "").slice(0, 300);
  const rawName  = product.name || product.title || `Product ${index + 1}`;
  const handle   = product.handle
    || rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id:       product.shopifyId || product.id || `prod_${index}`,
    title:    rawName,
    price:    product.price || "0",
    imageUrl: product.imageUrl || (images[0]?.src || ""),
    handle,
    features,
    category: product.category || "General",
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

/**
 * Central tone blocks for default flows — merged into `buildDefaultContent`.
 * Tune brand voice here; builders should prefer `content.*` over inline strings.
 */
const TONE_COPY = {
  order_not_found_prompt:
    "We couldn't match an order to this number yet. Send your *order number* (for example #1042) and we'll look it up.",
  order_hub_prompt: "What would you like to do next for *{{order_number}}*?",
  cancel_reason_prompt: "In one short line, why are you cancelling? It helps us improve.",
  cancel_failed_user:
    "We couldn't complete the cancellation — it may already be packed or on the way. Type *menu* to reach the team.",
  support_capture_prompt:
    "Describe what you need — include your *order number* if you have one. A teammate will pick this up shortly.",
  support_schedule_closed_nudge:
    "Live agents are offline right now. Hours: *{{open_hours}}*. Leave your message here and we'll follow up; meanwhile {{bot_name}} can help with FAQs.",
  livechat_queue_body:
    "You're in the queue for a live agent. When you're done, send *menu* or *hi* and {{bot_name}} will take over again.",
};

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
    cat_addr_prompt:  `cat_addr_prompt_${ts}`,
    cat_addr_cap:     `cat_addr_cap_${ts}`,
    cat_addr_done:    `cat_addr_done_${ts}`,
    cat_addr_alert:   `cat_addr_alert_${ts}`,
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
  const { F } = ctx;
  return {
    ...TONE_COPY,
    welcome_a:            `👋 Welcome to *{{brand_name}}*! I'm {{bot_name}}, your assistant. Let's get started.`,
    welcome_b:            `🛍️ Hey there! Explore our products and services at *{{brand_name}}*!`,
    product_menu_text:    `Welcome to the *{{brand_name}}* Hub! How can we help you today?`,
    order_status_msg:
      `📦 *{{order_number}}*\n\nStatus: *{{order_status}}*\n\n{{line_items_list}}\n\n🔗 Track: {{tracking_url}}\n\nTap a button below for the next step.`,
    fallback_msg:         `I'm still learning! 😊 Connecting you with a human expert who can help.`,
    returns_policy_short: `Easy 7-day returns on all unused items. Just share a photo to start! 🔄`,
    cancellation_confirm: `Are you sure you want to cancel? This cannot be undone.`,
    cancellation_success: `Cancellation processed successfully. We hope to serve you again! 💙`,
    loyalty_welcome:      `🎉 Welcome to *{{brand_name}}* Rewards! You've earned *${F.loyaltySignupBonus} points*!`,
    loyalty_points_msg:   `💎 You have points available! Redeem them for instant discounts.`,
    referral_msg:         `Refer a friend and earn *{{referral_points}} bonus points*! 🎁`,
    sentiment_ask:        `How was your experience today? We value your feedback! 😊`,
    review_positive:      `That's great! 🌟 Please consider sharing your review on Google.`,
    review_negative:      `We're sorry! 😔 An agent will be with you shortly to make it right.`,
    cart_recovery_1:
      `🛒 Hi {{first_name}} — you left something beautiful in your *{{brand_name}}* cart:\n\n{{line_items_list}}\n\n💰 *Total:* {{cart_total}}\n🔗 *Checkout:* {{checkout_url}}\n\nTap the link to complete your order securely.`,
    cart_recovery_2:
      `⏰ Still thinking? Your items are reserved — {{first_product_title}} and the rest are waiting.\n\n💰 {{cart_total}}\n🔗 {{checkout_url}}`,
    cart_recovery_3:
      `🔥 Last nudge: finish checkout now and use any active store offer. Cart total {{cart_total}}.\n🔗 {{checkout_url}}`,
    cod_nudge:            `💳 Save {{currency}}{{discount_amount}} and get faster delivery with online payment!`,
    order_confirmed_msg:
      `🎉 *Order confirmed, {{first_name}}!*\n\n📦 *Order:* {{order_number}}\n💰 *Total:* {{order_total}}\n💳 *Payment:* {{payment_method}}\n\n📍 *Ship to:*\n{{shipping_address}}\n\n🧾 *Items:*\n{{line_items_list}}\n\nWe'll notify you when it ships.`,
    agent_handoff_msg:    `Thanks — I've notified the team. Someone will join you shortly. 🎧`,
    faq_response:         `Here are some helpful answers. Type *menu* to return.`,
    ad_welcome:           `Thanks for clicking! 👋 How can I help you explore *{{brand_name}}*?`,
    ig_welcome:           `Hey from IG! 📸 Let's find what you're looking for.`,
    warranty_welcome:     `🛡️ Register your *{{warranty_duration}}* warranty for priority support.`,
    warranty_lookup_prompt: `Enter your Order ID to check your warranty status.`,
    warranty_reg_success: `✅ Warranty registered for *{{warranty_duration}}*!`,
    support_hours_msg:    `Agents are active *{{open_hours}}*. I'm here 24/7! 📞`,
    return_photo_prompt:  `Please upload a clear photo of the item. 📸`,
    in_transit_error:     `Already shipped! 🚚 Contact returns once it arrives.`
  };
}

async function generateAIContent(ctx) {
  const { client, businessName, businessDescription, botName, tone, botLanguage, currency, products } = ctx;
  const productsSummary = products.slice(0, 8)
    .map(p => `"${p.title}" ${currency}${p.price}: ${p.features.slice(0, 80)}`).join("\n");

  const prompt = `Create JSON marketing copy for WhatsApp commerce bot.
BRAND=${businessName}
DESCRIPTION=${businessDescription}
BOT=${botName}
TONE=${tone}
LANGUAGE=${botLanguage}
PRODUCTS:
${productsSummary}
Return only JSON with keys: welcome_a,welcome_b,product_menu_text,order_status_msg,fallback_msg,returns_policy_short,cancellation_confirm,cancellation_success,loyalty_welcome,loyalty_points_msg,referral_msg,sentiment_ask,review_positive,review_negative,cart_recovery_1,cart_recovery_2,cart_recovery_3,cod_nudge,order_confirmed_msg,agent_handoff_msg,faq_response,ad_welcome,ig_welcome,warranty_welcome,warranty_lookup_prompt,support_hours_msg,return_photo_prompt,warranty_reg_success`;

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
    id: IDS.trig_main, type: "trigger", position: { x: 0, y: 0 },
    data: { label: "Main Entry Trigger", triggerType: "keyword", matchMode: "contains",
      keywords: ["hi","hello","hey","start","menu","help","bot","hola","namaste","kem cho","shu che","buy","price","order","shop","offer","catalog"], heatmapCount: 0 }
  });

  if (F.enableMetaAdsTrigger) {
    nodes.push({
      id: IDS.trig_ad, type: "trigger", position: { x: 400, y: 0 },
      data: { label: "Meta Ad Click Trigger", triggerType: "meta_ad", keywords: ["ad_click"], heatmapCount: 0 }
    });
    nodes.push({
      id: IDS.ad_welcome, type: "message", position: { x: 400, y: 200 },
      data: { label: "Ad Welcome", text: content.ad_welcome, heatmapCount: 0 }
    });
    edges.push(
      { id: `e_${IDS.trig_ad}_aw`, source: IDS.trig_ad,    target: IDS.ad_welcome },
      { id: `e_${IDS.ad_welcome}_mm`, source: IDS.ad_welcome, target: IDS.main_menu }
    );
  }
  if (F.enableInstagramTrigger) {
    nodes.push({
      id: IDS.trig_ig, type: "trigger", position: { x: 800, y: 0 },
      data: { label: "Instagram Trigger", triggerType: "ig_story_mention", keywords: ["story_mention"], heatmapCount: 0 }
    });
    nodes.push({
      id: IDS.ig_welcome, type: "message", position: { x: 800, y: 200 },
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
      id: IDS.welcome, type: "template", position: { x: 1200, y: 0 },
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
      id: IDS.welcome, type: "interactive", position: { x: 1200, y: 0 },
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
    id: IDS.main_menu, type: "interactive", position: { x: 1800, y: 0 },
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
  const { F, currency, products, storeUrl, client, wizardData } = ctx;
  const nodes = [], edges = [];

  nodes.push({
    id: IDS.cat_list, type: "interactive", position: { x: 2400, y: -600 },
    data: {
      label: "Product Catalog", interactiveType: "list",
      text: "Ready to explore {{brand_name}} products? Pick one below 👇",
      buttonText: "View Products",
      sections: [{
        title: "{{brand_name}} — Products",
        rows: products.length
          ? products.map((p, i) => ({
              id: `p_${i}`, title: truncate(p.title, 24),
              description: `${currency}${parseInt(p.price || 0, 10).toLocaleString("en-IN")}`
            }))
          : [{ id: "no_products", title: "No products yet", description: "Sync your store first" }]
      }],
      heatmapCount: 0
    }
  });

  const supEntryProduct = F.enableSupportEscalation
    ? (F.enableBusinessHoursGate && !F.enable247 ? IDS.sup_sch : IDS.sup_capture)
    : IDS.ai_fallback;

  if (products.length) {
    nodes.push(
      {
        id: IDS.cat_addr_prompt,
        type: "message",
        position: { x: 3200, y: -900 },
        data: {
          label: "Delivery address",
          text: "📍 Share your *full delivery address* (house, street, city, PIN) so {{brand_name}} can arrange delivery or a callback.",
          heatmapCount: 0
        }
      },
      {
        id: IDS.cat_addr_cap,
        type: "capture_input",
        position: { x: 3600, y: -900 },
        data: {
          label: "Capture address",
          variable: "shipping_address",
          question: "Type your complete shipping address in one message.",
          text: "Type your complete shipping address in one message.",
          heatmapCount: 0
        }
      },
      {
        id: IDS.cat_addr_done,
        type: "message",
        position: { x: 4000, y: -900 },
        data: {
          label: "Address received",
          text: "✅ Thanks — we saved your address. A teammate may confirm details on WhatsApp shortly.",
          heatmapCount: 0
        }
      }
    );
    edges.push(
      { id: `e_${IDS.cat_addr_prompt}_cap`, source: IDS.cat_addr_prompt, target: IDS.cat_addr_cap },
      { id: `e_${IDS.cat_addr_cap}_done`, source: IDS.cat_addr_cap, target: IDS.cat_addr_done }
    );
    if (F.enableAdminAlerts) {
      nodes.push({
        id: IDS.cat_addr_alert,
        type: "admin_alert",
        position: { x: 4400, y: -900 },
        data: {
          label: "Buy intent alert",
          priority: "medium",
          topic: "Buy intent — {{brand_name}}",
          phone: ctx.adminPhone || client.adminPhone || "",
          heatmapCount: 0
        }
      });
      edges.push(
        { id: `e_${IDS.cat_addr_done}_al`, source: IDS.cat_addr_done, target: IDS.cat_addr_alert },
        { id: `e_${IDS.cat_addr_alert}_mm`, source: IDS.cat_addr_alert, target: IDS.main_menu }
      );
    } else {
      edges.push({ id: `e_${IDS.cat_addr_done}_mm`, source: IDS.cat_addr_done, target: IDS.main_menu });
    }
  }

  products.forEach((p, i) => {
    const prodId = `prod_${i}_${IDS.seed}`;
    const canonicalTplName = `prod_${p.handle}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 50);
    const legacyTplName    = `${client.clientId}_${p.handle}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 50);
    const hasTemplate = (client.syncedMetaTemplates || [])
      .some(t => t.productHandle === p.handle || t.name === canonicalTplName || t.name === legacyTplName);

    if (!hasTemplate && wizardData.productMode === "template") {
      wizardData.customTemplates = wizardData.customTemplates || [];
      if (!wizardData.customTemplates.find(t => t.name === canonicalTplName)) {
        wizardData.customTemplates.push({
          name: canonicalTplName, category: "MARKETING", language: "en",
          components: [
            { type: "HEADER", format: "IMAGE", _imageUrl: p.imageUrl || "" },
            { type: "BODY",   text: `Product: *{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n{{3}}` },
            { type: "BUTTONS", buttons: [
              { type: "URL", text: "Order Now", url: `${storeUrl}/products/${p.handle}` },
              { type: "QUICK_REPLY", text: "Talk to Agent" }
            ]}
          ]
        });
      }
    }

    nodes.push({
      id: prodId,
      type: hasTemplate ? "template" : "interactive",
      position: { x: 2900, y: (i * 220) - (products.length * 100) },
      data: hasTemplate ? {
        label: truncate(`Product: ${p.title}`, 30),
        templateName: canonicalTplName,
        imageUrl: p.imageUrl || "",
        shopifyProductId: p.id,
        shopifyProductUrl: `${storeUrl}/products/${p.handle}`,
        buttonsList: [
          { id: "buy",   title: "Buy" },
          { id: "agent", title: "Talk to Agent" },
          { id: "menu",  title: "Main Menu" }
        ],
        variables: ["customer_name", "product_price", "warranty"],
        heatmapCount: 0
      } : {
        label: truncate(`Product: ${p.title}`, 30),
        interactiveType: "button", imageUrl: p.imageUrl || "",
        text: `*${p.title}*\n\n💰 Price: {{currency}}${parseInt(p.price || 0, 10).toLocaleString("en-IN")}\n✅ {{warranty_duration}} Warranty | 🚚 Free Shipping`,
        buttonsList: [
          { id: "buy",   title: "🛒 Buy Now" },
          { id: "agent", title: "📞 Talk to Agent" },
          { id: "menu",  title: "⬅️ Main Menu" }
        ],
        shopifyProductId: p.id,
        shopifyProductUrl: `${storeUrl}/products/${p.handle}`,
        heatmapCount: 0
      }
    });

    const buyTarget = products.length ? IDS.cat_addr_prompt : IDS.ai_fallback;
    edges.push({ id: `e_${IDS.cat_list}_p${i}`, source: IDS.cat_list, target: prodId, sourceHandle: `p_${i}` });
    edges.push({ id: `e_${prodId}_buy`, source: prodId, target: buyTarget, sourceHandle: "buy" });
    edges.push({ id: `e_${prodId}_agent`, source: prodId, target: supEntryProduct, sourceHandle: "agent" });
    edges.push({ id: `e_${prodId}_menu`, source: prodId, target: IDS.main_menu, sourceHandle: "menu" });
  });

  if (!products.length) {
    edges.push({
      id: `e_${IDS.cat_list}_nop`,
      source: IDS.cat_list,
      target: IDS.main_menu,
      sourceHandle: "no_products"
    });
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
      position: { x: 2400, y: 200 },
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
      position: { x: 2750, y: 200 },
      data: {
        label: "Order status (flow)",
        text: content.order_status_msg,
        heatmapCount: 0
      }
    },
    {
      id: IDS.ord_notfound,
      type: "capture_input",
      position: { x: 2900, y: 100 },
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
    { id: `e_${IDS.ord_track}_ok`, source: IDS.ord_track, target: IDS.ord_status_msg, sourceHandle: "success" }
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
        position: { x: 3100, y: 380 },
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
        position: { x: 3600, y: 380 },
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
        position: { x: 4100, y: 380 },
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
        position: { x: 4600, y: 560 },
        data: { label: "Already Shipped Error", text: content.in_transit_error, heatmapCount: 0 }
      },
      {
        id: IDS.can_reason,
        type: "capture_input",
        position: { x: 4600, y: 280 },
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
        position: { x: 5100, y: 280 },
        data: { label: "Process Cancellation", action: "CANCEL_ORDER", heatmapCount: 0 }
      },
      {
        id: IDS.can_succ,
        type: "message",
        position: { x: 5600, y: 280 },
        data: { label: "Cancel Success", text: content.cancellation_success, heatmapCount: 0 }
      },
      {
        id: IDS.can_fail,
        type: "message",
        position: { x: 5600, y: 400 },
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
      { id: `e_${IDS.can_action}_f`, source: IDS.can_action, target: IDS.can_fail, sourceHandle: "fail" }
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
    { id: IDS.ret_hub, type: "interactive", position: { x: 2400, y: 700 },
      data: { label: "Returns Hub", interactiveType: "button",
        text: "How can {{brand_name}} help with returns or refunds?",
        buttonsList: [
          { id: "return", title: "📸 Start Return" },
          { id: "refund", title: "💸 Refund Status" },
          { id: "menu",   title: "⬅️ Main Menu" }
        ], heatmapCount: 0 } },
    { id: IDS.ret_reason, type: "capture_input", position: { x: 2900, y: 650 },
      data: { label: "Return Reason", variable: "return_reason",
        question: "Briefly describe why you want to return this item.",
        text: "Briefly describe why you want to return this item.", heatmapCount: 0 } },
    { id: IDS.ret_photo, type: "capture_input", position: { x: 3400, y: 650 },
      data: { label: "Return Photo", variable: "return_photo",
        question: content.return_photo_prompt, text: content.return_photo_prompt, heatmapCount: 0 } },
    { id: IDS.ret_confirm, type: "message", position: { x: 3900, y: 650 },
      data: { label: "Return Confirmed",
        text: "✅ Return request logged for *{{order_number}}*. Our team will update you within 24–48 hours on WhatsApp.",
        heatmapCount: 0 } },
    { id: IDS.ret_tag, type: "tag_lead", position: { x: 4300, y: 650 },
      data: { label: "Tag return", action: "add", tag: "return-open", heatmapCount: 0 } },
    { id: IDS.ref_check, type: "shopify_call", position: { x: 2900, y: 850 },
      data: { label: "Refund Status", action: "ORDER_REFUND_STATUS", heatmapCount: 0 } },
    { id: IDS.ref_result, type: "message", position: { x: 3400, y: 850 },
      data: { label: "Refund Result", text: "Refund updates usually post within *5–7 business days* depending on your bank.", heatmapCount: 0 } }
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
      position: { x: 4700, y: 650 },
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
        position: { x: 5100, y: 650 },
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
      id: IDS.ret_policy, type: "message", position: { x: 4700, y: 650 },
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
    { id: IDS.war_hub, type: "interactive", position: { x: 2400, y: 1200 },
      data: { label: "Warranty Hub", interactiveType: "button",
        text: content.warranty_welcome,
        buttonsList: [
          { id: "reg",   title: "✅ Register" },
          { id: "check", title: "🔍 Check Status" },
          { id: "menu",  title: "⬅️ Main Menu" }
        ], heatmapCount: 0 } },
    { id: IDS.war_serial,  type: "capture_input", position: { x: 2900, y: 1100 },
      data: { label: "Warranty Serial", variable: "warranty_serial",
        question: "Enter serial number or order id.", text: "Enter serial number or order id.", heatmapCount: 0 } },
    { id: IDS.war_date,    type: "capture_input", position: { x: 3400, y: 1100 },
      data: { label: "Purchase Date", variable: "purchase_date",
        question: "Enter purchase date (DD/MM/YYYY).", text: "Enter purchase date (DD/MM/YYYY).", heatmapCount: 0 } },
    { id: IDS.war_tag,     type: "tag_lead", position: { x: 3900, y: 1100 },
      data: { label: "Warranty Tag", action: "add", tag: "warranty-enrolled", heatmapCount: 0 } },
    { id: IDS.war_success, type: "message", position: { x: 4400, y: 1100 },
      data: { label: "Warranty Success", text: content.warranty_reg_success, heatmapCount: 0 } },
    { id: IDS.war_lookup,  type: "capture_input", position: { x: 2900, y: 1300 },
      data: { label: "Lookup Serial", variable: "lookup_serial",
        question: content.warranty_lookup_prompt, text: content.warranty_lookup_prompt, heatmapCount: 0 } },
    { id: IDS.war_engine,  type: "warranty_check", position: { x: 3400, y: 1300 },
      data: { label: "Warranty Check", action: "WARRANTY_CHECK", heatmapCount: 0 } },
    { id: IDS.war_active,  type: "message", position: { x: 3900, y: 1200 },
      data: { label: "Warranty Active",
        text: "✅ Your product is under an *active {{warranty_duration}} warranty* with *{{brand_name}}*. Our team will help with the next step. 🛡️", heatmapCount: 0 } },
    { id: IDS.war_expired, type: "message", position: { x: 3900, y: 1300 },
      data: { label: "Warranty Expired",
        text: "⚠️ This serial is past the *{{warranty_duration}}* coverage window. We can still help with paid repair options at *{{brand_name}}*.", heatmapCount: 0 } },
    { id: IDS.war_none,    type: "message", position: { x: 3900, y: 1400 },
      data: { label: "No Warranty",
        text: "❌ No warranty record found for that serial. Register your product with *{{brand_name}}* or tap *menu* for human support.", heatmapCount: 0 } }
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
    { id: `e_${IDS.war_engine}_n`,  source: IDS.war_engine, target: IDS.war_none,    sourceHandle: "none" }
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
    { id: IDS.loy_menu, type: "interactive", position: { x: 2400, y: 1600 },
      data: { label: "Rewards Hub", interactiveType: "list",
        text: content.loyalty_welcome, buttonText: "My Rewards",
        sections: [{ title: "{{brand_name}} — Rewards", rows: loyRows }], heatmapCount: 0 } },
    { id: IDS.loy_balance, type: "message", position: { x: 2900, y: 1500 },
      data: { label: "Points Balance", text: content.loyalty_points_msg, heatmapCount: 0 } },
    { id: IDS.loy_redeem, type: "loyalty_action", position: { x: 2900, y: 1650 },
      data: { label: "Redeem Loyalty", actionType: "REDEEM_POINTS", pointsRequired: 100, heatmapCount: 0 } },
    { id: IDS.loy_redeem_ok, type: "message", position: { x: 3400, y: 1600 },
      data: { label: "Redeem Success", text: "🎁 Redeemed! Your discount has been applied at checkout.", heatmapCount: 0 } },
    { id: IDS.loy_redeem_fail, type: "message", position: { x: 3400, y: 1750 },
      data: { label: "Insufficient Points", text: "😔 You need more points to redeem. Keep shopping to earn! 💎", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_${IDS.loy_menu}_pts`, source: IDS.loy_menu, target: IDS.loy_balance, sourceHandle: "pts" },
    { id: `e_${IDS.loy_menu}_red`, source: IDS.loy_menu, target: IDS.loy_redeem,  sourceHandle: "red" },
    { id: `e_${IDS.loy_menu}_mn`,  source: IDS.loy_menu, target: IDS.main_menu,   sourceHandle: "menu" },
    { id: `e_${IDS.loy_redeem}_s`, source: IDS.loy_redeem, target: IDS.loy_redeem_ok,   sourceHandle: "success" },
    { id: `e_${IDS.loy_redeem}_f`, source: IDS.loy_redeem, target: IDS.loy_redeem_fail, sourceHandle: "fail" }
  );

  if (F.enableReferral) {
    nodes.push({
      id: IDS.loy_refer, type: "message", position: { x: 2900, y: 1800 },
      data: { label: "Refer", text: content.referral_msg, heatmapCount: 0 }
    });
    edges.push({ id: `e_${IDS.loy_menu}_ref`, source: IDS.loy_menu, target: IDS.loy_refer, sourceHandle: "ref" });
  }

  return {
    nodes, edges,
    menuRow: { id: "loyalty", title: "💎 My Rewards" },
    entryNodeId: IDS.loy_menu,
    sourceHandle: "loyalty"
  };
}

function buildSupportBranch(ctx, IDS, content) {
  const { F, openTime, closeTime, workingDays, adminPhone, client } = ctx;
  const nodes = [], edges = [];

  // Optional business-hours gate
  if (F.enableBusinessHoursGate && !F.enable247) {
    nodes.push(
      { id: IDS.sup_sch, type: "schedule", position: { x: 2400, y: 2050 },
        data: { label: "Business Hours Gate", openTime, closeTime, days: workingDays,
          closedMessage: content.support_schedule_closed_nudge, heatmapCount: 0 } },
      { id: IDS.sup_closed, type: "message", position: { x: 2900, y: 2150 },
        data: { label: "After Hours", text: content.support_hours_msg, heatmapCount: 0 } }
    );
    edges.push(
      { id: `e_${IDS.sup_sch}_open`, source: IDS.sup_sch, target: IDS.sup_capture, sourceHandle: "open" },
      { id: `e_${IDS.sup_sch}_cl`,   source: IDS.sup_sch, target: IDS.sup_closed,  sourceHandle: "closed" }
    );
  }

  nodes.push(
    { id: IDS.sup_capture, type: "capture_input", position: { x: 2900, y: 1950 },
      data: { label: "Support Query", variable: "support_query",
        question: content.support_capture_prompt,
        text: content.support_capture_prompt, heatmapCount: 0 } },
    { id: IDS.sup_tag, type: "tag_lead", position: { x: 3400, y: 1950 },
      data: { label: "Tag Pending Human", action: "add", tag: "pending-human", heatmapCount: 0 } },
    { id: IDS.sup_confirm, type: "message", position: { x: 4400, y: 1950 },
      data: { label: "Handoff Confirmed", text: content.agent_handoff_msg,
        humanEscalationTimeoutMin: F.humanEscalationTimeoutMin, heatmapCount: 0 } },
    { id: IDS.sup_livechat, type: "livechat", position: { x: 4900, y: 1950 },
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
      id: IDS.sup_alert, type: "admin_alert", position: { x: 3900, y: 1950 },
      data: { label: "Admin Alert", priority: "high",
        topic: "Human request — {{brand_name}}",
        phone: adminPhone || client.adminPhone || "", heatmapCount: 0 }
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
    id: IDS.faq_msg, type: "message", position: { x: 2400, y: 2450 },
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
    id: IDS.trig_cart, type: "trigger", position: { x: -800, y: 400 },
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
      suppressAIFallbackLink: i === steps.length - 1,
    };
    if (i === 0) {
      msgData.imageUrl = '{{first_product_image}}';
    }
    nodes.push(
      { id: dId, type: "delay", position: { x: -800 + (i * 800), y: 600 },
        data: { label: `Wait ${step.delay} ${step.unit}`, duration: step.delay, unit: step.unit, waitValue: step.delay, waitUnit: step.unit, heatmapCount: 0 } },
      { id: mId, type: "message", position: { x: -400 + (i * 800), y: 600 },
        data: msgData }
    );
    edges.push({ id: `e_${prev}_d${i}`, source: prev, target: dId });
    edges.push({ id: `e_${dId}_m${i}`,  source: dId,  target: mId });
    prev = mId;
  });
  return { nodes, edges };
}

function buildOrderConfirmAndCod(ctx, IDS, content) {
  const { F } = ctx;
  const nodes = [
    { id: IDS.trig_order, type: "trigger", position: { x: -800, y: 0 },
      data: { label: "Order Placed Trigger", triggerType: "order_placed", heatmapCount: 0 } },
    { id: IDS.conf_msg, type: "message", position: { x: -400, y: 0 },
      data: {
        label: "Order Confirmed",
        text: content.order_confirmed_msg,
        heatmapCount: 0,
        suppressAIFallbackLink: true,
        imageUrl: '{{first_product_image}}',
      } }
  ];
  const edges = [{ id: `e_${IDS.trig_order}_cm`, source: IDS.trig_order, target: IDS.conf_msg }];

  if (F.enableCodToPrepaid) {
    nodes.push(
      { id: IDS.cod_check, type: "logic", position: { x: 0, y: -200 },
        data: { label: "Is COD?", variable: "payment_method", operator: "contains", value: "cod", heatmapCount: 0 } },
      { id: IDS.cod_node, type: "cod_prepaid", position: { x: 400, y: -300 },
        data: { label: "COD Nudge", action: "CONVERT_COD_TO_PREPAID",
          discountAmount: F.codDiscountAmount, text: content.cod_nudge, heatmapCount: 0 } },
      { id: IDS.cod_paid_msg, type: "message", position: { x: 900, y: -400 },
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
      { id: `e_${IDS.cod_node}_cd`,  source: IDS.cod_node, target: IDS.ai_fallback,   sourceHandle: "cod" }
    );
  }

  return { nodes, edges };
}

function buildReviewAutomation(ctx, IDS, content) {
  const { googleReviewUrl } = ctx;
  const nodes = [
    { id: IDS.trig_fulfill, type: "trigger", position: { x: -800, y: 1000 },
      data: { label: "Order Fulfilled Trigger", triggerType: "order_fulfilled", heatmapCount: 0 } },
    { id: IDS.rev_request, type: "review", position: { x: -400, y: 1000 },
      data: { label: "Review Request", action: "SEND_REVIEW_REQUEST",
        text: content.sentiment_ask, googleReviewUrl, heatmapCount: 0 } },
    { id: IDS.rev_positive, type: "message", position: { x: 100, y: 900 },
      data: {
        label: "Positive",
        text: content.review_positive + (googleReviewUrl ? `\n${googleReviewUrl}` : ""),
        action: "LOG_REVIEW_POSITIVE",
        heatmapCount: 0,
        suppressAIFallbackLink: true,
      } },
    { id: IDS.rev_negative, type: "message", position: { x: 100, y: 1100 },
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
    { id: `e_${IDS.rev_request}_n`,   source: IDS.rev_request,  target: IDS.rev_negative, sourceHandle: "negative" }
  ];
  return { nodes, edges };
}

function buildB2BBranch(ctx, IDS) {
  const { adminPhone, client } = ctx;
  const nodes = [
    { id: IDS.b2b_trigger, type: "trigger", position: { x: -600, y: 1500 },
      data: { label: "B2B Trigger", triggerType: "keyword",
        keywords: ["wholesale", "bulk", "b2b", "dealer", "distributor"], matchMode: "contains", heatmapCount: 0 } },
    { id: IDS.b2b_capture, type: "capture_input", position: { x: -200, y: 1500 },
      data: { label: "B2B Requirement", variable: "b2b_requirement",
        question: "Please share company name and monthly requirement.",
        text: "Please share company name and monthly requirement.", heatmapCount: 0 } },
    { id: IDS.b2b_tag, type: "tag_lead", position: { x: 200, y: 1500 },
      data: { label: "Tag B2B", action: "add", tag: "b2b-prospect", heatmapCount: 0 } },
    { id: IDS.b2b_alert, type: "admin_alert", position: { x: 600, y: 1500 },
      data: { label: "B2B Alert", priority: "high",
        topic: "B2B Lead — {{brand_name}}",
        phone: adminPhone || client.adminPhone || "", heatmapCount: 0 } },
    { id: IDS.b2b_confirm, type: "message", position: { x: 1000, y: 1500 },
      data: { label: "B2B Confirm",
        text: "Thanks — *{{brand_name}}* wholesale will reach out on WhatsApp with pricing and MOQs.", heatmapCount: 0 } }
  ];
  const edges = [
    { id: `e_${IDS.b2b_trigger}_c`, source: IDS.b2b_trigger, target: IDS.b2b_capture },
    { id: `e_${IDS.b2b_capture}_t`, source: IDS.b2b_capture, target: IDS.b2b_tag },
    { id: `e_${IDS.b2b_tag}_a`,     source: IDS.b2b_tag,     target: IDS.b2b_alert },
    { id: `e_${IDS.b2b_alert}_cf`,  source: IDS.b2b_alert,   target: IDS.b2b_confirm }
  ];
  return { nodes, edges };
}

function buildAIFallback(ctx, IDS) {
  return {
    nodes: [{
      id: IDS.ai_fallback, type: "message", position: { x: 0, y: -600 },
      data: { label: "🤖 AI Smart Reply", action: "AI_FALLBACK",
        text: ctx.fallbackMessage || "", heatmapCount: 0 }
    }],
    edges: []
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 5. ORCHESTRATOR
// ═════════════════════════════════════════════════════════════════════════
async function generateEcommerceFlow(client, wizardData = {}) {
  const ctx = buildContext(client, wizardData);
  const IDS = buildIDs(client, wizardData);
  const F = ctx.F;

  // Marketing copy (best-effort)
  const defaults = buildDefaultContent(ctx);
  const ai = wizardData.useAiCopy === true ? await generateAIContent(ctx) : {};
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

  // Wire dead-ends to the AI fallback
  if (F.enableAIFallback) {
    const sources = new Set(dedupEdges.map(e => e.source));
    const deadEndTypes = ["message", "shopify_call", "loyalty_action", "tag_lead", "review", "warranty_check", "cod_prepaid", "admin_alert"];
    dedupNodes.forEach(node => {
      if (node.data?.suppressAIFallbackLink) return;
      if (deadEndTypes.includes(node.type) && !sources.has(node.id) && node.id !== IDS.ai_fallback) {
        dedupEdges.push({
          id: `e_dead_${node.id}`,
          source: node.id,
          target: IDS.ai_fallback,
          animated: false,
          style: { strokeDasharray: "4 4", stroke: "#6366f1", opacity: 0.4 }
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

  const productTemplates = allProducts.map((p) => {
    const safeName = `prod_${p.handle.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`.substring(0, 50);
    const buyUrl   = storeBase ? `${storeBase}/products/${p.handle}` : "";
    return {
      id: safeName, name: safeName, category: "MARKETING", language: "en",
      status: "not_submitted", required: false,
      description: `Rich product card for "${p.title}" — IMAGE header + buy button.`,
      components: [
        { type: "HEADER", format: "IMAGE", _imageUrl: p.imageUrl || "" },
        { type: "BODY",   text: `Product: *{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n*Key Features:*\n{{3}}\n\nClick below to view more details!` },
        { type: "FOOTER", text: brandSafe },
        { type: "BUTTONS", buttons: [
          ...(buyUrl
            ? [{ type: "URL", text: "🛒 Buy Now", url: buyUrl }]
            : [{ type: "QUICK_REPLY", text: "🛒 Buy Now" }]),
          { type: "QUICK_REPLY", text: "⬅️ Main Menu" }
        ]}
      ],
      body: `Product: *{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n*Key Features:*\n{{3}}\n\nClick below to view more details!`,
      variables: ["product_name", "product_price", "product_features"]
    };
  });

  return [
    {
      id: "welcome_with_logo", name: "welcome_with_logo",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "Branded welcome — IMAGE header (your logo) + quick-reply main menu.",
      components: [
        { type: "HEADER", format: "IMAGE", _imageUrl: businessLogo || "" },
        { type: "BODY",   text: `👋 Welcome to *{{1}}*\n\nClear communication and visible trust signals help customers feel confident before they buy. We're here to guide you — quick answers, honest recommendations, and a smooth path to checkout.\n\nWhat would you like to do next?` },
        { type: "BUTTONS", buttons: [
          { type: "QUICK_REPLY", text: "Browse products" },
          { type: "QUICK_REPLY", text: "Track my order" },
          { type: "QUICK_REPLY", text: "Talk to support" }
        ]}
      ],
      body: `👋 Welcome to *{{1}}*\n\nClear communication and visible trust signals help customers feel confident before they buy. We're here to guide you — quick answers, honest recommendations, and a smooth path to checkout.\n\nWhat would you like to do next?`,
      variables: ["business_name"]
    },
    ...productTemplates,
    {
      id: "order_conf", name: "order_conf",
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
      id: "cart_recovery", name: "cart_recovery",
      category: "MARKETING", language: "en", status: "not_submitted", required: true,
      description: "Sent if checkout is started but not completed.",
      components: [
        { type: "BODY", text: `Hi — you still have great picks saved at ${brandSafe}.\n\nYour cart is waiting. When you're ready, continue checkout securely here:\n{{1}}\n\nNeed sizing, delivery, or payment help? Reply here and we'll sort it out.` },
        ...(storeBase ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Complete Purchase", url: `${storeBase}/cart` }] }] : [])
      ],
      body: `Hi — you still have great picks saved at ${brandSafe}.\n\nYour cart is waiting. When you're ready, continue checkout securely here:\n{{1}}\n\nNeed sizing, delivery, or payment help? Reply here and we'll sort it out.`,
      variables: ["checkout_url"]
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
      id: "cod_nudge", name: "cod_to_prepaid_nudge",
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
      id: "review_request", name: "post_delivery_review",
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
