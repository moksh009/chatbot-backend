"use strict";

const { generateJSON } = require("./gemini");

/**
 * FLOW GENERATOR — GOLDEN PATH ENTERPRISE EDITION v5.0
 *
 * Architecture: 8 Folder hierarchy with a hardcoded "Golden Path" conversational tree.
 *   Folder 1 — Welcome & Entry Hub      (trigger → welcome msg → main menu list)
 *   Folder 2 — Product Catalog          (shop branch → category/product cards)
 *   Folder 3 — Order Operations         (track branch → Shopify CHECK_ORDER_STATUS)
 *   Folder 4 — Returns & Refunds        (returns branch → photo capture → Shopify)
 *   Folder 5 — Support & Escalation     (support branch → capture → tag → alert → msg)
 *   Folder 6 — Loyalty & Rewards        (loyalty branch → points/redeem/referral/VIP)
 *   Folder 7 — Smart Automations        (shopify events: cart abandon, order confirm, review)
 *   Folder 8 — Post-Purchase Hub        (warranty, FAQ, B2B, product guides)
 *
 * CANONICAL NODE TYPES (must match FlowCanvas.jsx nodeTypes exactly):
 *   message | interactive | template | trigger | logic | capture_input |
 *   shopify_call | delay | loyalty | admin_alert | schedule | review |
 *   abandoned_cart | cod_prepaid | warranty_check | tag_lead | ab_test |
 *   payment_link | livechat | http_request | escalate
 *
 * KEY FEATURES:
 *   ✅ Golden Path — hardcoded main menu IDs: shop, track, returns, loyalty, support, warranty
 *   ✅ No A/B test at entry (removed for UX clarity)
 *   ✅ Dead-end AI Fallback — auto-wires every stranded node to AI_FALLBACK
 *   ✅ stripPlaceholders — removes [X], [15 minutes], etc. from AI-generated text
 *   ✅ verifyFlowIntegrity — blocks heavy array blobs inside node.data
 *   ✅ Smart Indian e-commerce keywords for entry trigger
 *   ✅ 38-key Gemini content generation with full fallback defaults
 *
 * @param {Object} client     - Client Mongoose document (for geminiApiKey)
 * @param {Object} wizardData - Onboarding wizard payload
 * @returns {{ nodes: Array, edges: Array }}
 */

// ─── UTILITY: Build rich product context ─────────────────────────────────────
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

// ─── UTILITY: Strip lazy AI placeholder text ─────────────────────────────────
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

// ─── UTILITY: Apply stripPlaceholders recursively to all text fields ──────────
function cleanNodeText(nodes) {
  return nodes.map(n => {
    if (!n.data) return n;
    if (typeof n.data.text === "string")         n.data.text = stripPlaceholders(n.data.text);
    if (typeof n.data.body === "string")         n.data.body = stripPlaceholders(n.data.body);
    if (typeof n.data.question === "string")     n.data.question = stripPlaceholders(n.data.question);
    if (n.data.content && typeof n.data.content.body === "string") {
      n.data.content.body = stripPlaceholders(n.data.content.body);
    }
    if (Array.isArray(n.data.steps)) {
      n.data.steps = n.data.steps.map(s => ({
        ...s,
        text: stripPlaceholders(s.text),
      }));
    }
    return n;
  });
}

// ─── UTILITY: Strict button-ID → edge sourceHandle validator ─────────────────
// This is the LAW. Throws if ANY interactive node's button/row IDs don't have
// a matching edge sourceHandle. Run before saving to DB.
function verifyAllEdgesMatchButtonIds(nodes, edges) {
  const issues = [];

  nodes.forEach(node => {
    if (node.type !== 'interactive' && node.type !== 'template') return;

    const btns = node.data?.buttonsList || [];
    const rows = (node.data?.sections || []).flatMap(s => s.rows || []);
    const validIds = new Set([...btns, ...rows].map(b => String(b.id)));

    // Every outgoing edge with a sourceHandle must match a declared button/row id
    edges.filter(e => e.source === node.id && e.sourceHandle).forEach(edge => {
      const sh = String(edge.sourceHandle);
      if (!validIds.has(sh)) {
        issues.push(
          `[MISMATCH] Node "${node.id}" (${node.data?.label || '?'}) edge "${edge.id}" has sourceHandle "${sh}" but valid IDs are: [${[...validIds].join(', ')}]`
        );
      }
    });
  });

  if (issues.length > 0) {
    console.error(`[FlowGenerator] ❌ BUTTON-ID MISMATCH FOUND — ${issues.length} issue(s):\n${issues.join('\n')}`);
    throw new Error(`Flow integrity failed: ${issues.length} button-ID/edge mismatch(es). Fix the generator before saving.`);
  }

  console.log('[FlowGenerator] ✅ verifyAllEdgesMatchButtonIds — all button IDs match their edge sourceHandles.');
  return true;
}

// ─── UTILITY: Verify flow integrity before returning  ─────────────────────────
function verifyFlowIntegrity(nodes, edges) {
  const nodeIds = new Set(nodes.map(n => n.id));
  const issues  = [];
  const seen    = new Set();

  // Prohibited heavy arrays — must never be embedded in node.data
  const PROHIBITED_KEYS = [
    "waTemplates", "shopifyProducts", "teamMembers", "availableTags",
    "waFlows", "allProducts", "catalogItems",
  ];

  nodes.forEach((n, i) => {
    if (!n.id) { issues.push(`Node[${i}] missing id`); return; }
    if (seen.has(n.id)) issues.push(`Duplicate node id: ${n.id}`);
    seen.add(n.id);

    PROHIBITED_KEYS.forEach(key => {
      if (n.data && Array.isArray(n.data[key]) && n.data[key].length > 0) {
        issues.push(`Node ${n.id} has prohibited data.${key} (${n.data[key].length} items) — strip before saving`);
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

  console.log(`[FlowGenerator] ✅ Integrity OK — ${nodes.length} nodes, ${edges.length} edges (8 folders).`);
  return true;
}

// ─── SMART DEFAULTS — used when Gemini AI generation fails ───────────────────
function buildDefaultContent(businessName, botName, products = [], ops = {}) {
  const {
    referralPoints  = 500,
    signupPoints    = 100,
    warrantyDuration = "1 Year",
    openTime        = "10:00",
    closeTime       = "19:00",
    checkoutUrl     = "",
    currency        = "₹",
  } = ops;

  return {
    welcome_a:            `👋 Welcome to *${businessName}*! I'm ${botName}, your assistant. Let's get started.`,
    welcome_b:            `🛍️ Hey there! Explore our products and services at *${businessName}*!`,
    product_menu_text:    `Welcome to the *${businessName}* Hub! How can we help you today?`,
    order_status_msg:     `📦 Tracking your order... Typical delivery takes 3–5 business days.`,
    fallback_msg:         `I'm still learning! 😊 Connecting you with a human expert who can help.`,
    returns_policy_short: `Easy 7-day returns on all unused items. Just share a photo to start! 🔄`,
    refund_policy_short:  `Refunds processed within 5–7 business days. 💳`,
    cancellation_confirm: `Are you sure you want to cancel? This cannot be undone.`,
    cancellation_success: `Cancellation processed successfully. We hope to serve you again! 💙`,
    loyalty_welcome:      `🎉 Welcome to *${businessName}* Rewards! You've earned *${signupPoints} points*!`,
    loyalty_points_msg:   `💎 You have points available! Redeem them for instant discounts.`,
    referral_msg:         `Refer a friend and earn *${referralPoints} bonus points*! 🎁`,
    sentiment_ask:        `How was your experience today? We value your feedback! 😊`,
    review_positive:      `That's great! 🌟 Please consider sharing your review on Google.`,
    review_negative:      `We're sorry! 😔 An agent will be with you shortly to make it right.`,
    upsell_intro:         `Check out these other popular items you might like! 👇`,
    cross_sell_msg:       `People also bought these! Want to see more?`,
    cart_recovery_1:      `👋 Your cart at *${businessName}* is waiting for you!`,
    cart_recovery_2:      `⏰ Items are selling fast! Complete your order soon.`,
    cart_recovery_3:      `🔥 Use code SAVE10 for 10% OFF if you finish your order now!`,
    cod_nudge:            `💳 Save ₹50 and get faster delivery with online payment!`,
    order_confirmed_msg:  `🎉 Order confirmed! We'll notify you when it ships.`,
    agent_handoff_msg:    `I've alerted the team. They’ll be right with you. 🎧`,
    faq_response:         `Here are some helpful answers. Type *menu* to return.`,
    ad_welcome:           `Thanks for clicking! 👋 How can I help you explore *${businessName}*?`,
    ig_welcome:           `Hey from IG! 📸 Let’s find what you’re looking for.`,
    b2b_welcome:          `Welcome to *${businessName}* Wholesale! 🤝`,
    b2b_capture_prompt:   `Please share your business name and monthly requirements.`,
    warranty_welcome:     `🛡️ Register your *${warrantyDuration}* warranty for priority support.`,
    warranty_lookup_prompt: `Enter your Order ID to check your warranty status.`,
    payment_request_body: `Pay securely via our encrypted portal. 🔒`,
    loyalty_award_reason: `Thank you for shopping! VIP points added to your wallet.`,
    installation_msg:     `Need setup help? Our guides or experts are ready for you. 🛠️`,
    support_hours_msg:    `Agents are active *${openTime}–${closeTime}*. I'm here 24/7! 📞`,
    vip_perk_msg:         `🌟 Exclusive VIP Discount! Use VIP20 for 20% OFF.`,
    new_member_nudge:     `You're almost at the next tier! Keep going! 🚀`,
    in_transit_error:     `Already shipped! 🚚 Contact returns once it arrives.`,
    return_photo_prompt:  `Please upload a clear photo of the item. 📸`,
    warranty_reg_success: `✅ Warranty registered for *${warrantyDuration}*!`,
  };
}

// ─── MAIN GENERATOR ──────────────────────────────────────────────────────────
async function generateEcommerceFlow(client, wizardData) {
  const {
    businessName = "My Business",
    businessDescription = "",
    botName = "Assistant",
    products = [],
    tone = "friendly",
    botLanguage = "Hinglish",
    cartTiming = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl = "",
    adminPhone = "",
    faqText = "",
    returnsInfo = "",
    fallbackMessage = "I can help with that. Let me route you to the right place.",
    openTime = "10:00",
    closeTime = "19:00",
    workingDays = [1, 2, 3, 4, 5, 6],
    checkoutUrl = "",
    referralPoints = 500,
    signupPoints = 100,
    activePersona = "sidekick",
    warrantyDuration = "1 Year",
    b2bEnabled = false,
    currency = "₹",
  } = wizardData;

  const ts = Date.now();
  const enrichedProducts = products.slice(0, 20).map((p, i) => buildProductContext(p, i));
  const storeUrl = (wizardData.shopDomain
    ? `https://${String(wizardData.shopDomain).replace(/^https?:\/\//, "")}`
    : checkoutUrl.replace(/\/checkout$/, "")) || "";

  const personaMap = {
    concierge:  { label: "Elite Concierge", type: "Luxury/Formal" },
    hacker:     { label: "Growth Hacker", type: "Sales/Aggressive" },
    sidekick:   { label: "Friendly Sidekick", type: "Casual/Friendly" },
    efficiency: { label: "Efficiency Expert", type: "Direct/Minimalist" },
  };
  const selectedPersona = personaMap[activePersona] || personaMap.sidekick;

  const defaultContent = buildDefaultContent(businessName, botName, enrichedProducts, {
    referralPoints, signupPoints, warrantyDuration, openTime, closeTime, checkoutUrl, currency
  });
  let aiContent = {};
  const productsSummary = enrichedProducts
    .slice(0, 8)
    .map((p) => `"${p.title}" ${currency}${p.price}: ${p.features.slice(0, 80)}`)
    .join("\n");
  const aiPrompt = `Create JSON marketing copy for WhatsApp commerce bot.
BRAND=${businessName}
DESCRIPTION=${businessDescription}
BOT=${botName}
TONE=${tone}
LANGUAGE=${botLanguage}
PERSONA=${selectedPersona.label} (${selectedPersona.type})
PRODUCTS:
${productsSummary}
Return only JSON with keys:
welcome_a,welcome_b,product_menu_text,order_status_msg,fallback_msg,returns_policy_short,refund_policy_short,cancellation_confirm,cancellation_success,loyalty_welcome,loyalty_points_msg,referral_msg,sentiment_ask,review_positive,review_negative,cart_recovery_1,cart_recovery_2,cart_recovery_3,cod_nudge,order_confirmed_msg,agent_handoff_msg,faq_response,ad_welcome,ig_welcome,warranty_welcome,warranty_lookup_prompt,support_hours_msg,return_photo_prompt,warranty_reg_success`;
  try {
    const parsed = await generateJSON(aiPrompt, client.geminiApiKey || process.env.GEMINI_API_KEY, {
      maxTokens: 3000,
      temperature: 0.2,
      timeout: 30000,
      maxRetries: 1
    });
    if (parsed && typeof parsed === "object") {
      aiContent = parsed;
    }
  } catch (_) {}
  const content = { ...defaultContent, ...aiContent };

  const nodes = [];
  const edges = [];

  const IDS = {
    trig_main: `trig_${ts}`,
    trig_ad: `trig_ad_${ts}`,
    trig_ig: `trig_ig_${ts}`,
    trig_order: `trig_ord_${ts}`,
    trig_cart: `trig_cart_${ts}`,
    trig_fulfill: `trig_ful_${ts}`,
    welcome_tpl: `tpl_welcome_${ts}`,
    ad_welcome: `msg_ad_wlc_${ts}`,
    ig_welcome: `msg_ig_wlc_${ts}`,
    main_menu: `menu_main_${ts}`,
    cat_list: `cat_list_${ts}`,
    ord_track: `ord_track_${ts}`,
    ord_hub: `ord_hub_${ts}`,
    can_confirm: `can_confirm_${ts}`,
    can_logic: `can_logic_${ts}`,
    can_reason: `can_reason_${ts}`,
    can_action: `can_action_${ts}`,
    can_shipped: `can_shipped_${ts}`,
    ret_hub: `ret_hub_${ts}`,
    ret_reason: `ret_reason_${ts}`,
    ret_photo: `ret_photo_${ts}`,
    ret_confirm: `ret_confirm_${ts}`,
    ref_check: `ref_check_${ts}`,
    ref_result: `ref_result_${ts}`,
    war_hub: `war_hub_${ts}`,
    war_serial: `war_serial_${ts}`,
    war_date: `war_date_${ts}`,
    war_tag: `war_tag_${ts}`,
    war_success: `war_success_${ts}`,
    war_lookup: `war_lookup_${ts}`,
    war_engine: `war_engine_${ts}`,
    loy_menu: `loy_menu_${ts}`,
    loy_balance: `loy_bal_${ts}`,
    loy_redeem: `loy_red_${ts}`,
    loy_refer: `loy_ref_${ts}`,
    sup_sch: `sup_sch_${ts}`,
    sup_capture: `sup_cap_${ts}`,
    sup_tag: `sup_tag_${ts}`,
    sup_alert: `sup_alert_${ts}`,
    sup_confirm: `sup_conf_${ts}`,
    sup_closed: `sup_closed_${ts}`,
    faq_msg: `faq_${ts}`,
    conf_msg: `conf_msg_${ts}`,
    cod_check: `cod_chk_${ts}`,
    cod_node: `cod_node_${ts}`,
    rev_request: `rev_req_${ts}`,
    rev_positive: `rev_pos_${ts}`,
    rev_negative: `rev_neg_${ts}`,
    b2b_trigger: `b2b_trig_${ts}`,
    b2b_capture: `b2b_cap_${ts}`,
    b2b_tag: `b2b_tag_${ts}`,
    b2b_alert: `b2b_alert_${ts}`,
    b2b_confirm: `b2b_confirm_${ts}`,
    ai_fallback: `ai_fb_${ts}`
  };

  const buildKeywords = () => {
    const base = [
      "hi", "hello", "hey", "helo", "hiii", "start", "menu", "help",
      "bot", "hola", "test", "yo", "sup", "kem cho", "namaste", "pranam",
      "shu che", "su che", "buy", "price", "order", "shop", "offer", "deal",
      "discount", "catalog", "kharidna", "bhav"
    ];
    const business = (client.businessType === "ecommerce")
      ? ["doorbell", "camera", "security", "smart", "home", "wireless", "video"]
      : ["service", "enquiry", "information", "know more"];
    const productKws = enrichedProducts.flatMap((p) => [
      String(p.handle || "").replace(/-/g, " "),
      String(p.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 20)
    ]);
    return [...new Set([...base, ...business, ...productKws])].filter((k) => k && k.length > 1);
  };

  const truncate = (str, max = 24) => {
    const value = String(str || "");
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
  };

  nodes.push(
    {
      id: IDS.trig_main,
      type: "trigger",
      position: { x: 0, y: 0 },
      data: { label: "Main Entry Trigger", triggerType: "keyword", matchMode: "contains", keywords: buildKeywords(), heatmapCount: 0 }
    },
    {
      id: IDS.trig_ad,
      type: "trigger",
      position: { x: 400, y: 0 },
      data: { label: "Meta Ad Click Trigger", triggerType: "meta_ad", keywords: ["ad_click"], heatmapCount: 0 }
    },
    {
      id: IDS.trig_ig,
      type: "trigger",
      position: { x: 800, y: 0 },
      data: { label: "Instagram Mention Trigger", triggerType: "ig_story_mention", keywords: ["story_mention"], heatmapCount: 0 }
    }
  );

  const hasWelcomeTemplate = (client.syncedMetaTemplates || []).some((t) => String(t.name || "").includes("welcome"));
  if (hasWelcomeTemplate) {
    nodes.push({
      id: IDS.welcome_tpl,
      type: "template",
      position: { x: 1200, y: 0 },
      data: { label: "Welcome Template", templateName: (client.syncedMetaTemplates || [])[0]?.name || "welcome_with_logo", imageUrl: client.brand?.logoUrl || "", variables: [], heatmapCount: 0 }
    });
  } else {
    nodes.push({
      id: IDS.welcome_tpl,
      type: "interactive",
      position: { x: 1200, y: 0 },
      data: {
        label: "Welcome Message",
        interactiveType: "button",
        imageUrl: client.brand?.logoUrl || "",
        text: content.welcome_a,
        buttonsList: [{ id: "shop", title: "🛍️ View Products" }, { id: "faq", title: "❓ Setup & FAQ" }, { id: "support", title: "🎧 Talk to Us" }],
        heatmapCount: 0
      }
    });
  }

  nodes.push(
    { id: IDS.ad_welcome, type: "message", position: { x: 400, y: 200 }, data: { label: "Ad Welcome", text: content.ad_welcome, heatmapCount: 0 } },
    { id: IDS.ig_welcome, type: "message", position: { x: 800, y: 200 }, data: { label: "Instagram Welcome", text: content.ig_welcome, heatmapCount: 0 } },
    {
      id: IDS.main_menu,
      type: "interactive",
      position: { x: 1800, y: 0 },
      data: {
        label: "Main Hub Menu",
        interactiveType: "list",
        text: `How can ${botName} help you today? Tap an option below 👇`,
        buttonText: "Open Menu",
        sections: [{
          title: businessName,
          rows: [
            { id: "shop", title: "🛍️ Shop Collection" },
            { id: "track", title: "📦 Track My Order" },
            { id: "returns", title: "🔄 Return / Cancel" },
            { id: "warranty", title: "🛡️ Warranty" },
            { id: "loyalty", title: "💎 My Rewards" },
            { id: "support", title: "🎧 Talk to Human" },
            { id: "faq", title: "❓ FAQs" }
          ]
        }],
        heatmapCount: 0
      }
    }
  );

  edges.push(
    { id: `e_trig_wlc_${ts}`, source: IDS.trig_main, target: IDS.welcome_tpl },
    { id: `e_wlc_menu_${ts}`, source: IDS.welcome_tpl, target: IDS.main_menu },
    { id: `e_ad_adwlc_${ts}`, source: IDS.trig_ad, target: IDS.ad_welcome },
    { id: `e_adwlc_menu_${ts}`, source: IDS.ad_welcome, target: IDS.main_menu },
    { id: `e_ig_igwlc_${ts}`, source: IDS.trig_ig, target: IDS.ig_welcome },
    { id: `e_igwlc_menu_${ts}`, source: IDS.ig_welcome, target: IDS.main_menu },
    { id: `e_menu_shop_${ts}`, source: IDS.main_menu, target: IDS.cat_list, sourceHandle: "shop" },
    { id: `e_menu_track_${ts}`, source: IDS.main_menu, target: IDS.ord_track, sourceHandle: "track" },
    { id: `e_menu_ret_${ts}`, source: IDS.main_menu, target: IDS.ret_hub, sourceHandle: "returns" },
    { id: `e_menu_war_${ts}`, source: IDS.main_menu, target: IDS.war_hub, sourceHandle: "warranty" },
    { id: `e_menu_loy_${ts}`, source: IDS.main_menu, target: IDS.loy_menu, sourceHandle: "loyalty" },
    { id: `e_menu_sup_${ts}`, source: IDS.main_menu, target: IDS.sup_sch, sourceHandle: "support" },
    { id: `e_menu_faq_${ts}`, source: IDS.main_menu, target: IDS.faq_msg, sourceHandle: "faq" }
  );
  if (!hasWelcomeTemplate) {
    edges.push(
      { id: `e_wlc_shop_${ts}`, source: IDS.welcome_tpl, target: IDS.cat_list, sourceHandle: "shop" },
      { id: `e_wlc_faq_${ts}`, source: IDS.welcome_tpl, target: IDS.faq_msg, sourceHandle: "faq" },
      { id: `e_wlc_sup_${ts}`, source: IDS.welcome_tpl, target: IDS.sup_sch, sourceHandle: "support" }
    );
  }

  nodes.push({
    id: IDS.cat_list,
    type: "interactive",
    position: { x: 2400, y: -600 },
    data: {
      label: "Product Catalog",
      interactiveType: "list",
      text: `Ready to explore ${businessName} products? Pick one below 👇`,
      buttonText: "View Products",
      sections: [{ title: `${businessName} Products`, rows: enrichedProducts.map((p, i) => ({ id: `p_${i}`, title: truncate(p.title, 24), description: `${currency}${parseInt(p.price || 0, 10).toLocaleString("en-IN")}` })) }],
      heatmapCount: 0
    }
  });

  enrichedProducts.forEach((p, i) => {
    const prodId = `prod_${p.id || i}_${ts}`;
  const canonicalTemplateName = `prod_${p.handle}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 50);
  const legacyTemplateName = `${client.clientId}_${p.handle}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 50);
  const hasTemplate = (client.syncedMetaTemplates || []).some(
    (t) => t.productHandle === p.handle || t.name === canonicalTemplateName || t.name === legacyTemplateName
  );
    if (!hasTemplate && wizardData.productMode === "template") {
      wizardData.customTemplates = wizardData.customTemplates || [];
      const templateName = canonicalTemplateName;
      if (!wizardData.customTemplates.find((t) => t.name === templateName)) {
        wizardData.customTemplates.push({
          name: templateName,
          category: "MARKETING",
          language: "en",
          components: [
            { type: "HEADER", format: "IMAGE", _imageUrl: p.imageUrl || "" },
            { type: "BODY", text: `Product: *{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n{{3}}` },
            { type: "BUTTONS", buttons: [{ type: "URL", text: "Order Now", url: `${storeUrl}/products/${p.handle}` }, { type: "QUICK_REPLY", text: "Talk to Agent" }] }
          ]
        });
      }
    }

    nodes.push({
      id: prodId,
      type: hasTemplate ? "template" : "interactive",
      position: { x: 2900, y: (i * 220) - (enrichedProducts.length * 100) },
      data: hasTemplate ? {
        label: truncate(`Product: ${p.title}`, 30),
        templateName: canonicalTemplateName,
        imageUrl: p.imageUrl || "",
        shopifyProductId: p.id,
        shopifyProductUrl: `${storeUrl}/products/${p.handle}`,
        buttonsList: [{ id: "buy", title: "Buy" }, { id: "agent", title: "Talk to Agent" }, { id: "menu", title: "Main Menu" }],
        variables: ["customer_name", "product_price", "warranty"],
        heatmapCount: 0
      } : {
        label: truncate(`Product: ${p.title}`, 30),
        interactiveType: "button",
        imageUrl: p.imageUrl || "",
        text: `*${p.title}*\n\n💰 Price: ${currency}${parseInt(p.price || 0, 10).toLocaleString("en-IN")}\n✅ 1 Year Warranty | 🚚 Free Shipping`,
        buttonsList: [{ id: "buy", title: "🛒 Buy Now" }, { id: "agent", title: "📞 Talk to Agent" }, { id: "menu", title: "⬅️ Main Menu" }],
        shopifyProductId: p.id,
        shopifyProductUrl: `${storeUrl}/products/${p.handle}`,
        heatmapCount: 0
      }
    });
    edges.push({ id: `e_cat_p${i}_${ts}`, source: IDS.cat_list, target: prodId, sourceHandle: `p_${i}` });
    if (!hasTemplate) {
      edges.push(
        { id: `e_p${i}_buy_${ts}`, source: prodId, target: IDS.ai_fallback, sourceHandle: "buy" },
        { id: `e_p${i}_agent_${ts}`, source: prodId, target: IDS.sup_sch, sourceHandle: "agent" },
        { id: `e_p${i}_menu_${ts}`, source: prodId, target: IDS.main_menu, sourceHandle: "menu" }
      );
    } else {
      edges.push(
        { id: `e_pt${i}_buy_${ts}`, source: prodId, target: IDS.ai_fallback, sourceHandle: "buy" },
        { id: `e_pt${i}_buy2_${ts}`, source: prodId, target: IDS.ai_fallback, sourceHandle: "buy_now" },
        { id: `e_pt${i}_agent_${ts}`, source: prodId, target: IDS.sup_sch, sourceHandle: "agent" },
        { id: `e_pt${i}_agent2_${ts}`, source: prodId, target: IDS.sup_sch, sourceHandle: "talk_to_agent" },
        { id: `e_pt${i}_menu_${ts}`, source: prodId, target: IDS.main_menu, sourceHandle: "menu" }
      );
    }
  });

  nodes.push(
    { id: IDS.ord_track, type: "shopify_call", position: { x: 2400, y: 200 }, data: { label: "Check Order Status", action: "CHECK_ORDER_STATUS", heatmapCount: 0 } },
    { id: IDS.ord_hub, type: "interactive", position: { x: 2400, y: 380 }, data: { label: "Order Management", interactiveType: "button", text: "What would you like to do with your order?", buttonsList: [{ id: "cancel", title: "❌ Cancel Order" }, { id: "status", title: "📦 Track Status" }, { id: "menu", title: "⬅️ Main Menu" }], heatmapCount: 0 } },
    { id: IDS.can_confirm, type: "interactive", position: { x: 2900, y: 380 }, data: { label: "Confirm Cancellation", interactiveType: "button", text: content.cancellation_confirm, buttonsList: [{ id: "yes", title: "✅ Yes, Cancel It" }, { id: "no", title: "❌ Keep My Order" }], heatmapCount: 0 } },
    { id: IDS.can_logic, type: "logic", position: { x: 3400, y: 380 }, data: { label: "Is Order Shipped?", variable: "is_shipped", operator: "eq", value: "true", heatmapCount: 0 } },
    { id: IDS.can_shipped, type: "message", position: { x: 3900, y: 560 }, data: { label: "Already Shipped Error", text: content.in_transit_error, heatmapCount: 0 } },
    { id: IDS.can_reason, type: "capture_input", position: { x: 3900, y: 280 }, data: { label: "Cancellation Reason", variable: "cancel_reason", question: "Please tell us why you're cancelling.", heatmapCount: 0 } },
    { id: IDS.can_action, type: "shopify_call", position: { x: 4400, y: 280 }, data: { label: "Process Cancellation", action: "CANCEL_ORDER", heatmapCount: 0 } },
    { id: IDS.ret_hub, type: "interactive", position: { x: 2400, y: 700 }, data: { label: "Returns Hub", interactiveType: "button", text: "How can we help with returns?", buttonsList: [{ id: "return", title: "📸 Start Return" }, { id: "refund", title: "💸 Refund Status" }, { id: "menu", title: "⬅️ Main Menu" }], heatmapCount: 0 } },
    { id: IDS.ret_reason, type: "capture_input", position: { x: 2900, y: 650 }, data: { label: "Return Reason", variable: "return_reason", question: "Please share return reason.", heatmapCount: 0 } },
    { id: IDS.ret_photo, type: "capture_input", position: { x: 3400, y: 650 }, data: { label: "Return Photo", variable: "return_photo", question: content.return_photo_prompt, heatmapCount: 0 } },
    { id: IDS.ret_confirm, type: "message", position: { x: 3900, y: 650 }, data: { label: "Return Confirmed", text: "✅ Return request received. Our team will update you in 24-48 hours.", heatmapCount: 0 } },
    { id: IDS.ref_check, type: "shopify_call", position: { x: 2900, y: 850 }, data: { label: "Refund Status", action: "ORDER_REFUND_STATUS", heatmapCount: 0 } },
    { id: IDS.ref_result, type: "message", position: { x: 3400, y: 850 }, data: { label: "Refund Result", text: "Refunds are processed in 5-7 business days.", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_ord_hub_can_${ts}`, source: IDS.ord_hub, target: IDS.can_confirm, sourceHandle: "cancel" },
    { id: `e_ord_hub_track_${ts}`, source: IDS.ord_hub, target: IDS.ord_track, sourceHandle: "status" },
    { id: `e_ord_hub_menu_${ts}`, source: IDS.ord_hub, target: IDS.main_menu, sourceHandle: "menu" },
    { id: `e_can_yes_${ts}`, source: IDS.can_confirm, target: IDS.can_logic, sourceHandle: "yes" },
    { id: `e_can_no_${ts}`, source: IDS.can_confirm, target: IDS.main_menu, sourceHandle: "no" },
    { id: `e_can_true_${ts}`, source: IDS.can_logic, target: IDS.can_shipped, sourceHandle: "true" },
    { id: `e_can_false_${ts}`, source: IDS.can_logic, target: IDS.can_reason, sourceHandle: "false" },
    { id: `e_can_action_${ts}`, source: IDS.can_reason, target: IDS.can_action },
    { id: `e_ret_hub_ret_${ts}`, source: IDS.ret_hub, target: IDS.ret_reason, sourceHandle: "return" },
    { id: `e_ret_hub_ref_${ts}`, source: IDS.ret_hub, target: IDS.ref_check, sourceHandle: "refund" },
    { id: `e_ret_hub_menu_${ts}`, source: IDS.ret_hub, target: IDS.main_menu, sourceHandle: "menu" },
    { id: `e_ret_reason_${ts}`, source: IDS.ret_reason, target: IDS.ret_photo },
    { id: `e_ret_photo_${ts}`, source: IDS.ret_photo, target: IDS.ret_confirm },
    { id: `e_ref_chk_${ts}`, source: IDS.ref_check, target: IDS.ref_result }
  );

  nodes.push(
    { id: IDS.war_hub, type: "interactive", position: { x: 2400, y: 1200 }, data: { label: "Warranty Hub", interactiveType: "button", text: "Warranty support options:", buttonsList: [{ id: "reg", title: "✅ Register" }, { id: "check", title: "🔍 Check Status" }, { id: "menu", title: "⬅️ Main Menu" }], heatmapCount: 0 } },
    { id: IDS.war_serial, type: "capture_input", position: { x: 2900, y: 1100 }, data: { label: "Warranty Serial", variable: "warranty_serial", question: "Enter serial number or order id.", heatmapCount: 0 } },
    { id: IDS.war_date, type: "capture_input", position: { x: 3400, y: 1100 }, data: { label: "Purchase Date", variable: "purchase_date", question: "Enter purchase date (DD/MM/YYYY).", heatmapCount: 0 } },
    { id: IDS.war_tag, type: "tag_lead", position: { x: 3900, y: 1100 }, data: { label: "Warranty Tag", action: "add", tag: "warranty-enrolled", heatmapCount: 0 } },
    { id: IDS.war_success, type: "message", position: { x: 4400, y: 1100 }, data: { label: "Warranty Success", text: content.warranty_reg_success, heatmapCount: 0 } },
    { id: IDS.war_lookup, type: "capture_input", position: { x: 2900, y: 1300 }, data: { label: "Lookup Serial", variable: "lookup_serial", question: content.warranty_lookup_prompt, heatmapCount: 0 } },
    { id: IDS.war_engine, type: "warranty_check", position: { x: 3400, y: 1300 }, data: { label: "Warranty Check", action: "WARRANTY_CHECK", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_war_reg_${ts}`, source: IDS.war_hub, target: IDS.war_serial, sourceHandle: "reg" },
    { id: `e_war_chk_${ts}`, source: IDS.war_hub, target: IDS.war_lookup, sourceHandle: "check" },
    { id: `e_war_menu_${ts}`, source: IDS.war_hub, target: IDS.main_menu, sourceHandle: "menu" },
    { id: `e_war_ser_${ts}`, source: IDS.war_serial, target: IDS.war_date },
    { id: `e_war_date_${ts}`, source: IDS.war_date, target: IDS.war_tag },
    { id: `e_war_tag_${ts}`, source: IDS.war_tag, target: IDS.war_success },
    { id: `e_war_lookup_${ts}`, source: IDS.war_lookup, target: IDS.war_engine }
  );

  nodes.push(
    { id: IDS.loy_menu, type: "interactive", position: { x: 2400, y: 1600 }, data: { label: "Rewards Hub", interactiveType: "list", text: content.loyalty_welcome, buttonText: "My Rewards", sections: [{ title: "Loyalty", rows: [{ id: "pts", title: "💎 My Points" }, { id: "red", title: "🎁 Redeem" }, { id: "ref", title: "📢 Refer & Earn" }, { id: "menu", title: "⬅️ Main Menu" }] }], heatmapCount: 0 } },
    { id: IDS.loy_balance, type: "message", position: { x: 2900, y: 1500 }, data: { label: "Points Balance", text: content.loyalty_points_msg, heatmapCount: 0 } },
    { id: IDS.loy_redeem, type: "loyalty_action", position: { x: 2900, y: 1650 }, data: { label: "Redeem Loyalty", actionType: "REDEEM_POINTS", pointsRequired: 100, heatmapCount: 0 } },
    { id: IDS.loy_refer, type: "message", position: { x: 2900, y: 1800 }, data: { label: "Refer", text: content.referral_msg, heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_loy_pts_${ts}`, source: IDS.loy_menu, target: IDS.loy_balance, sourceHandle: "pts" },
    { id: `e_loy_red_${ts}`, source: IDS.loy_menu, target: IDS.loy_redeem, sourceHandle: "red" },
    { id: `e_loy_ref_${ts}`, source: IDS.loy_menu, target: IDS.loy_refer, sourceHandle: "ref" },
    { id: `e_loy_menu_${ts}`, source: IDS.loy_menu, target: IDS.main_menu, sourceHandle: "menu" }
  );

  nodes.push(
    { id: IDS.sup_sch, type: "schedule", position: { x: 2400, y: 2050 }, data: { label: "Business Hours Gate", openTime, closeTime, days: workingDays, closedMessage: `Our agents are offline right now. We're open ${openTime}-${closeTime}.`, heatmapCount: 0 } },
    { id: IDS.sup_capture, type: "capture_input", position: { x: 2900, y: 1950 }, data: { label: "Support Query", variable: "support_query", question: "Please describe your issue and our team will help right away.", heatmapCount: 0 } },
    { id: IDS.sup_tag, type: "tag_lead", position: { x: 3400, y: 1950 }, data: { label: "Tag Pending Human", action: "add", tag: "pending-human", heatmapCount: 0 } },
    { id: IDS.sup_alert, type: "admin_alert", position: { x: 3900, y: 1950 }, data: { label: "Admin Alert", priority: "high", topic: `Human request - ${businessName}`, phone: adminPhone || client.adminPhone || "", heatmapCount: 0 } },
    { id: IDS.sup_confirm, type: "message", position: { x: 4400, y: 1950 }, data: { label: "Handoff Confirmed", text: content.agent_handoff_msg, heatmapCount: 0 } },
    { id: IDS.sup_closed, type: "message", position: { x: 2900, y: 2150 }, data: { label: "After Hours", text: content.support_hours_msg, heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_sup_open_${ts}`, source: IDS.sup_sch, target: IDS.sup_capture, sourceHandle: "open" },
    { id: `e_sup_closed_${ts}`, source: IDS.sup_sch, target: IDS.sup_closed, sourceHandle: "closed" },
    { id: `e_sup_tag_${ts}`, source: IDS.sup_capture, target: IDS.sup_tag },
    { id: `e_sup_alert_${ts}`, source: IDS.sup_tag, target: IDS.sup_alert },
    { id: `e_sup_conf_${ts}`, source: IDS.sup_alert, target: IDS.sup_confirm }
  );

  nodes.push(
    { id: IDS.faq_msg, type: "message", position: { x: 2400, y: 2450 }, data: { label: "General FAQ", text: faqText || content.faq_response, heatmapCount: 0 } },
    { id: IDS.trig_order, type: "trigger", position: { x: -800, y: 0 }, data: { label: "Order Placed Trigger", triggerType: "order_placed", heatmapCount: 0 } },
    { id: IDS.conf_msg, type: "message", position: { x: -400, y: 0 }, data: { label: "Order Confirmed", text: content.order_confirmed_msg, heatmapCount: 0 } },
    { id: IDS.cod_check, type: "logic", position: { x: 0, y: -200 }, data: { label: "Is COD?", variable: "payment_method", operator: "contains", value: "cod", heatmapCount: 0 } },
    { id: IDS.cod_node, type: "cod_prepaid", position: { x: 400, y: -300 }, data: { label: "COD Nudge", action: "CONVERT_COD_TO_PREPAID", discountAmount: wizardData.codDiscount || 50, text: content.cod_nudge, heatmapCount: 0 } },
    { id: IDS.trig_cart, type: "trigger", position: { x: -800, y: 400 }, data: { label: "Abandoned Cart Trigger", triggerType: "abandoned_cart", heatmapCount: 0 } },
    { id: IDS.trig_fulfill, type: "trigger", position: { x: -800, y: 1000 }, data: { label: "Order Fulfilled Trigger", triggerType: "order_fulfilled", heatmapCount: 0 } },
    { id: IDS.rev_request, type: "review", position: { x: -400, y: 1000 }, data: { label: "Review Request", action: "SEND_REVIEW_REQUEST", text: content.sentiment_ask, googleReviewUrl, heatmapCount: 0 } },
    { id: IDS.rev_positive, type: "message", position: { x: 100, y: 900 }, data: { label: "Positive", text: content.review_positive + (googleReviewUrl ? `\n${googleReviewUrl}` : ""), heatmapCount: 0 } },
    { id: IDS.rev_negative, type: "message", position: { x: 100, y: 1100 }, data: { label: "Negative", text: content.review_negative, heatmapCount: 0 } },
    { id: IDS.ai_fallback, type: "message", position: { x: 0, y: -600 }, data: { label: "🤖 AI Smart Reply", action: "AI_FALLBACK", text: fallbackMessage || "", heatmapCount: 0 } }
  );
  edges.push(
    { id: `e_faq_menu_${ts}`, source: IDS.faq_msg, target: IDS.main_menu },
    { id: `e_track_ordhub_${ts}`, source: IDS.ord_track, target: IDS.ord_hub },
    { id: `e_ord_trig_${ts}`, source: IDS.trig_order, target: IDS.conf_msg },
    { id: `e_ord_conf_${ts}`, source: IDS.conf_msg, target: IDS.cod_check },
    { id: `e_cod_true_${ts}`, source: IDS.cod_check, target: IDS.cod_node, sourceHandle: "true" },
    { id: `e_ful_rev_${ts}`, source: IDS.trig_fulfill, target: IDS.rev_request },
    { id: `e_rev_pos_${ts}`, source: IDS.rev_request, target: IDS.rev_positive, sourceHandle: "positive" },
    { id: `e_rev_neg_${ts}`, source: IDS.rev_request, target: IDS.rev_negative, sourceHandle: "negative" }
  );

  if (returnsInfo) {
    nodes.push({
      id: `returns_policy_${ts}`,
      type: "message",
      position: { x: 2900, y: 2500 },
      data: { label: "Return Policy", text: returnsInfo, heatmapCount: 0 }
    });
    edges.push({ id: `e_returns_policy_${ts}`, source: IDS.ret_confirm, target: `returns_policy_${ts}` });
  }

  if (b2bEnabled) {
    nodes.push(
      { id: IDS.b2b_trigger, type: "trigger", position: { x: -600, y: 1500 }, data: { label: "B2B Trigger", triggerType: "keyword", keywords: ["wholesale", "bulk", "b2b", "dealer", "distributor"], matchMode: "contains", heatmapCount: 0 } },
      { id: IDS.b2b_capture, type: "capture_input", position: { x: -200, y: 1500 }, data: { label: "B2B Requirement", variable: "b2b_requirement", question: "Please share company name and monthly requirement.", heatmapCount: 0 } },
      { id: IDS.b2b_tag, type: "tag_lead", position: { x: 200, y: 1500 }, data: { label: "Tag B2B", action: "add", tag: "b2b-prospect", heatmapCount: 0 } },
      { id: IDS.b2b_alert, type: "admin_alert", position: { x: 600, y: 1500 }, data: { label: "B2B Alert", priority: "high", topic: `B2B Lead - ${businessName}`, phone: adminPhone || client.adminPhone || "", heatmapCount: 0 } },
      { id: IDS.b2b_confirm, type: "message", position: { x: 1000, y: 1500 }, data: { label: "B2B Confirm", text: "Our wholesale team will contact you soon with pricing.", heatmapCount: 0 } }
    );
    edges.push(
      { id: `e_b2b_1_${ts}`, source: IDS.b2b_trigger, target: IDS.b2b_capture },
      { id: `e_b2b_2_${ts}`, source: IDS.b2b_capture, target: IDS.b2b_tag },
      { id: `e_b2b_3_${ts}`, source: IDS.b2b_tag, target: IDS.b2b_alert },
      { id: `e_b2b_4_${ts}`, source: IDS.b2b_alert, target: IDS.b2b_confirm }
    );
  }

  const cartSteps = [
    { delay: cartTiming.msg1 || 15, unit: "minutes", text: content.cart_recovery_1 },
    { delay: cartTiming.msg2 || 2, unit: "hours", text: content.cart_recovery_2 },
    { delay: cartTiming.msg3 || 24, unit: "hours", text: content.cart_recovery_3 }
  ];
  let prevId = IDS.trig_cart;
  cartSteps.forEach((step, i) => {
    const delayId = `cart_delay_${i}_${ts}`;
    const msgId = `cart_msg_${i}_${ts}`;
    nodes.push(
      { id: delayId, type: "delay", position: { x: -800 + (i * 800), y: 600 }, data: { label: `Wait ${step.delay} ${step.unit}`, waitValue: step.delay, waitUnit: step.unit, heatmapCount: 0 } },
      { id: msgId, type: "message", position: { x: -400 + (i * 800), y: 600 }, data: { label: `Cart Recovery ${i + 1}`, text: step.text, heatmapCount: 0 } }
    );
    edges.push({ id: `e_cart_d${i}_${ts}`, source: prevId, target: delayId }, { id: `e_cart_m${i}_${ts}`, source: delayId, target: msgId });
    prevId = msgId;
  });

  const nodesWithOutgoing = new Set(edges.map((e) => e.source));
  const deadEndTypes = ["message", "shopify_call", "loyalty_action", "tag_lead", "review", "warranty_check", "cod_prepaid", "admin_alert"];
  nodes.forEach((node) => {
    if (deadEndTypes.includes(node.type) && !nodesWithOutgoing.has(node.id) && node.id !== IDS.ai_fallback) {
      edges.push({
        id: `e_fallback_${node.id}_${ts}`,
        source: node.id,
        target: IDS.ai_fallback,
        animated: false,
        style: { strokeDasharray: "4 4", stroke: "#6366f1", opacity: 0.4 }
      });
    }
  });

  verifyAllEdgesMatchButtonIds(nodes, edges);
  if (!verifyFlowIntegrity(nodes, edges)) {
    throw new Error("Flow integrity validation failed");
  }

  const connected = new Set([...edges.map((e) => e.source), ...edges.map((e) => e.target)]);
  const cleanNodes = nodes.filter((n) => connected.has(n.id) || n.type === "trigger" || n.id === IDS.ai_fallback);
  const cleanEdges = edges.filter((e) => connected.has(e.source) && connected.has(e.target));
  const finalNodes = cleanNodeText(cleanNodes);
  return { nodes: finalNodes, edges: cleanEdges };
}

// ─── SYSTEM PROMPT GENERATOR (used by wizard) ────────────────────────────────
async function generateSystemPrompt(client, wizardData) {
  const { businessName, businessDescription, botName, tone, botLanguage, products = [], shippingTime } = wizardData;
  const { generateText } = require("./gemini");
  const prompt = `Write a professional WhatsApp chatbot system prompt for ${businessName}.
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${tone}
Language: ${botLanguage}
Shipping Policy: ${shippingTime || "Standard shipping"}
Products: ${products.slice(0, 5).map(p => p.name || p.title).join(", ")}`;
  try {
    const res = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    return res || `Default prompt for ${businessName}`;
  } catch (_) {
    return `Default system prompt for ${businessName}`;
  }
}

// ─── PRE-BUILT META TEMPLATE DEFINITIONS ─────────────────────────────────────
function getPrebuiltTemplates(wizardData) {
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

  // ── ALL PRODUCT TEMPLATES ─────────────────────────────────────────────────
  // Each product gets its own Meta-compliant template with:
  //   • HEADER: IMAGE (product photo from Shopify)
  //   • BODY:   name / price / feature excerpt
  //   • FOOTER: brand name
  //   • BUTTONS: URL "Buy Now" → direct product page + QUICK_REPLY "Main Menu"
  const { buildProductContext } = module.exports;
  const allProducts = products.map((p, i) => buildProductContext(p, i));

  const productTemplates = allProducts.map((p) => {
    const safeName = `prod_${p.handle.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`.substring(0, 50);
    const buyUrl   = storeBase ? `${storeBase}/products/${p.handle}` : "";

    return {
      id:          safeName,
      name:        safeName,
      category:    "MARKETING",
      language:    "en",
      status:      "not_submitted",
      description: `Rich product card for "${p.title}" — IMAGE header + buy button.`,
      required:    false,
      components: [
        {
          type:      "HEADER",
          format:    "IMAGE",
          // _imageUrl is consumed by the backend upload step before Graph API submission
          _imageUrl: p.imageUrl || "",
        },
        {
          type: "BODY",
          text: `Product: *{{1}}*\n\n\uD83D\uDCB0 Price: ${currency}{{2}}\n\n*Key Features:*\n{{3}}\n\nClick below to view more details!`,
        },
        {
          type: "FOOTER",
          text: brandSafe,
        },
        {
          type: "BUTTONS",
          buttons: [
            ...(buyUrl
              ? [{ type: "URL", text: "\uD83D\uDED2 Buy Now", url: buyUrl }]
              : [{ type: "QUICK_REPLY", text: "\uD83D\uDED2 Buy Now" }]
            ),
            { type: "QUICK_REPLY", text: "\u2B05\uFE0F Main Menu" },
          ],
        },
      ],
      // Flat fields used by the wizard preview bubble renderer
      body:      `Product: *{{1}}*\n\n\uD83D\uDCB0 Price: ${currency}{{2}}\n\n*Key Features:*\n{{3}}\n\nClick below to view more details!`,
      variables: ["product_name", "product_price", "product_features"],
    };
  });

  return [
    // =========================================================================
    // 1. WELCOME WITH LOGO  (MARKETING — first-contact branded message)
    //    The business logo appears as the IMAGE header so customers immediately
    //    recognise the brand. Quick-reply buttons route into the main menu hub.
    // =========================================================================
    {
      id:          "welcome_with_logo",
      name:        "welcome_with_logo",
      category:    "MARKETING",
      language:    "en",
      status:      "not_submitted",
      description: "Branded welcome — IMAGE header (your logo) + quick-reply main menu.",
      required:    true,
      components: [
        {
          type:      "HEADER",
          format:    "IMAGE",
          _imageUrl: businessLogo || "",   // backend uploads before Graph API call
        },
        {
          type: "BODY",
          text: `Welcome to *{{1}}*! \uD83D\uDC4B How can we help you today?`,
        },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Shop" },
            { type: "QUICK_REPLY", text: "Support" },
            { type: "QUICK_REPLY", text: "Track Order" },
          ],
        },
      ],
      body:      `Welcome to *{{1}}*! \uD83D\uDC4B How can we help you today?`,
      variables: ["business_name"],
    },

    // =========================================================================
    // 2. PER-PRODUCT RICH TEMPLATES  (top 3 Shopify products)
    // =========================================================================
    ...productTemplates,

    // =========================================================================
    // 3. ORDER CONFIRMATION  (UTILITY — fastest approval path)
    // =========================================================================
    {
      id:          "order_conf",
      name:        "order_conf",
      category:    "UTILITY",
      language:    "en",
      status:      "not_submitted",
      description: "Sent immediately after order is placed.",
      required:    true,
      components: [
        {
          type: "BODY",
          text: `\u2705 Your order #{{1}} from ${brandSafe} is confirmed!\n\nItems: {{2}} | Total: ${currency}{{3}}\n\nWe\u2019ll notify you when it ships! \uD83D\uDCE6`,
        },
      ],
      body:      `\u2705 Your order #{{1}} from ${brandSafe} is confirmed!\n\nItems: {{2}} | Total: ${currency}{{3}}\n\nWe\u2019ll notify you when it ships! \uD83D\uDCE6`,
      variables: ["order_id", "cart_items", "order_total"],
    },

    // =========================================================================
    // 4. CART RECOVERY  (MARKETING — 3-step drip trigger)
    // =========================================================================
    {
      id:          "cart_recovery",
      name:        "cart_recovery",
      category:    "MARKETING",
      language:    "en",
      status:      "not_submitted",
      description: "Sent if checkout is started but not completed.",
      required:    true,
      components: [
        {
          type: "BODY",
          text: `Hi! \uD83D\uDC4B You left items in your cart at ${brandSafe}. Still interested?\n\nItems are selling fast! Complete your purchase here:\n{{1}}\n\nSee you soon!`,
        },
        ...(storeBase
          ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Complete Purchase", url: `${storeBase}/cart` }] }]
          : []),
      ],
      body:      `Hi! \uD83D\uDC4B You left items in your cart at ${brandSafe}. Still interested?\n\nItems are selling fast! Complete your purchase here:\n{{1}}\n\nSee you soon!`,
      variables: ["checkout_url"],
    },

    // =========================================================================
    // 5. ADMIN HUMAN ALERT  (UTILITY — ⚠️ MUST BE A TEMPLATE)
    //
    //    Admins typically receive this notification AFTER the 24-hour customer
    //    service window has closed. Meta BLOCKS plain WhatsApp messages to users
    //    you haven\u2019t heard from in 24 hrs. Only pre-approved HSM (Highly Structured
    //    Message) templates bypass this restriction.
    //
    //    Therefore this template is MANDATORY for reliable admin delivery.
    //    The admin_alert nodes in the flow reference templateName: "admin_human_alert"
    //    so the engine sends the template (not a raw message) when firing an alert.
    // =========================================================================
    {
      id:          "admin_handoff",
      name:        "admin_human_alert",
      category:    "UTILITY",
      language:    "en",
      status:      "not_submitted",
      description: "\uD83D\uDEA8 CRITICAL \u2014 sent to admin when customer requests human help. MUST be an approved template (24-hr window bypass).",
      required:    true,
      components: [
        {
          type: "BODY",
          text: `\uD83D\uDEA8 *Human Agent Requested!*\n\nCustomer: {{1}}\nPhone: {{2}}\nContext: {{3}}\n\nPlease reply in the dashboard immediately.`,
        },
      ],
      body:      `\uD83D\uDEA8 *Human Agent Requested!*\n\nCustomer: {{1}}\nPhone: {{2}}\nContext: {{3}}\n\nPlease reply in the dashboard immediately.`,
      variables: ["customer_name", "customer_phone", "last_message"],
    },

    // =========================================================================
    // 6. COD \u2192 PREPAID NUDGE  (MARKETING)
    // =========================================================================
    {
      id:          "cod_nudge",
      name:        "cod_to_prepaid_nudge",
      category:    "MARKETING",
      language:    "en",
      status:      "not_submitted",
      description: "Sent 3 minutes after a COD order to convert to prepaid.",
      required:    true,
      components: [
        {
          type: "BODY",
          text: `Wait! \uD83D\uDCB3 Save an extra ${currency}50 on your ${brandSafe} order by paying online now!\n\nTap below to switch to prepaid and save instantly:`,
        },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: `Pay Online and Save ${currency}50` }],
        },
      ],
      body:      `Wait! \uD83D\uDCB3 Save an extra ${currency}50 on your ${brandSafe} order by paying online now!\n\nTap below to switch to prepaid and save instantly:`,
      variables: [],
    },

    // =========================================================================
    // 7. GOOGLE REVIEW REQUEST  (MARKETING — conditional on googleReviewUrl)
    // =========================================================================
    ...(googleReviewUrl
      ? [
          {
            id:          "review_request",
            name:        "post_delivery_review",
            category:    "MARKETING",
            language:    "en",
            status:      "not_submitted",
            description: "Sent 3\u20134 days after delivery fulfilled.",
            required:    false,
            components: [
              {
                type: "BODY",
                text: `Hi {{1}}! How was your experience with ${brandSafe}? \uD83D\uDE0A\n\nLeave us a quick review \u2014 it means a lot!`,
              },
              {
                type: "BUTTONS",
                buttons: [{ type: "URL", text: "Leave a Review", url: googleReviewUrl }],
              },
            ],
            body:      `Hi {{1}}! How was your experience with ${brandSafe}? \uD83D\uDE0A\n\nLeave us a quick review \u2014 it means a lot!`,
            variables: ["customer_name"],
          },
        ]
      : []),
  ];
}
// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  generateEcommerceFlow,
  generateSystemPrompt,
  getPrebuiltTemplates,
  verifyFlowIntegrity,
  buildProductContext,
  stripPlaceholders,
};
