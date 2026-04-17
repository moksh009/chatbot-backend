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
    if (node.type !== 'interactive') return;

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
    welcome_a:            `👋 Welcome to *${businessName}*! I'm ${botName}, your personal shopping assistant. How can I help you today?`,
    welcome_b:            `🛍️ Hey there! Amazing deals are waiting at *${businessName}*! Let me help you find what you're looking for.`,
    product_menu_text:    `Explore everything *${businessName}* has to offer! Choose an option to get started:`,
    order_status_msg:     `📦 Your order is on its way! Expected delivery: 3–5 business days. Stay tuned for tracking updates!`,
    fallback_msg:         `I'm still learning! 😊 Let me connect you with a human expert who can help right away.`,
    returns_policy_short: `Easy 7-day returns on all unused products. Just send us a photo and we'll handle the rest! 🔄`,
    refund_policy_short:  `Refunds are processed within 5–7 business days after we receive your return. 💳`,
    cancellation_confirm: `Are you sure you want to cancel this order? This action cannot be undone.`,
    cancellation_success: `Your cancellation has been processed. We hope to serve you better next time! 💙`,
    loyalty_welcome:      `🎉 Welcome to *${businessName}* Rewards! You've earned *${signupPoints} points* just for joining. Keep shopping to unlock amazing perks!`,
    loyalty_points_msg:   `💎 You have points in your loyalty wallet! Redeem them for a discount on your next order.`,
    referral_msg:         `Invite your friends to *${businessName}* and earn *${referralPoints} bonus points* when they place their first order! 🎁`,
    sentiment_ask:        `How was your experience with *${businessName}*? Your feedback helps us improve! 😊`,
    review_positive:      `That's wonderful to hear! 🌟 Would you mind sharing it on Google? It only takes 30 seconds!`,
    review_negative:      `We're really sorry to hear that. 😔 Our specialist will reach out within 2 hours to make it right.`,
    upsell_intro:         `Since you love this product, you might also enjoy these popular picks from our collection! 👇`,
    cross_sell_msg:       `Customers who bought this also loved these items. Want to check them out?`,
    cart_recovery_1:      `👋 Hey! You left something in your cart at *${businessName}*. It's still waiting for you — shall I hold it?`,
    cart_recovery_2:      `⏰ Your *${businessName}* cart is still active! These items are selling fast — grab yours before they're gone!`,
    cart_recovery_3:      `🔥 Last chance! Your *${businessName}* cart expires soon. Use code *SAVE10* for an extra 10% off!`,
    cod_nudge:            `💳 Switch to online payment and save ${currency}50 instantly! Faster delivery, safer transaction, simpler process.`,
    order_confirmed_msg:  `🎉 Order confirmed! Your *${businessName}* order is being prepared with care. We'll notify you the moment it ships!`,
    agent_handoff_msg:    `I've notified our team and they'll be with you very shortly. Please stay on this chat. 🎧`,
    faq_response:         `Great question! Here's what I know. For more help, type *menu* to return to the main menu.`,
    ad_welcome:           `Thanks for clicking our ad! 👋 Welcome to *${businessName}* — I'm here to help you find the perfect product.`,
    ig_welcome:           `Hey! 📸 Thanks for the Instagram mention — we really appreciate it! What can I help you with today?`,
    b2b_welcome:          `Welcome to *${businessName}* Wholesale! 🤝 Let's get you set up with the best bulk pricing for your business.`,
    b2b_capture_prompt:   `What's your company name and what monthly volume are you looking for? (Minimum order quantities apply)`,
    warranty_welcome:     `🛡️ All *${businessName}* products come with a *${warrantyDuration}* warranty. Register below to activate yours and get priority support!`,
    warranty_lookup_prompt: `Please enter your Product Serial Number or Order ID to check your warranty status.`,
    payment_request_body: `Complete your payment securely. All transactions are 256-bit encrypted and fully safe. 🔒`,
    loyalty_award_reason: `For shopping with *${businessName}*! Keep collecting to unlock amazing tier rewards.`,
    installation_msg:     `Need help with setup? Our team can guide you step-by-step or schedule an expert visit at your convenience. 🛠️`,
    support_hours_msg:    `We're available *${openTime}–${closeTime}*, Mon–Sat. Our AI is here 24/7, and human agents reply within 1 business hour. 📞`,
    vip_perk_msg:         `🌟 You're a VIP! Unlock your exclusive *20% discount* with code *VIP20*. Valid for 48 hours only — don't miss it!`,
    new_member_nudge:     `You're getting so close to VIP status! 🚀 Just a little more shopping and exclusive discounts are all yours.`,
    in_transit_error:     `Oh no! Your order has already been shipped and cannot be cancelled. 🚚 Once it arrives, you can initiate a return.`,
    return_photo_prompt:  `Please upload a clear photo of the damaged/incorrect item. This helps our team resolve your request quickly! 📸`,
    warranty_reg_success: `✅ Warranty registered for *${warrantyDuration}*! We've saved your details. Contact us anytime for priority support.`,
  };
}

// ─── MAIN GENERATOR ──────────────────────────────────────────────────────────
async function generateEcommerceFlow(client, wizardData) {
  const {
    businessName        = "My Business",
    businessDescription = "",
    products            = [],
    botName             = "Assistant",
    tone                = "friendly",
    botLanguage         = "Hinglish",
    cartTiming          = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl     = "",
    adminPhone          = "",
    faqText             = "",
    returnsInfo         = "",
    fallbackMessage     = "I'm still learning! Let me connect you with a human expert. 😊",
    openTime            = "10:00",
    closeTime           = "19:00",
    workingDays         = [1, 2, 3, 4, 5],
    referralPoints      = 500,
    signupPoints        = 100,
    activePersona       = "sidekick",
    b2bEnabled          = false,
    warrantyDuration    = "1 Year",
    warrantyPolicy      = "Standard manufacturer warranty applicable from date of purchase.",
    checkoutUrl         = "",
    b2bThreshold        = 10,
    b2bAdminPhone       = "",
    currency            = "₹",
  } = wizardData;

  // ── Persona mapping ────────────────────────────────────────────────────────
  const personaMap = {
    concierge:  { label: "Elite Concierge",    type: "Luxury/Formal",     tone_markers: "Use 'Sir/Ma'am', extremely polite, high-end vocabulary, boutique hotel feel." },
    hacker:     { label: "Growth Hacker",       type: "Sales/Aggressive",  tone_markers: "FOMO-driven, enthusiastic, use emojis 🚀🔥, fast-paced, direct CTAs." },
    sidekick:   { label: "Friendly Sidekick",   type: "Casual/Friendly",   tone_markers: "Warm, empathetic, uses 'friend/buddy', approachable, uses 😊✨." },
    efficiency: { label: "Efficiency Expert",   type: "Direct/Minimalist", tone_markers: "No fluff, bullet points, ultra-fast, professional but dry, no filler." },
  };
  const selectedPersona = personaMap[activePersona] || personaMap.sidekick;

  // ── Enrich products ────────────────────────────────────────────────────────
  const enrichedProducts = products.slice(0, 15).map((p, i) => buildProductContext(p, i));
  const productsSummary  = enrichedProducts.map(p => `"${p.title}" ${currency}${p.price}: ${p.features.slice(0, 80)}`).join("\n");
  const productHandles   = enrichedProducts.slice(0, 6).map(p => p.handle);

  // ── STEP 1: 38-Key AI Content Generation ──────────────────────────────────
  let content = {};

  const productGuideLines = productHandles.map(h => {
    const p = enrichedProducts.find(ep => ep.handle === h);
    return `"guide_${h}": "[2–3 step setup/usage guide for '${p?.title}'. Concise, persona-aligned, actionable. No generic filler.]"`;
  }).join("\n");

  const aiPrompt = `You are a world-class WhatsApp chatbot UX architect for an Indian e-commerce brand.

BRAND: ${businessName}
DESCRIPTION: ${businessDescription || "E-commerce brand selling quality products"}
BOT NAME: ${botName}
TONE: ${tone}
PERSONA: ${selectedPersona.label} (${selectedPersona.type})
PERSONA GUIDELINES: ${selectedPersona.tone_markers}
LANGUAGE: ${botLanguage}
FAQ DATA: ${faqText ? faqText.slice(0, 400) : "Standard product FAQs"}
RETURNS INFO: ${returnsInfo || "7-day easy returns"}
LOYALTY: Referral=${referralPoints} pts, Signup=${signupPoints} pts
BUSINESS HOURS: ${openTime}–${closeTime}
PRODUCTS:\n${productsSummary || "Various products available"}

Generate a JSON object with EXACTLY these keys. ALL text must match the persona and language above.
Be concise, impactful, and brand-specific. Zero generic placeholders.

REQUIRED KEYS:
"welcome_a": [Warm first greeting — persona-specific, brand name included, max 100 chars]
"welcome_b": [Second variant — different hook — urgency/curiosity/value, max 100 chars]
"product_menu_text": [Menu header text — inviting, persona-styled, max 80 chars]
"order_status_msg": [Order status update — reassuring, delivery ETA]
"fallback_msg": [AI cannot answer — empathetic, offers human help]
"returns_policy_short": [${returnsInfo || "7-day easy returns"} — friendly restatement]
"refund_policy_short": [Refund 5–7 days — reassuring]
"cancellation_confirm": [Confirm cancel intent — double-check phrasing]
"cancellation_success": [Cancel processed — apologetic but positive]
"loyalty_welcome": [Welcome to rewards — exciting, mention ${signupPoints} pts]
"loyalty_points_msg": [Points balance display — motivating, mention redemption value]
"referral_msg": [Referral pitch — mention ${referralPoints} pts reward]
"sentiment_ask": [Post-purchase experience question — warm, curious]
"review_positive": [After positive feedback — appreciate, ask Google review]
"review_negative": [After negative feedback — empathetic, escalate]
"upsell_intro": [Upsell after purchase — soft, helpful]
"cross_sell_msg": [Cross-sell related products — casual]
"cart_recovery_1": [${cartTiming.msg1 || 15}min cart abandon — gentle curiosity hook]
"cart_recovery_2": [${(cartTiming.msg2 || 2)}hr cart abandon — add value/urgency]
"cart_recovery_3": [${cartTiming.msg3 || 24}hr cart abandon — last chance + discount code]
"cod_nudge": [COD to prepaid nudge — save ₹50, simpler delivery, safe]
"order_confirmed_msg": [Order confirmation — celebrate, set delivery expectations]
"agent_handoff_msg": [Escalate to human — reassuring, ETA mention, warm]
"faq_response": [General FAQ answer wrapper — helpful, directs to menu]
"ad_welcome": [Welcome from Meta Ad click — acknowledge ad, warm entry]
"ig_welcome": [Welcome from Instagram mention — casual, IG-specific]
"b2b_welcome": [B2B inquiry welcome — professional, wholesale-focused]
"b2b_capture_prompt": [Ask company + volume for B2B — professional, min ${b2bThreshold} units]
"warranty_welcome": [Warranty hub intro — ${warrantyDuration} coverage, reassuring]
"warranty_lookup_prompt": [Ask serial number for lookup — clear one-line instruction]
"payment_request_body": [Request online payment — secure, benefits]
"loyalty_award_reason": [Points awarded reason — celebratory, brand-specific]
"installation_msg": [Generic setup help — clear, step-by-step]
"support_hours_msg": [Business hours info — ${openTime}–${closeTime}, offline guidance]
"vip_perk_msg": [VIP exclusive perk reveal — exciting, premium feel]
"new_member_nudge": [Push new member toward next tier — motivating, shows progress]
"in_transit_error": [Can't cancel — already shipped — apologetic but helpful]
"return_photo_prompt": [Ask return damage photo — clear instructions]
"warranty_reg_success": [Warranty registration done — ${warrantyDuration} coverage confirmed]
${productGuideLines}

Respond ONLY with valid raw JSON. No markdown code fences. No explanation.`;

  try {
    const parsed = await generateJSON(aiPrompt, client.geminiApiKey || process.env.GEMINI_API_KEY, {
      maxTokens:   4096,
      temperature: 0.2,
      timeout:     45000,
      maxRetries:  2,
    });
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length >= 20) {
      content = parsed;
      console.log(`[FlowGenerator] ✅ AI content generated: ${Object.keys(content).length} keys`);
    } else {
      console.warn("[FlowGenerator] ⚠️  AI returned thin content — using smart defaults.");
    }
  } catch (err) {
    console.warn("[FlowGenerator] ⚠️  AI generation failed:", err.message, "— using smart defaults.");
  }

  // Merge: AI wins on non-empty fields; defaults fill gaps
  content = {
    ...buildDefaultContent(businessName, botName, enrichedProducts, {
      referralPoints, signupPoints, warrantyDuration, openTime, closeTime, checkoutUrl, currency
    }),
    ...content,
  };

  // ── STEP 2: IDs ───────────────────────────────────────────────────────────
  const ts = Date.now();

  const FOLDER_IDS = {
    WELCOME:    `f1_${ts}`,
    CATALOG:    `f2_${ts}`,
    ORDERS:     `f3_${ts}`,
    RETURNS:    `f4_${ts}`,
    SUPPORT:    `f5_${ts}`,
    LOYALTY:    `f6_${ts}`,
    AUTOMATION: `f7_${ts}`,
    POSTPURCH:  `f8_${ts}`,
  };

  const IDS = {
    // ── Folder 1: Welcome & Entry Hub ──────────────────────────────────────
    TRIGGER:       `f1_trig_${ts}`,      // Main keyword trigger
    AD_TRIGGER:    `f1_ad_tr_${ts}`,     // Meta ad trigger
    IG_TRIGGER:    `f1_ig_tr_${ts}`,     // Instagram mention trigger
    WELCOME_MSG:   `f1_welcome_${ts}`,   // Single welcome message (no A/B)
    W_AD:          `f1_wad_${ts}`,       // Ad-specific welcome
    W_IG:          `f1_wig_${ts}`,       // IG-specific welcome
    MENU:          `f1_menu_${ts}`,      // THE Main Hub interactive list

    // ── Folder 2: Product Catalog ──────────────────────────────────────────
    CATALOG:        `f2_cat_${ts}`,
    DETAIL_PREFIX:  `f2_det_${ts}_`,

    // ── Folder 3: Order Operations ─────────────────────────────────────────
    ORDER_STATUS:          `f3_stat_${ts}`,
    ORDER_MSG:             `f3_stat_m_${ts}`,
    CANCEL_START:          `f3_can_${ts}`,
    CANCEL_LOGIC:          `f3_can_log_${ts}`,
    CANCEL_REASON:         `f3_can_rea_${ts}`,
    CANCEL_ALREADY_SHIPPED:`f3_can_shp_${ts}`,
    CANCEL_FINAL:          `f3_can_fin_${ts}`,

    // ── Folder 4: Returns & Refunds ────────────────────────────────────────
    RETURN_HUB:     `f4_hub_${ts}`,
    RETURN_REASON:  `f4_reason_${ts}`,
    RETURN_PHOTO:   `f4_photo_${ts}`,
    RETURN_SUCCESS: `f4_ok_${ts}`,
    REFUND_STATUS:  `f4_ref_s_${ts}`,
    REFUND_FINAL:   `f4_ref_f_${ts}`,

    // ── Folder 5: Support & Escalation ────────────────────────────────────
    SUPPORT_CAPTURE: `f5_cap_${ts}`,
    SUPPORT_TAG:     `f5_tag_${ts}`,
    SUPPORT_ALERT:   `f5_alert_${ts}`,
    SUPPORT_FINAL:   `f5_final_${ts}`,
    SUPPORT_HOURS:   `f5_hrs_${ts}`,
    SCHED_NODE:      `f5_sch_${ts}`,

    // ── Folder 6: Loyalty & Rewards ────────────────────────────────────────
    LOY_MENU:      `f6_menu_${ts}`,
    LOY_POINTS:    `f6_pts_${ts}`,
    LOY_REDEEM:    `f6_red_${ts}`,
    LOY_REFER:     `f6_ref_${ts}`,
    LOY_TIER:      `f6_tier_${ts}`,
    LOY_VIP_PERK:  `f6_vip_${ts}`,
    LOY_NEW_NUDGE: `f6_nudge_${ts}`,
    LOYALTY_AWARD: `f6_awd_${ts}`,

    // ── Folder 7: Smart Automations ────────────────────────────────────────
    CART_TR:   `f7_c_tr_${ts}`,
    CART_D1:   `f7_c_d1_${ts}`,
    CART_M1:   `f7_c_m1_${ts}`,
    CART_D2:   `f7_c_d2_${ts}`,
    CART_M2:   `f7_c_m2_${ts}`,
    CART_D3:   `f7_c_d3_${ts}`,
    CART_M3:   `f7_c_m3_${ts}`,
    CONF_TR:   `f7_conf_tr_${ts}`,
    CONF_MSG:  `f7_conf_m_${ts}`,
    COD_CHECK: `f7_cod_chk_${ts}`,
    COD_NUDGE: `f7_cod_${ts}`,
    REV_TRIG:  `f7_rev_tr_${ts}`,
    REV_ASK:   `f7_rev_ask_${ts}`,
    REV_GOOD:  `f7_rev_g_${ts}`,
    REV_BAD:   `f7_rev_b_${ts}`,

    // ── Folder 8: Post-Purchase Hub ────────────────────────────────────────
    AI_FALLBACK:          `f8_ai_fb_${ts}`,
    FAQ_NODE:             `f8_faq_${ts}`,
    FAQ_MSG:              `f8_faq_msg_${ts}`,    // FAQ answer message (reachable from menu 'faq' row)
    RET_POLICY_NODE:      `f8_ret_p_${ts}`,
    WARRANTY_HUB:         `f8_war_hub_${ts}`,
    WARRANTY_REG_SERIAL:  `f8_war_ser_${ts}`,
    WARRANTY_REG_DATE:    `f8_war_dt_${ts}`,
    WARRANTY_REG_TAG:     `f8_war_tag_${ts}`,
    WARRANTY_REG_SUCCESS: `f8_war_ok_${ts}`,
    WARRANTY_LOOKUP_SER:  `f8_war_ls_${ts}`,
    WARRANTY_LOOKUP_EXEC: `f8_war_le_${ts}`,
    B2B_TRIGGER:          `f8_b2b_tr_${ts}`,
    B2B_FORM:             `f8_b2b_f_${ts}`,
    B2B_VOLUME:           `f8_b2b_v_${ts}`,
    B2B_TAG:              `f8_b2b_tag_${ts}`,
    B2B_ALERT:            `f8_b2b_a_${ts}`,
    B2B_CONFIRM:          `f8_b2b_ok_${ts}`,
  };

  const Y = 140;
  let nodes = [];
  let edges = [];

  // ====================================================================
  // ROOT LEVEL — 8 Folder nodes
  // ====================================================================
  const FOLDER_META = [
    { id: FOLDER_IDS.WELCOME,    label: "Welcome & Entry Hub",    color: "indigo",  icon: "Zap",         pos: { x: 0,    y: 0   } },
    { id: FOLDER_IDS.CATALOG,    label: "Product Catalog",        color: "emerald", icon: "ShoppingBag", pos: { x: 360,  y: 0   } },
    { id: FOLDER_IDS.ORDERS,     label: "Order Operations",       color: "amber",   icon: "Package",     pos: { x: 720,  y: 0   } },
    { id: FOLDER_IDS.RETURNS,    label: "Returns & Refunds",      color: "rose",    icon: "RefreshCcw",  pos: { x: 1080, y: 0   } },
    { id: FOLDER_IDS.SUPPORT,    label: "Support & Escalation",   color: "blue",    icon: "Headset",     pos: { x: 0,    y: 340 } },
    { id: FOLDER_IDS.LOYALTY,    label: "Loyalty & Rewards",      color: "violet",  icon: "Star",        pos: { x: 360,  y: 340 } },
    { id: FOLDER_IDS.AUTOMATION, label: "Smart Automations",      color: "orange",  icon: "Bot",         pos: { x: 720,  y: 340 } },
    { id: FOLDER_IDS.POSTPURCH,  label: "Post-Purchase Hub",      color: "teal",    icon: "ShieldCheck", pos: { x: 1080, y: 340 } },
  ];

  FOLDER_META.forEach(f => {
    nodes.push({
      id:       f.id,
      type:     "folder",
      position: f.pos,
      data:     { label: f.label, color: f.color, icon: f.icon, childCount: 0 },
    });
  });

  // ====================================================================
  // FOLDER 1 — Welcome & Entry Hub
  //
  // THE GOLDEN PATH:
  //   [Trigger] → [Welcome Message] → [Interactive List: Main Hub]
  //                                        ↓ shop     → Folder 2 (Catalog)
  //                                        ↓ track    → Folder 3 (Order Status)
  //                                        ↓ returns  → Folder 4 (Return Hub)
  //                                        ↓ loyalty  → Folder 6 (Loyalty Menu)
  //                                        ↓ support  → Folder 5 (Support)
  //                                        ↓ warranty → Folder 8 (Warranty Hub)
  //
  //   [Meta Ad Trigger]  → [Ad Welcome]  → MENU
  //   [IG Story Trigger] → [IG Welcome]  → MENU
  // ====================================================================

  const baseKeywords        = ["hi", "hello", "hey", "start", "menu", "kem cho", "namaste", "help", "bot", "hola"];
  const indianContextKws    = ["kem che", "shuchu", "jai shree krishna", "namaskaar", "pranam", "kya chal raha hai", "bhai", "yaar"];
  const ecommerceIntentKws  = ["buy", "price", "order", "shop", "purchase", "product", "offer", "deal", "discount", "catalog"];
  const productKeywords     = enrichedProducts.slice(0, 3).map(p => p.title.toLowerCase().split(" ")[0]);
  const brandKeywords       = [businessName.toLowerCase().split(" ")[0]];
  const allKeywords         = [...new Set([
    ...baseKeywords,
    ...indianContextKws,
    ...ecommerceIntentKws,
    ...productKeywords,
    ...brandKeywords,
  ])].filter(k => k.length >= 2);

  // 1A. Entry triggers
  nodes.push(
    {
      id: IDS.TRIGGER,
      type: "trigger",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label:       "Main Entry Trigger",
        triggerType: "keyword",
        keywords:    allKeywords,
        matchMode:   "contains",
      },
    },
    {
      id: IDS.AD_TRIGGER,
      type: "trigger",
      position: { x: 0, y: Y },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label:       "Meta Ad Click Trigger",
        triggerType: "meta_ad",
        keywords:    ["ad_click"],
      },
    },
    {
      id: IDS.IG_TRIGGER,
      type: "trigger",
      position: { x: 0, y: Y * 2 },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label:       "Instagram Mention Trigger",
        triggerType: "ig_story_mention",
        keywords:    ["story_mention"],
      },
    }
  );

  // 1B. Channel-specific welcome messages
  //     When a business logo is configured, use the pre-approved IMAGE template
  //     (welcome_with_logo) so the brand logo appears on first contact.
  //     Falls back gracefully to a plain text message node.
  const welcomeHasLogo = !!(wizardData.businessLogo || wizardData.shopDomain);
  nodes.push(
    {
      id:       IDS.WELCOME_MSG,
      type:     welcomeHasLogo ? "template" : "message",
      position: { x: 420, y: 0 },
      parentId: FOLDER_IDS.WELCOME,
      data: welcomeHasLogo
        ? {
            label:        "Welcome Message (Branded)",
            templateName: "welcome_with_logo",
            variables:    [businessName],
            imageUrl:     wizardData.businessLogo || "",
          }
        : {
            label: "Welcome Message",
            text:  content.welcome_a,
          },
    },
    {
      id: IDS.W_AD,
      type: "message",
      position: { x: 420, y: Y },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label: "Ad Welcome",
        text:  content.ad_welcome,
      },
    },
    {
      id: IDS.W_IG,
      type: "message",
      position: { x: 420, y: Y * 2 },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label: "Instagram Welcome",
        text:  content.ig_welcome,
      },
    }
  );

  // 1C. THE MAIN HUB — Interactive List (Golden Path core)
  //     ══════════════════════════════════════════════════════
  //     ⚠️  ROW IDs HERE MUST EXACTLY MATCH the sourceHandle on
  //         each cross-folder edge below. This is enforced by
  //         verifyAllEdgesMatchButtonIds() at build time.
  //     ══════════════════════════════════════════════════════
  nodes.push({
    id:       IDS.MENU,
    type:     "interactive",
    position: { x: 900, y: Y * 0.5 },
    parentId: FOLDER_IDS.WELCOME,
    data: {
      label:           "Main Hub Menu",
      interactiveType: "list",
      text:            content.product_menu_text,
      buttonText:      "Open Menu",
      sections: [
        {
          title: `${businessName}`,
          rows: [
            { id: "shop",     title: "🛍️ Shop Collection"   },
            { id: "track",    title: "📦 Track My Order"     },
            { id: "returns",  title: "⚙️ Returns & Refunds" },
            { id: "loyalty",  title: "💎 My Rewards"         },
            { id: "support",  title: "🎧 Talk to Human"      },
            { id: "warranty", title: "🛡️ Warranty"          },
            { id: "faq",      title: "❓ FAQ & Help"         },
          ],
        },
      ],
    },
  });

  // 1D. Folder 1 edges — triggers → welcome → menu
  edges.push(
    { id: "f1_tr_wm",    source: IDS.TRIGGER,     target: IDS.WELCOME_MSG },
    { id: "f1_wm_menu",  source: IDS.WELCOME_MSG, target: IDS.MENU        },
    { id: "f1_ad_wad",   source: IDS.AD_TRIGGER,  target: IDS.W_AD        },
    { id: "f1_wad_menu", source: IDS.W_AD,         target: IDS.MENU        },
    { id: "f1_ig_wig",   source: IDS.IG_TRIGGER,  target: IDS.W_IG        },
    { id: "f1_wig_menu", source: IDS.W_IG,         target: IDS.MENU        },
  );

  // 1E. Cross-folder nav edges from MENU
  //     ⚠️ sourceHandle MUST equal the row id declared in 1C above — NO exceptions.
  edges.push(
    { id: "f1_m_shop",     source: IDS.MENU, target: IDS.CATALOG,      sourceHandle: "shop"     },
    { id: "f1_m_track",    source: IDS.MENU, target: IDS.ORDER_STATUS, sourceHandle: "track"    },
    { id: "f1_m_returns",  source: IDS.MENU, target: IDS.RETURN_HUB,  sourceHandle: "returns"  },
    { id: "f1_m_loyalty",  source: IDS.MENU, target: IDS.LOY_MENU,    sourceHandle: "loyalty"  },
    // ⚠️ Support goes through business-hours SCHEDULE gate — NOT directly to capture
    { id: "f1_m_support",  source: IDS.MENU, target: IDS.SCHED_NODE,  sourceHandle: "support"  },
    { id: "f1_m_warranty", source: IDS.MENU, target: IDS.WARRANTY_HUB,sourceHandle: "warranty" },
    { id: "f1_m_faq",      source: IDS.MENU, target: IDS.FAQ_MSG,     sourceHandle: "faq"      },
  );

  // ====================================================================
  // FOLDER 2 — Product Catalog
  //
  // THE GOLDEN PATH (per product):
  //   [CATALOG list] → [Product interactive button]
  //                         ↓ buy   → (checkout/buy intent — no dead end)
  //                         ↓ menu  → MENU (back to hub)
  //                         ↓ guide → Guide message in Folder 8 (if exists)
  // ====================================================================

  if (enrichedProducts.length === 0) {
    // No products → redirect to store URL
    nodes.push({
      id: IDS.CATALOG,
      type: "interactive",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.CATALOG,
      data: {
        label:           "Store Redirect",
        interactiveType: "button",
        text:            `Browse our full collection at ${checkoutUrl || businessName + " online store"}! 🛍️`,
        buttonsList:     [{ id: "menu", title: "⬅️ Main Menu" }],
      },
    });
    edges.push({ id: "f2_red_menu", source: IDS.CATALOG, target: IDS.MENU, sourceHandle: "menu" });
  } else {
    const categories = [...new Set(enrichedProducts.map(p => p.category))];

    if (categories.length > 1) {
      // Multi-category: Catalog → Category list → Product cards
      nodes.push({
        id:       IDS.CATALOG,
        type:     "interactive",
        position: { x: 0, y: 0 },
        parentId: FOLDER_IDS.CATALOG,
        data: {
          label:           "Category Browser",
          interactiveType: "list",
          text:            `Explore our *${businessName}* collection:`,
          buttonText:      "Browse Categories",
          sections: [
            {
              title: "Product Categories",
              rows:  categories.slice(0, 10).map(cat => ({
                id:    `cat_${cat.toLowerCase().replace(/\s+/g, "_")}`,
                title: cat,
              })),
            },
          ],
        },
      });

      categories.forEach((cat, catIdx) => {
        const catNodeId = `f2_cl_${catIdx}_${ts}`;
        const catProds  = enrichedProducts.filter(p => p.category === cat).slice(0, 10);
        const catHandle = `cat_${cat.toLowerCase().replace(/\s+/g, "_")}`;

        nodes.push({
          id:       catNodeId,
          type:     "interactive",
          position: { x: 420, y: catIdx * Y * 1.5 },
          parentId: FOLDER_IDS.CATALOG,
          data: {
            label:           `Category: ${cat}`,
            interactiveType: "list",
            text:            `Our best *${cat}* products:`,
            buttonText:      "View Products",
            sections: [
              {
                title: cat,
                rows:  catProds.map((p, pi) => ({ id: `p_${catIdx}_${pi}`, title: p.title.substring(0, 24) })),
              },
            ],
          },
        });
        edges.push({ id: `f2_c_${catIdx}`, source: IDS.CATALOG, target: catNodeId, sourceHandle: catHandle });

        catProds.forEach((p, pi) => {
          const pId     = `${IDS.DETAIL_PREFIX}${catIdx}_${pi}`;
          const guideId = `f8_guide_${p.handle}_${ts}`;
          const hasGuide = !!content[`guide_${p.handle}`];

          const btns = [
            { id: "buy",  title: "🛒 Buy Now"     },
            { id: "menu", title: "⬅️ Main Menu"  },
            ...(hasGuide ? [{ id: "guide", title: "📋 Product Guide" }] : []),
          ];

          nodes.push({
            id:       pId,
            type:     "interactive",
            position: { x: 840, y: (catIdx * catProds.length + pi) * Y },
            parentId: FOLDER_IDS.CATALOG,
            data: {
              label:           `Product: ${p.title.substring(0, 20)}`,
              interactiveType: "button",
              text:            `*${p.title}*\n\n💰 Price: ${currency}${p.price}${p.features ? `\n\n${p.features.slice(0, 160)}` : ""}`,
              imageUrl:        p.imageUrl || "",
              shopifyProductId: p.id || "",
              buttonsList:     btns,
            },
          });

          edges.push(
            { id: `f2_cl${catIdx}_p${pi}`,     source: catNodeId, target: pId,     sourceHandle: `p_${catIdx}_${pi}` },
            { id: `f2_p${catIdx}${pi}_menu`,   source: pId,       target: IDS.MENU, sourceHandle: "menu" }
          );

          if (hasGuide) {
            nodes.push({
              id:       guideId,
              type:     "message",
              position: { x: 200, y: (enrichedProducts.indexOf(p) + 5) * Y },
              parentId: FOLDER_IDS.POSTPURCH,
              data: { label: `Guide: ${p.title.substring(0, 20)}`, text: content[`guide_${p.handle}`] },
            });
            edges.push({ id: `f2_p${catIdx}${pi}_guide`, source: pId, target: guideId, sourceHandle: "guide" });
          }
        });
      });
    } else {
      // Single category — flat product list
      nodes.push({
        id:       IDS.CATALOG,
        type:     "interactive",
        position: { x: 0, y: 0 },
        parentId: FOLDER_IDS.CATALOG,
        data: {
          label:           "Product Catalog",
          interactiveType: "list",
          text:            content.product_menu_text,
          buttonText:      "View Products",
          sections: [
            {
              title: `${businessName} Products`,
              rows:  enrichedProducts.map((p, i) => ({ id: `p_${i}`, title: p.title.substring(0, 24) })),
            },
          ],
        },
      });

      // ── productMode: 'template' | 'manual' (from wizard toggle) ──────────────
      // 'template' → Use pre-approved Meta template IF available, otherwise
      //              fall back to manual interactive node (NEVER block the flow)
      // 'manual'   → Always use interactive node with image + buy button inline
      //              (no Meta template dependency whatsoever)
      const productMode = wizardData.productMode || 'template';

      enrichedProducts.forEach((p, i) => {
        const pId      = `${IDS.DETAIL_PREFIX}${i}`;
        const buyId    = `f2_buy_${i}_${ts}`;   // "Buy Now" intent handler node
        const talkId   = `f2_talk_${i}_${ts}`;  // "Talk to Agent" node when no buy link
        const guideId  = `f8_guide_${p.handle}_${ts}`;
        const hasGuide = !!content[`guide_${p.handle}`];

        // Build the product buy URL (Shopify store URL + product handle)
        const storeBase = wizardData.shopDomain
          ? `https://${wizardData.shopDomain.replace(/^https?:\/\//, '')}`
          : (checkoutUrl ? checkoutUrl.replace(/\/checkout$/, '') : '');
        const buyUrl = storeBase ? `${storeBase}/products/${p.handle}` : '';

        // ── Template Engine ──────────────────────────────────────────────────
        const templateName = `prod_${p.handle.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`.substring(0, 50);
        const approvedTemplate = productMode === 'template'
          ? (client.messageTemplates || []).find(t => t.name === templateName && t.status === 'APPROVED')
          : null; // manual mode: always use interactive nodes

        // Queue template for future submission (template mode only, no approved template)
        if (productMode === 'template' && !approvedTemplate) {
          wizardData.customTemplates = wizardData.customTemplates || [];
          if (!wizardData.customTemplates.find(t => t.name === templateName)) {
            wizardData.customTemplates.push({
              name:      templateName,
              category:  'MARKETING',
              language:  'en',
              components: [
                { type: 'HEADER', format: 'IMAGE', _imageUrl: p.imageUrl || '' },
                { type: 'BODY', text: `*{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n{{3}}` },
                { type: 'FOOTER', text: businessName },
                {
                  type: 'BUTTONS',
                  buttons: [
                    ...(buyUrl ? [{ type: 'URL', text: '🛒 Buy Now', url: buyUrl }] : [{ type: 'QUICK_REPLY', text: '🛒 Buy Now' }]),
                    { type: 'QUICK_REPLY', text: '🎧 Talk to Agent' },
                    { type: 'QUICK_REPLY', text: '⬅️ Main Menu' },
                  ],
                },
              ],
            });
          }
        }

        // ── Build buttons list for interactive (manual) node ─────────────────
        // ⚠️ IDs declared here MUST match edge sourceHandles below — exactly.
        const btns = [
          { id: 'buy',    title: '🛒 Buy Now'        },
          { id: 'agent',  title: '🎧 Talk to Agent'  },
          { id: 'menu',   title: '⬅️ Main Menu'      },
          ...(hasGuide ? [{ id: 'guide', title: '📋 Product Guide' }] : []),
        ];

        // ── Push product node ────────────────────────────────────────────────
        if (approvedTemplate) {
          // ── TEMPLATE MODE (approved) — no buttons on node, buttons are in template
          nodes.push({
            id:       pId,
            type:     'template',
            position: { x: 420, y: i * Y },
            parentId: FOLDER_IDS.CATALOG,
            data: {
              label:        `Product: ${p.title.substring(0, 20)}`,
              templateName: templateName,
              variables:    [p.title, p.price, p.features?.slice(0, 120) || ''],
              imageUrl:     p.imageUrl || '',
            },
          });
          // Template quick-reply buttons: 'buy', 'agent', 'menu'
          // (engine handles these via tryGraphTraversal on button_reply)
          edges.push(
            { id: `f2_cat_p${i}`,    source: IDS.CATALOG, target: pId,    sourceHandle: `p_${i}` },
          );
          // For approved templates with URL buttons, buy intent is handled server-side.
          // We still wire 'menu' and 'agent' back-path edges from pId using template QUICK_REPLY payloads
          edges.push(
            { id: `f2_p${i}_m`,     source: pId, target: IDS.MENU,    sourceHandle: 'menu'  },
            { id: `f2_p${i}_agent`, source: pId, target: IDS.SCHED_NODE, sourceHandle: 'agent' },
          );
        } else {
          // ── MANUAL MODE — full interactive node with image + 3 inline buttons
          // This is also the FALLBACK when template is not approved yet.
          nodes.push({
            id:       pId,
            type:     'interactive',
            position: { x: 420, y: i * Y },
            parentId: FOLDER_IDS.CATALOG,
            data: {
              label:            `Product: ${p.title.substring(0, 20)}`,
              interactiveType:  'button',
              text:             `*${p.title}*\n\n💰 Price: ${currency}${p.price}${p.features ? `\n\n${p.features.slice(0, 160)}` : ''}`,
              imageUrl:         p.imageUrl || '',
              shopifyProductId: p.id || '',
              buttonsList:      btns,
            },
          });

          // ── "Buy Now" Intent Handler Node ─────────────────────────────────
          // When user taps "Buy Now" → send purchase link + route back to menu
          const buyText = buyUrl
            ? `🛒 *Buy ${p.title}*\n\nTap the link to complete your purchase securely:\n${buyUrl}\n\n_Questions? Reply *agent* to talk to us._`
            : `🛒 *Buy ${p.title}*\n\nOur team will send you the payment link immediately! A human agent will be with you shortly. 😊`;

          nodes.push({
            id:       buyId,
            type:     'message',
            position: { x: 840, y: i * Y - Y * 0.4 },
            parentId: FOLDER_IDS.CATALOG,
            data: { label: `Buy: ${p.title.substring(0, 16)}`, text: buyText },
          });

          // ── "Talk to Agent" Node ──────────────────────────────────────────
          // Routes to support schedule gate (same as 'support' on main menu)
          // No separate node needed — we wire 'agent' → SCHED_NODE

          edges.push(
            { id: `f2_cat_p${i}`,    source: IDS.CATALOG, target: pId,            sourceHandle: `p_${i}` },
            { id: `f2_p${i}_buy`,    source: pId,          target: buyId,          sourceHandle: 'buy'    }, // ← MUST match btn.id
            { id: `f2_p${i}_m`,      source: pId,          target: IDS.MENU,       sourceHandle: 'menu'   }, // ← MUST match btn.id
            { id: `f2_p${i}_agent`,  source: pId,          target: IDS.SCHED_NODE, sourceHandle: 'agent'  }, // ← MUST match btn.id
          );

          if (hasGuide) {
            nodes.push({
              id:       guideId,
              type:     'message',
              position: { x: 200, y: (i + 5) * Y },
              parentId: FOLDER_IDS.POSTPURCH,
              data: { label: `Guide: ${p.title.substring(0, 18)}`, text: content[`guide_${p.handle}`] },
            });
            edges.push({ id: `f2_p${i}_guide`, source: pId, target: guideId, sourceHandle: 'guide' }); // ← MUST match btn.id
          }
        }
      });
    }
  }

  // ====================================================================
  // FOLDER 3 — Order Operations
  //
  // THE GOLDEN PATH:
  //   [Shopify: CHECK_ORDER_STATUS] → (shows order info)
  //   [Interactive: Cancel Start]
  //     ↓ yes → [Logic: Already Shipped?]
  //                ↓ true  → [Message: In Transit Error]
  //                ↓ false → [Capture: Cancel Reason] → [Shopify: CANCEL_ORDER]
  //     ↓ no  → (no edge — flow ends naturally, fallback picks it up)
  // ====================================================================
  nodes.push(
    {
      id:       IDS.ORDER_STATUS,
      type:     "shopify_call",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label:  "Fetch Order Status",
        action: "CHECK_ORDER_STATUS",
      },
    },
    {
      id:       IDS.CANCEL_START,
      type:     "interactive",
      position: { x: 0, y: Y * 1.5 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label:           "Cancel Order Hub",
        interactiveType: "button",
        text:            content.cancellation_confirm,
        buttonsList: [
          { id: "yes",  title: "✅ Yes, Cancel" },
          { id: "no",   title: "❌ Keep My Order" },
          { id: "menu", title: "⬅️ Main Menu"  },
        ],
      },
    },
    {
      id:       IDS.CANCEL_LOGIC,
      type:     "logic",
      position: { x: 420, y: Y * 1.5 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label:    "Is Order Shipped?",
        variable: "is_shipped",
        operator: "eq",
        value:    "true",
      },
    },
    {
      id:       IDS.CANCEL_REASON,
      type:     "capture_input",
      position: { x: 840, y: Y * 0.75 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label:    "Cancellation Reason",
        variable: "cancel_reason",
        question: "Why are you cancelling? Your feedback helps us improve! 🙏 (Type your reason)",
      },
    },
    {
      id:       IDS.CANCEL_ALREADY_SHIPPED,
      type:     "message",
      position: { x: 840, y: Y * 2.5 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label: "Already Shipped Error",
        text:  content.in_transit_error,
      },
    },
    {
      id:       IDS.CANCEL_FINAL,
      type:     "shopify_call",
      position: { x: 1260, y: Y * 0.75 },
      parentId: FOLDER_IDS.ORDERS,
      data: {
        label:  "Process Cancellation",
        action: "CANCEL_ORDER",
      },
    }
  );

  edges.push(
    { id: "f3_can_y",   source: IDS.CANCEL_START,          target: IDS.CANCEL_LOGIC,           sourceHandle: "yes"   },
    { id: "f3_can_m",   source: IDS.CANCEL_START,          target: IDS.MENU,                   sourceHandle: "menu"  },
    { id: "f3_log_t",   source: IDS.CANCEL_LOGIC,          target: IDS.CANCEL_ALREADY_SHIPPED, sourceHandle: "true"  },
    { id: "f3_log_f",   source: IDS.CANCEL_LOGIC,          target: IDS.CANCEL_REASON,          sourceHandle: "false" },
    { id: "f3_can_fin", source: IDS.CANCEL_REASON,         target: IDS.CANCEL_FINAL            },
  );

  // ====================================================================
  // FOLDER 4 — Returns & Refunds
  //
  // THE GOLDEN PATH:
  //   [Interactive: Return Hub]
  //     ↓ photo   → [Capture: Return Reason] → [Capture: Photo/File] → [Message: Success]
  //     ↓ refund  → [Shopify: ORDER_REFUND_STATUS] → [Message: Refund Policy]
  //     ↓ policy  → [Message: Returns Policy] (in Folder 8)
  //     ↓ menu    → MENU
  // ====================================================================
  nodes.push(
    {
      id:       IDS.RETURN_HUB,
      type:     "interactive",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label:           "Returns & Refunds Hub",
        interactiveType: "button",
        text:            "What would you like help with? Select below:",
        buttonsList: [
          { id: "photo",  title: "📸 Start Return" },
          { id: "refund", title: "💸 Refund Status"  },
          { id: "menu",   title: "⬅️ Main Menu"   },
        ],
      },
    },
    {
      id:       IDS.RETURN_REASON,
      type:     "capture_input",
      position: { x: 420, y: -Y * 0.5 },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label:    "Return Reason",
        variable: "return_reason",
        question: "Please tell us the reason for your return. (e.g. damaged, wrong item, changed mind)",
      },
    },
    {
      id:       IDS.RETURN_PHOTO,
      type:     "capture_input",
      position: { x: 840, y: -Y * 0.5 },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label:    "Damage Photo",
        variable: "return_photo",
        question: content.return_photo_prompt,
      },
    },
    {
      id:       IDS.RETURN_SUCCESS,
      type:     "message",
      position: { x: 1260, y: -Y * 0.5 },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label: "Return Confirmed",
        text:  "✅ Return request received! Our team will verify your photo and arrange pickup within 24–48 hours. You'll receive a confirmation SMS shortly.",
      },
    },
    {
      id:       IDS.REFUND_STATUS,
      type:     "shopify_call",
      position: { x: 420, y: Y },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label:  "Fetch Refund Status",
        action: "ORDER_REFUND_STATUS",
      },
    },
    {
      id:       IDS.REFUND_FINAL,
      type:     "message",
      position: { x: 840, y: Y },
      parentId: FOLDER_IDS.RETURNS,
      data: {
        label: "Refund Policy",
        text:  content.refund_policy_short,
      },
    }
  );

  edges.push(
    { id: "f4_hub_photo",  source: IDS.RETURN_HUB,    target: IDS.RETURN_REASON, sourceHandle: "photo"  },
    { id: "f4_hub_refund", source: IDS.RETURN_HUB,    target: IDS.REFUND_STATUS, sourceHandle: "refund" },
    { id: "f4_hub_menu",   source: IDS.RETURN_HUB,    target: IDS.MENU,          sourceHandle: "menu"   },
    { id: "f4_rea_photo",  source: IDS.RETURN_REASON, target: IDS.RETURN_PHOTO                          },
    { id: "f4_photo_ok",   source: IDS.RETURN_PHOTO,  target: IDS.RETURN_SUCCESS                        },
    { id: "f4_ref_fin",    source: IDS.REFUND_STATUS, target: IDS.REFUND_FINAL                          },
  );

  // ====================================================================
  // FOLDER 5 — Support & Escalation
  //
  // THE GOLDEN PATH (as specified):
  //   [Schedule: Business Hours Check]
  //     ↓ open   → [Capture Input: "What do you need help with?"]
  //                  → [Tag: pending-human]
  //                     → [Admin Alert: Notify business owner]
  //                        → [Message: "Our team will reply shortly"]
  //     ↓ closed → [Message: Support Hours / After Hours]
  // ====================================================================
  nodes.push(
    {
      id:       IDS.SCHED_NODE,
      type:     "schedule",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label:         "Hours Gate",
        openTime,
        closeTime,
        days:          workingDays,
        closedMessage: `Our agents are offline right now. We're available ${openTime}–${closeTime}, Mon–Sat. Leave a message and we'll reply first thing!`,
      },
    },
    {
      id:       IDS.SUPPORT_CAPTURE,
      type:     "capture_input",
      position: { x: 420, y: -Y * 0.5 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label:    "Capture Issue",
        variable: "support_query",
        question: "What do you need help with today? Describe your issue and our team will get back to you right away. 😊",
      },
    },
    {
      id:       IDS.SUPPORT_TAG,
      type:     "tag_lead",
      position: { x: 840, y: -Y * 0.5 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label:  "Tag: Pending Human",
        action: "add",
        tag:    "pending-human",
      },
    },
    {
      id:       IDS.SUPPORT_ALERT,
      type:     "admin_alert",
      position: { x: 1260, y: -Y * 0.5 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label:         "Notify Business Owner",
        priority:      "high",
        topic:         `🔔 Human Agent Requested — ${businessName}`,
        phone:         adminPhone,
        triggerSource: "Support Flow",
        // ⚠️ CRITICAL — admins are often outside the 24-hr customer service window.
        // Plain text will FAIL delivery. We use an approved HSM template to guarantee it.
        templateName:  "admin_human_alert",
        templateVars:  ["{{lead.name}}", "{{lead.phone}}", "{{convo.lastMessage}}"],
      },
    },
    {
      id:       IDS.SUPPORT_FINAL,
      type:     "message",
      position: { x: 1680, y: -Y * 0.5 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label: "Handoff Confirmed",
        text:  content.agent_handoff_msg,
      },
    },
    {
      id:       IDS.SUPPORT_HOURS,
      type:     "message",
      position: { x: 420, y: Y * 1.5 },
      parentId: FOLDER_IDS.SUPPORT,
      data: {
        label: "After-Hours Message",
        text:  content.support_hours_msg,
      },
    }
  );

  // ⚠️ SCHEDULE EXIT HANDLES: 'open' and 'closed' — must match the schedule node's sourceHandles
  // The engine routes via executeNode → schedule type → finds nextEdge by these sourceHandles
  edges.push(
    { id: "f5_sch_open",  source: IDS.SCHED_NODE,      target: IDS.SUPPORT_CAPTURE, sourceHandle: "open"   },
    { id: "f5_sch_clsd",  source: IDS.SCHED_NODE,      target: IDS.SUPPORT_HOURS,   sourceHandle: "closed" },
    { id: "f5_cap_tag",   source: IDS.SUPPORT_CAPTURE, target: IDS.SUPPORT_TAG                             },
    { id: "f5_tag_alert", source: IDS.SUPPORT_TAG,     target: IDS.SUPPORT_ALERT                           },
    { id: "f5_alert_fin", source: IDS.SUPPORT_ALERT,   target: IDS.SUPPORT_FINAL                           },
  );

  // ====================================================================
  // FOLDER 6 — Loyalty & Rewards
  //
  // THE GOLDEN PATH:
  //   [Loyalty Hub List]
  //     ↓ pts  → [Message: Points Balance]
  //     ↓ red  → [Loyalty: REDEEM_POINTS]
  //     ↓ ref  → [Message: Referral Pitch]
  //     ↓ vip  → [Logic: VIP Tier Check]
  //                ↓ true  → [Message: VIP Perk]
  //                ↓ false → [Message: Tier Nudge]
  //   [Loyalty: ADD_POINTS] — triggered by signup/order events
  // ====================================================================
  nodes.push(
    {
      id:       IDS.LOY_MENU,
      type:     "interactive",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label:           "Rewards Hub",
        interactiveType: "list",
        text:            content.loyalty_welcome,
        buttonText:      "My Rewards",
        sections: [
          {
            title: "Loyalty Options",
            rows: [
              { id: "pts",  title: "💎 My Points"        },
              { id: "red",  title: "🎁 Redeem Points"    },
              { id: "ref",  title: "📢 Invite & Earn"   },
              { id: "vip",  title: "⭐ VIP Status"       },
              { id: "menu", title: "⬅️ Main Menu"       },
            ],
          },
        ],
      },
    },
    {
      id:       IDS.LOY_POINTS,
      type:     "message",
      position: { x: 420, y: -Y },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label: "Points Balance",
        text:  content.loyalty_points_msg,
      },
    },
    {
      id:       IDS.LOY_REDEEM,
      type:     "loyalty",
      position: { x: 420, y: -Y * 0.2 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label:          "Redeem Points",
        loyaltyAction:  "REDEEM_POINTS",
        pointsRequired: 100,
      },
    },
    {
      id:       IDS.LOY_REFER,
      type:     "message",
      position: { x: 420, y: Y * 0.7 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label: "Referral Pitch",
        text:  content.referral_msg,
      },
    },
    {
      id:       IDS.LOY_TIER,
      type:     "logic",
      position: { x: 420, y: Y * 1.6 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label:    "VIP Tier Check",
        variable: "loyalty_balance",
        operator: "gte",
        value:    "1000",
      },
    },
    {
      id:       IDS.LOY_VIP_PERK,
      type:     "message",
      position: { x: 840, y: Y * 1.2 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label: "VIP Perk Reveal",
        text:  content.vip_perk_msg,
      },
    },
    {
      id:       IDS.LOY_NEW_NUDGE,
      type:     "message",
      position: { x: 840, y: Y * 2.1 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label: "Tier Progress Nudge",
        text:  content.new_member_nudge,
      },
    },
    {
      id:       IDS.LOYALTY_AWARD,
      type:     "loyalty",
      position: { x: 0, y: Y * 2.8 },
      parentId: FOLDER_IDS.LOYALTY,
      data: {
        label:         "Award Signup Points",
        loyaltyAction: "ADD_POINTS",
        points:        signupPoints,
        reason:        content.loyalty_award_reason,
      },
    }
  );

  edges.push(
    { id: "f6_pts",     source: IDS.LOY_MENU,  target: IDS.LOY_POINTS,    sourceHandle: "pts"  },
    { id: "f6_red",     source: IDS.LOY_MENU,  target: IDS.LOY_REDEEM,    sourceHandle: "red"  },
    { id: "f6_ref",     source: IDS.LOY_MENU,  target: IDS.LOY_REFER,     sourceHandle: "ref"  },
    { id: "f6_vip",     source: IDS.LOY_MENU,  target: IDS.LOY_TIER,      sourceHandle: "vip"  },
    { id: "f6_lm_menu", source: IDS.LOY_MENU,  target: IDS.MENU,          sourceHandle: "menu" },
    { id: "f6_tier_t",  source: IDS.LOY_TIER,  target: IDS.LOY_VIP_PERK,  sourceHandle: "true" },
    { id: "f6_tier_f",  source: IDS.LOY_TIER,  target: IDS.LOY_NEW_NUDGE, sourceHandle: "false"},
  );

  // ====================================================================
  // FOLDER 7 — Smart Automations
  //
  // THREE FULLY WIRED AUTOMATION SEQUENCES:
  //
  // A. Abandoned Cart Recovery (3-step drip with delays)
  //   [Trigger: checkout_abandoned]
  //     → [Delay 15min] → [Message: Recovery 1]
  //     → [Delay 2hr]   → [Message: Recovery 2]
  //     → [Delay 24hr]  → [Message: Recovery 3]
  //
  // B. Order Confirmation + COD Nudge
  //   [Trigger: order_created] → [Message: Confirmed]
  //     → [Logic: Is COD?]
  //       ↓ true  → [COD-to-Prepaid: CONVERT_COD_TO_PREPAID]
  //       ↓ false → (flow ends cleanly — prepaid orders need nothing)
  //
  // C. Post-Delivery Review Collection
  //   [Trigger: order_fulfilled] → [Review: Sentiment]
  //     → ↓ positive → [Message: Review Link]
  //     → ↓ negative → [Message: Escalation Apology]
  // ====================================================================
  nodes.push(
    // A. Cart recovery trigger
    {
      id:       IDS.CART_TR,
      type:     "trigger",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:       "Abandoned Checkout",
        triggerType: "shopify_event",
        event:       "checkout_abandoned",
      },
    },
    // A. Delay + Message step 1
    {
      id:       IDS.CART_D1,
      type:     "delay",
      position: { x: 420, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:     `Wait ${cartTiming.msg1 || 15} minutes`,
        waitValue: cartTiming.msg1 || 15,
        waitUnit:  "minutes",
      },
    },
    {
      id:       IDS.CART_M1,
      type:     "message",
      position: { x: 840, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label: "Cart Recovery 1",
        text:  content.cart_recovery_1,
      },
    },
    // A. Delay + Message step 2
    {
      id:       IDS.CART_D2,
      type:     "delay",
      position: { x: 1260, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:     `Wait ${cartTiming.msg2 || 2} hours`,
        waitValue: cartTiming.msg2 || 2,
        waitUnit:  "hours",
      },
    },
    {
      id:       IDS.CART_M2,
      type:     "message",
      position: { x: 1680, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label: "Cart Recovery 2",
        text:  content.cart_recovery_2,
      },
    },
    // A. Delay + Message step 3
    {
      id:       IDS.CART_D3,
      type:     "delay",
      position: { x: 2100, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:     `Wait ${cartTiming.msg3 || 24} hours`,
        waitValue: cartTiming.msg3 || 24,
        waitUnit:  "hours",
      },
    },
    {
      id:       IDS.CART_M3,
      type:     "template",
      position: { x: 2520, y: 0 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:        "Cart Recovery 3 (Final)",
        templateName: "cart_recovery",
        variables: ["{{checkout_url}}"]
      },
    },
    // B. Order confirmed trigger
    {
      id:       IDS.CONF_TR,
      type:     "trigger",
      position: { x: 0, y: Y * 2 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:       "Order Created",
        triggerType: "shopify_event",
        event:       "order_created",
      },
    },
    {
      id:       IDS.CONF_MSG,
      type:     "template",
      position: { x: 420, y: Y * 2 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:        "Order Confirmed",
        templateName: "order_conf",
        variables: ["{{order_id}}", "{{cart_items}}", "{{order_total}}"]
      },
    },
    // B. COD Gate — only nudge if payment_method == cod
    {
      id:       IDS.COD_CHECK,
      type:     "logic",
      position: { x: 840, y: Y * 2 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:    "COD Payment?",
        variable: "payment_method",
        operator: "contains",
        value:    "cod",
      },
    },
    {
      id:       IDS.COD_NUDGE,
      type:     "cod_prepaid",
      position: { x: 1260, y: Y * 1.6 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:          `Prepay & Save ${currency}50`,
        discountAmount: 50,
        action:         "CONVERT_COD_TO_PREPAID",
        text:           content.cod_nudge,
      },
    },
    // C. Post-delivery review
    {
      id:       IDS.REV_TRIG,
      type:     "trigger",
      position: { x: 0, y: Y * 4 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:       "Order Fulfilled",
        triggerType: "shopify_event",
        event:       "order_fulfilled",
      },
    },
    {
      id:       IDS.REV_ASK,
      type:     "template",
      position: { x: 420, y: Y * 4 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label:          "Sentiment Check",
        templateName:   "review_request",
        variables:   ["{{lead.name}}"],
      },
    },
    {
      id:       IDS.REV_GOOD,
      type:     "message",
      position: { x: 840, y: Y * 3.5 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label: "Positive Review Redirect",
        text:  content.review_positive + (googleReviewUrl ? `\n\n⭐ ${googleReviewUrl}` : ""),
      },
    },
    {
      id:       IDS.REV_BAD,
      type:     "message",
      position: { x: 840, y: Y * 4.7 },
      parentId: FOLDER_IDS.AUTOMATION,
      data: {
        label: "Negative Review Escalation",
        text:  content.review_negative,
      },
    }
  );

  edges.push(
    // A. Cart recovery drip
    { id: "f7_cart_d1",  source: IDS.CART_TR,   target: IDS.CART_D1  },
    { id: "f7_d1_m1",    source: IDS.CART_D1,   target: IDS.CART_M1  },
    { id: "f7_m1_d2",    source: IDS.CART_M1,   target: IDS.CART_D2  },
    { id: "f7_d2_m2",    source: IDS.CART_D2,   target: IDS.CART_M2  },
    { id: "f7_m2_d3",    source: IDS.CART_M2,   target: IDS.CART_D3  },
    { id: "f7_d3_m3",    source: IDS.CART_D3,   target: IDS.CART_M3  },
    // B. Order + COD
    { id: "f7_conf_msg", source: IDS.CONF_TR,   target: IDS.CONF_MSG              },
    { id: "f7_conf_chk", source: IDS.CONF_MSG,  target: IDS.COD_CHECK             },
    { id: "f7_cod_t",    source: IDS.COD_CHECK, target: IDS.COD_NUDGE, sourceHandle: "true" },
    // false path: no edge needed — prepaid orders end cleanly → fallback handles
    // C. Review
    { id: "f7_rev_s",    source: IDS.REV_TRIG,  target: IDS.REV_ASK               },
    { id: "f7_rev_g",    source: IDS.REV_ASK,   target: IDS.REV_GOOD, sourceHandle: "positive" },
    { id: "f7_rev_b",    source: IDS.REV_ASK,   target: IDS.REV_BAD,  sourceHandle: "negative" },
  );

  // ====================================================================
  // FOLDER 8 — Post-Purchase Hub (Knowledge Base + Warranty + B2B)
  //
  // Contains:
  //   - AI Fallback node (ROOT-LEVEL — catches all dead ends)
  //   - FAQ & Returns Policy knowledge nodes
  //   - Full Warranty Registration + Lookup pipeline
  //   - B2B/Wholesale funnel (conditional on b2bEnabled)
  //   - Product guide messages (added inline alongside catalog nodes)
  // ====================================================================

  // 8A. AI Fallback node — THE SAFETY NET
  //     Position outside folder so it's always visible at root level
  nodes.push({
    id:       IDS.AI_FALLBACK,
    type:     "message",
    position: { x: -300, y: 300 },
    // No parentId — root-level floating node
    data: {
      label:  "🤖 AI Fallback",
      text:   fallbackMessage || content.fallback_msg,
      action: "AI_FALLBACK",
    },
  });

  // 8B. Knowledge base nodes
  //     IDS.FAQ_MSG  — reached directly from main menu "faq" row
  //     IDS.FAQ_NODE — internal knowledge base node (legacy / cross-link)
  nodes.push(
    {
      id:       IDS.FAQ_MSG,
      type:     "interactive",
      position: { x: 0, y: -Y },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:           "FAQ & Help",
        interactiveType: "button",
        text:            faqText
          ? `*Frequently Asked Questions*\n\n${faqText.slice(0, 600)}\n\nWant more help?`
          : `*${businessName} FAQs*\n\n${content.faq_response}\n\nWant more help?`,
        buttonsList: [
          { id: "menu",   title: "⬅️ Main Menu"   },
          { id: "agent",  title: "🎧 Talk to Agent" },
        ],
      },
    },
    {
      id:       IDS.FAQ_NODE,
      type:     "message",
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label: "General FAQs",
        text:  faqText || content.faq_response,
      },
    },
    {
      id:       IDS.RET_POLICY_NODE,
      type:     "message",
      position: { x: 0, y: Y },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label: "Returns Policy",
        text:  returnsInfo || content.returns_policy_short,
      },
    }
  );

  // Wire FAQ hub back to menu and to support
  edges.push(
    { id: "f8_faq_menu",  source: IDS.FAQ_MSG, target: IDS.MENU,       sourceHandle: "menu"  },
    { id: "f8_faq_agent", source: IDS.FAQ_MSG, target: IDS.SCHED_NODE, sourceHandle: "agent" },
  );

  // 8C. Warranty Module — Registration + Lookup
  nodes.push(
    {
      id:       IDS.WARRANTY_HUB,
      type:     "interactive",
      position: { x: 420, y: 0 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:           "Warranty Hub",
        interactiveType: "button",
        text:            content.warranty_welcome,
        buttonsList: [
          { id: "reg",   title: "✅ Register Warranty" },
          { id: "check", title: "🔍 Check Status"      },
          { id: "menu",  title: "⬅️ Main Menu"        },
        ],
      },
    },
    // Registration pipeline
    {
      id:       IDS.WARRANTY_REG_SERIAL,
      type:     "capture_input",
      position: { x: 840, y: -Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:    "Capture Serial Number",
        variable: "warranty_serial",
        question: "Please enter your Product Serial Number or Order ID to begin registration.",
      },
    },
    {
      id:       IDS.WARRANTY_REG_DATE,
      type:     "capture_input",
      position: { x: 1260, y: -Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:    "Capture Purchase Date",
        variable: "purchase_date",
        question: "Please enter your date of purchase (DD/MM/YYYY).",
      },
    },
    {
      id:       IDS.WARRANTY_REG_TAG,
      type:     "tag_lead",
      position: { x: 1680, y: -Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:  "Tag: Warranty Enrolled",
        action: "add",
        tag:    "warranty-enrolled",
      },
    },
    {
      id:       IDS.WARRANTY_REG_SUCCESS,  // Single declaration — no duplicates
      type:     "message",
      position: { x: 2100, y: -Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label: "Warranty Activated",
        text:  content.warranty_reg_success,
      },
    },
    // Lookup pipeline
    {
      id:       IDS.WARRANTY_LOOKUP_SER,
      type:     "capture_input",
      position: { x: 840, y: Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:    "Serial Number Lookup",
        variable: "lookup_serial",
        question: content.warranty_lookup_prompt,
      },
    },
    {
      id:       IDS.WARRANTY_LOOKUP_EXEC,
      type:     "warranty_check",
      position: { x: 1260, y: Y * 0.75 },
      parentId: FOLDER_IDS.POSTPURCH,
      data: {
        label:    "Warranty Engine Lookup",
        action:   "WARRANTY_CHECK",
        duration: warrantyDuration,
        policy:   warrantyPolicy,
      },
    }
  );

  edges.push(
    // Warranty registration
    { id: "f8_war_reg",   source: IDS.WARRANTY_HUB,        target: IDS.WARRANTY_REG_SERIAL,  sourceHandle: "reg"   },
    { id: "f8_war_menu",  source: IDS.WARRANTY_HUB,        target: IDS.MENU,                 sourceHandle: "menu"  },
    { id: "f8_war_s_d",   source: IDS.WARRANTY_REG_SERIAL, target: IDS.WARRANTY_REG_DATE                           },
    { id: "f8_war_d_t",   source: IDS.WARRANTY_REG_DATE,   target: IDS.WARRANTY_REG_TAG                            },
    { id: "f8_war_t_ok",  source: IDS.WARRANTY_REG_TAG,    target: IDS.WARRANTY_REG_SUCCESS                        },
    // Warranty lookup
    { id: "f8_war_look",  source: IDS.WARRANTY_HUB,        target: IDS.WARRANTY_LOOKUP_SER,  sourceHandle: "check" },
    { id: "f8_war_l_ex",  source: IDS.WARRANTY_LOOKUP_SER, target: IDS.WARRANTY_LOOKUP_EXEC                        },
  );

  // 8D. B2B / Wholesale Nexus (conditional)
  if (b2bEnabled) {
    nodes.push(
      {
        id:       IDS.B2B_TRIGGER,
        type:     "trigger",
        position: { x: 0, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label:       "B2B/Wholesale Intent",
          triggerType: "keyword",
          keywords:    ["wholesale", "bulk", "b2b", "bulk order", "distributor", "reseller", "dealer"],
          matchMode:   "contains",
        },
      },
      {
        id:       IDS.B2B_FORM,
        type:     "capture_input",
        position: { x: 420, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label:    "Company Name",
          variable: "b2b_company",
          question: content.b2b_welcome,
        },
      },
      {
        id:       IDS.B2B_VOLUME,
        type:     "capture_input",
        position: { x: 840, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label:    "Volume & Category",
          variable: "b2b_volume",
          question: content.b2b_capture_prompt,
        },
      },
      {
        id:       IDS.B2B_TAG,
        type:     "tag_lead",
        position: { x: 1260, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label:  "Tag: B2B Prospect",
          action: "add",
          tag:    "b2b-prospect",
        },
      },
      {
        id:       IDS.B2B_ALERT,
        type:     "admin_alert",
        position: { x: 1680, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label:        "B2B Lead Alert",
          priority:     "high",
          topic:        `🤝 NEW B2B WHOLESALE LEAD — ${businessName}`,
          phone:        b2bAdminPhone || adminPhone,
          // Admin may be outside the 24-hr window for B2B inquiries too.
          templateName: "admin_human_alert",
          templateVars: ["{{lead.name}} (B2B)", "{{lead.phone}}", "{{capturedData.b2b_volume}}"],
        },
      },
      {
        id:       IDS.B2B_CONFIRM,
        type:     "message",
        position: { x: 2100, y: Y * 5 },
        parentId: FOLDER_IDS.POSTPURCH,
        data: {
          label: "B2B Confirmation",
          text:  `All set! 👔 Our wholesale team will reach out within 2 hours with a custom pricing quote tailored to your business needs.`,
        },
      }
    );

    edges.push(
      { id: "f8_b2b_tr",  source: IDS.B2B_TRIGGER, target: IDS.B2B_FORM    },
      { id: "f8_b2b_fi",  source: IDS.B2B_FORM,    target: IDS.B2B_VOLUME  },
      { id: "f8_b2b_it",  source: IDS.B2B_VOLUME,  target: IDS.B2B_TAG     },
      { id: "f8_b2b_ta",  source: IDS.B2B_TAG,     target: IDS.B2B_ALERT   },
      { id: "f8_b2b_ac",  source: IDS.B2B_ALERT,   target: IDS.B2B_CONFIRM },
    );
  }

  // ====================================================================
  // ⚡ THE ULTIMATE FAIL-SAFE: AI Fallback Dead-End Detection Algorithm
  //
  // Strategy: Find every node that has NO outgoing edges.
  // These are "dead-end" nodes — the user gets stranded here.
  // Wire them ALL to IDS.AI_FALLBACK so Gemini takes over seamlessly.
  //
  // Exclusions (nodes that legitimately have no outgoing edge):
  //   - folder type nodes (they route internally, not linearly)
  //   - AI_FALLBACK itself (never wire fallback → fallback)
  //   - trigger nodes (they are sources, not sinks — their dead-end handling
  //     is managed by the trigger engine when no keyword fires)
  // ====================================================================
  const nodesWithOutgoingEdge = new Set(edges.map(e => e.source));

  const DEAD_END_EXCLUSION_TYPES = new Set(["folder", "trigger"]);

  const deadEndNodes = nodes.filter(n =>
    !DEAD_END_EXCLUSION_TYPES.has(n.type) &&
    n.id !== IDS.AI_FALLBACK &&
    !nodesWithOutgoingEdge.has(n.id)
  );

  deadEndNodes.forEach((n, idx) => {
    edges.push({
      id:     `fallback_${n.id}_${idx}`,
      source: n.id,
      target: IDS.AI_FALLBACK,
      // Use animated dashed style to visually distinguish fallback edges on canvas
      animated: true,
      style:    { strokeDasharray: "5 5", stroke: "#6366f1", opacity: 0.6 },
      label:    "AI Fallback",
    });
  });

  console.log(`[FlowGenerator] 🛡️ Dead-end detection: ${deadEndNodes.length} node(s) auto-wired to AI Fallback.`);

  // ====================================================================
  // FINALIZATION
  // ====================================================================

  // Update folder childCount metadata
  const folderCounts = {};
  nodes.forEach(n => {
    if (n.parentId && n.type !== "folder") {
      folderCounts[n.parentId] = (folderCounts[n.parentId] || 0) + 1;
    }
  });
  nodes.forEach(n => {
    if (n.type === "folder" && folderCounts[n.id]) {
      n.data.childCount = folderCounts[n.id];
    }
  });

  // Apply stripPlaceholders to all text fields across all nodes
  nodes = cleanNodeText(nodes);

  // Run basic integrity check (duplicate IDs, dangling edges, prohibited keys)
  verifyFlowIntegrity(nodes, edges);

  // ── THE LAW: Run strict button-ID → edge sourceHandle validation ─────────
  // This throws if any interactive node's buttons don't match their edges.
  // A thrown error here prevents a broken flow from ever being saved to DB.
  try {
    verifyAllEdgesMatchButtonIds(nodes, edges);
  } catch (validationErr) {
    // Re-throw with context so the wizard endpoint returns a useful 500 error
    throw validationErr;
  }

  console.log(
    `[FlowGenerator] ✅ Golden Path built: ${nodes.length} nodes, ${edges.length} edges` +
    ` across 8 folders${b2bEnabled ? ' (B2B enabled)' : ''}.`
  );

  return { nodes, edges };
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

  // ── TOP 3 PRODUCT TEMPLATES ─────────────────────────────────────────────────
  // Each product gets its own Meta-compliant template with:
  //   • HEADER: IMAGE (product photo from Shopify)
  //   • BODY:   name / price / feature excerpt
  //   • FOOTER: brand name
  //   • BUTTONS: URL "Buy Now" → direct product page + QUICK_REPLY "Main Menu"
  const { buildProductContext } = module.exports;
  const top3Products = products.slice(0, 3).map((p, i) => buildProductContext(p, i));

  const productTemplates = top3Products.map((p) => {
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
          text: `*{{1}}*\n\n\uD83D\uDCB0 Price: ${currency}{{2}}\n\n{{3}}`,
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
      body:      `*{{1}}*\n\n\uD83D\uDCB0 Price: ${currency}{{2}}\n\n{{3}}`,
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
            { type: "QUICK_REPLY", text: "\uD83D\uDED4\uFE0F Shop" },
            { type: "QUICK_REPLY", text: "\uD83C\uDFA7 Support" },
            { type: "QUICK_REPLY", text: "\uD83D\uDCE6 Track Order" },
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
          text: `Hi! \uD83D\uDC4B You left items in your cart at ${brandSafe}. Still interested?\n\nItems are selling fast! Complete your purchase here:\n{{1}}`,
        },
        ...(storeBase
          ? [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Complete Purchase", url: `${storeBase}/cart` }] }]
          : []),
      ],
      body:      `Hi! \uD83D\uDC4B You left items in your cart at ${brandSafe}. Still interested?\n\nItems are selling fast! Complete your purchase here:\n{{1}}`,
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
          buttons: [{ type: "QUICK_REPLY", text: `\uD83D\uDCB3 Pay Online & Save ${currency}50` }],
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
                buttons: [{ type: "URL", text: "\u2B50 Leave a Review", url: googleReviewUrl }],
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
