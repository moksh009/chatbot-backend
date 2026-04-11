"use strict";

const { generateText } = require("./gemini");

/**
 * FLOW GENERATOR — Phase R3 ENTERPRISE
 * Takes wizard form data and generates a complete 60+ node enterprise flow.
 *
 * @param {Object} client     - Client document
 * @param {Object} wizardData - Data from the onboarding wizard form
 * @returns {{ nodes, edges }}
 */
async function generateEcommerceFlow(client, wizardData) {
  const {
    businessName,
    businessDescription,
    products        = [],
    botName         = "Assistant",
    tone            = "friendly",
    botLanguage     = "Hinglish",
    cartTiming      = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl = "",
    adminPhone      = "",
    faqText         = "",
    returnsInfo     = "",
    fallbackMessage = "I'm still learning! Let me connect you with a human expert. 😊",
    // Enterprise Ops
    openTime        = "10:00",
    closeTime       = "19:00",
    workingDays     = [1, 2, 3, 4, 5],
    referralPoints  = 500,
    signupPoints    = 100,
    activePersona   = "sidekick",
    b2bEnabled      = false,
    warrantyDuration = "1 Year",
    warrantyPolicy   = "Standard manufacturer warranty applicable from date of purchase."
  } = wizardData;

  const personaMap = {
    concierge: { label: "Elite Concierge", type: "Luxury/Formal", tone_markers: "Use 'Sir/Ma'am', extremely polite, high-end vocabulary, boutique feel." },
    hacker:    { label: "Growth Hacker", type: "Sales/Aggressive", tone_markers: "FOMO-driven, enthusiastic, use emojis like 🚀🔥, fast-paced, direct." },
    sidekick:  { label: "Friendly Sidekick", type: "Casual/Friendly", tone_markers: "Warm, empathetic, uses 'friend/buddy', very approachable, uses 😊✨." },
    efficiency: { label: "Efficiency Expert", type: "Direct/Minimalist", tone_markers: "No fluff, bullet points, ultra-fast, professional but dry." }
  };
  const selectedPersona = personaMap[activePersona] || personaMap.sidekick;

  // ── STEP 1: Generate message text via Gemini ──────────────────────────────
  let content = {};
  const prompt = `You are a world-class WhatsApp UX Architect for an Indian e-commerce brand.
Business: ${businessName}
Description: ${businessDescription}
Bot Name: ${botName}
Tone Style: ${tone}
Persona Identity: ${selectedPersona.label} (${selectedPersona.type})
Persona Tone Guidelines: ${selectedPersona.tone_markers}
Language: ${botLanguage}
FAQs: ${faqText}
Returns Info: ${returnsInfo}
Loyalty: Referral=${referralPoints} pts, Signup=${signupPoints} pts
Business Hours: ${openTime} - ${closeTime}

Generate a JSON object for 28 different UI touchpoints. Ensure the language strictly follows the Persona Tone Guidelines above. Be concise but impactful.
REQUIRED KEYS:
"welcome_a", "welcome_b", "product_menu_text", "product_list_btn", 
"order_status_msg", "fallback_msg", "returns_policy_short", "refund_policy_short",
"cancellation_confirm", "cancellation_success", "installation_msg",
"loyalty_welcome", "loyalty_points_msg", "referral_msg",
"sentiment_ask", "review_positive", "review_negative",
"upsell_intro", "cross_sell_msg", "cart_recovery_1", "cart_recovery_2",
"cart_recovery_3", "cod_nudge", "order_confirmed_msg", "agent_handoff_msg",
"faq_response", "ad_welcome", "ig_welcome",
"b2b_welcome", "b2b_capture_prompt", "warranty_welcome", "warranty_lookup_prompt"
`;

  try {
    const res = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    if (res) {
      const jsonStr = res.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      content = parsed;
    }
  } catch (err) {
    console.warn("[FlowGenerator] AI failure, using hardcoded enterprise logic.");
  }

  // Merge with defaults
  content = { ...buildDefaultContent(businessName, botName, products, { referralPoints, signupPoints }), ...content };

  const ts = Date.now();
  const IDS = {
    // Entry & Context
    TRIGGER: `trig_${ts}`,
    AD_TRIGGER: `ad_trig_${ts}`,
    IG_TRIGGER: `ig_trig_${ts}`,
    PERSONA: `pers_${ts}`,
    AB_TEST: `ab_${ts}`,
    W_A: `w_a_${ts}`,
    W_B: `w_b_${ts}`,
    W_AD: `w_ad_${ts}`,
    W_IG: `w_ig_${ts}`,
    MENU: `menu_${ts}`,
    
    // Knowledge Base
    FAQ_NODE: `faq_${ts}`,
    RET_NODE: `ret_p_${ts}`,
    FB_NODE: `fallback_${ts}`,

    // Discovery
    CATALOG: `cat_${ts}`,
    DETAIL_PREFIX: `det_${ts}_`,
    
    // Operations
    ORDER_STATUS: `ord_stat_${ts}`,
    CANCEL_START: `can_start_${ts}`,
    CANCEL_LOGIC: `can_log_${ts}`,
    CANCEL_REASON: `can_reason_${ts}`,
    CANCEL_ALREADY_SHIPPED: `can_err_ship_${ts}`,
    CANCEL_FINAL: `can_final_${ts}`,
    
    RETURN_START: `ret_start_${ts}`,
    RETURN_POLICY: `ret_pol_${ts}`,
    RETURN_FORM: `ret_form_${ts}`,
    RETURN_SUCCESS: `ret_succ_${ts}`,
    
    REFUND_START: `ref_start_${ts}`,
    REFUND_STATUS: `ref_stat_${ts}`,
    REFUND_FINAL: `ref_fin_${ts}`,
    
    // Support & Routing
    SUPPORT_MENU: `sup_menu_${ts}`,
    SUPPORT_HOURS: `sup_hours_${ts}`,
    SCHED_NODE: `sched_${ts}`,
    ESC_LOGIC: `esc_log_${ts}`,
    ESC_CAP: `esc_cap_${ts}`,
    ESC_TAG: `esc_tag_${ts}`,
    ESC_ALERT: `esc_alt_${ts}`,
    ESC_FINAL: `esc_fin_${ts}`,
    
    // Loyalty & Segmentation
    LOY_MENU: `loy_menu_${ts}`,
    LOY_POINTS: `loy_pts_${ts}`,
    LOY_REFER: `loy_ref_${ts}`,
    LOY_SEG: `loy_seg_${ts}`,
    LOY_VIP_PERK: `loy_vip_p_${ts}`,
    LOY_NEW_NUDGE: `loy_new_n_${ts}`,
    
    // Automation (Visual Sequence)
    CART_TR: `c_tr_${ts}`,
    CART_SEQ: `c_seq_${ts}`,
    CONF_TR: `conf_tr_${ts}`,
    CONF_MSG: `conf_msg_${ts}`,
    COD_NUDGE: `cod_${ts}`,
    
    // Reviews
    REV_TRIG: `rev_trig_${ts}`,
    REV_ASK: `rev_ask_${ts}`,
    REV_LOGIC: `rev_log_${ts}`,
    REV_POS_LINK: `rev_pos_l_${ts}`,
    REV_NEG_SUPPORT: `rev_neg_s_${ts}`,

    // Enterprise Expansion: B2B
    B2B_TRIGGER: `b2b_trig_${ts}`,
    B2B_FORM: `b2b_form_${ts}`,
    B2B_CAPTURE_IND: `b2b_ind_${ts}`,
    B2B_TAG: `b2b_tag_${ts}`,
    B2B_ALERT: `b2b_alt_${ts}`,
    B2B_CONFIRM: `b2b_conf_${ts}`,

    // Enterprise Expansion: Warranty
    WARRANTY_HUB: `war_hub_${ts}`,
    WARRANTY_REG_SERIAL: `war_reg_s_${ts}`,
    WARRANTY_REG_DATE: `war_reg_d_${ts}`,
    WARRANTY_REG_TAG: `war_tag_${ts}`,
    WARRANTY_REG_SUCCESS: `war_succ_${ts}`,
    WARRANTY_LOOKUP_SER: `war_look_s_${ts}`,
    WARRANTY_LOOKUP_EXEC: `war_look_e_${ts}`
  };

  const LAYOUT = {
    ENTRY_X: 600,
    KNOWLEDGE_X: 200,
    MENU_X: 1000,
    ORDER_X: 1400,
    PRODUCT_X: 1800,
    ESCALATE_X: 2400,
    OPS_X: 3000,
    LOYALTY_X: 3600,
    AUTO_X: -600,
    REVIEW_X: 200,
    Y_STEP: 300
  };

  const nodes = [];
  const edges = [];

  // --- 0. CONTEXT & PERSONA (1 Node) ---
  nodes.push({
    id: IDS.PERSONA,
    type: "persona",
    position: { x: LAYOUT.ENTRY_X, y: -400 },
    data: { 
      label: `Brand Persona: ${selectedPersona.label}`, 
      personaType: selectedPersona.type,
      activePersona: activePersona
    }
  });

  // --- 1. ENTRY MODULE (8 Nodes) ---
  nodes.push(
    { id: IDS.TRIGGER, type: "trigger", position: { x: LAYOUT.ENTRY_X, y: -200 }, data: { label: "Main Trigger", triggerType: "keyword", keywords: ["hi", "hello", "menu", "start"] } },
    { id: IDS.AD_TRIGGER, type: "trigger", position: { x: LAYOUT.ENTRY_X - 400, y: -200 }, data: { label: "Meta Ad Entry", triggerType: "meta_ad", keywords: ["ad_click"] } },
    { id: IDS.IG_TRIGGER, type: "trigger", position: { x: LAYOUT.ENTRY_X + 1200, y: -200 }, data: { label: "IG Mention", triggerType: "ig_story_mention", keywords: ["story_mention"] } },
    
    { id: IDS.W_AD, type: "message", position: { x: LAYOUT.ENTRY_X - 400, y: LAYOUT.Y_STEP }, data: { label: "Ad Welcome", text: content.ad_welcome || `Thanks for clicking our ad! How can I help you?` } },
    { id: IDS.W_IG, type: "message", position: { x: LAYOUT.ENTRY_X + 1200, y: LAYOUT.Y_STEP }, data: { label: "IG Welcome", text: content.ig_welcome || `Thanks for the mention! Glad you're here.` } },

    { id: IDS.AB_TEST, type: "ab_test", position: { x: LAYOUT.ENTRY_X, y: LAYOUT.Y_STEP }, data: { label: "Split Test Welcome", variantA: "Tone A", variantB: "Tone B" } },
    { id: IDS.W_A, type: "message", position: { x: LAYOUT.ENTRY_X - 250, y: LAYOUT.Y_STEP * 2.5 }, data: { label: "Welcome A", text: content.welcome_a } },
    { id: IDS.W_B, type: "message", position: { x: LAYOUT.ENTRY_X + 250, y: LAYOUT.Y_STEP * 2.5 }, data: { label: "Welcome B", text: content.welcome_b } }
  );
  edges.push(
    { id: `e_p_tr`, source: IDS.PERSONA, target: IDS.TRIGGER },
    { id: `e_tr_ab`, source: IDS.TRIGGER, target: IDS.AB_TEST },
    { id: `e_ad_wa`, source: IDS.AD_TRIGGER, target: IDS.W_AD },
    { id: `e_ig_wa`, source: IDS.IG_TRIGGER, target: IDS.W_IG },
    { id: `e_ab_wa`, source: IDS.AB_TEST, target: IDS.W_A, sourceHandle: "a" },
    { id: `e_ab_wb`, source: IDS.AB_TEST, target: IDS.W_B, sourceHandle: "b" }
  );

  // --- 1.2 KNOWLEDGE BASE (3 Nodes) ---
  nodes.push(
    { id: IDS.FAQ_NODE, type: "message", position: { x: LAYOUT.KNOWLEDGE_X, y: LAYOUT.Y_STEP * 4 }, data: { label: "General FAQs", text: faqText || content.faq_response || "Our delivery takes 3-5 days. Support is available 24/7." } },
    { id: IDS.RET_NODE, type: "message", position: { x: LAYOUT.KNOWLEDGE_X, y: LAYOUT.Y_STEP * 5 }, data: { label: "Returns Policy", text: returnsInfo || content.returns_policy_short } },
    { id: IDS.FB_NODE, type: "message", position: { x: LAYOUT.KNOWLEDGE_X, y: LAYOUT.Y_STEP * 6 }, data: { label: "AI Fallback", text: fallbackMessage } }
  );
  edges.push(
    { id: `e_w_ad_m`, source: IDS.W_AD, target: IDS.MENU },
    { id: `e_w_ig_m`, source: IDS.W_IG, target: IDS.MENU }
  );

  // --- 2. HUB (1 Node) ---
  nodes.push({
    id: IDS.MENU,
    type: "interactive",
    position: { x: LAYOUT.MENU_X, y: LAYOUT.Y_STEP * 4 },
    data: {
      label: "Main Hub",
      interactiveType: "list",
      text: content.product_menu_text,
      buttonText: "Open Menu",
      sections: [{
        title: "Services",
        rows: [
          { id: "discovery", title: "🛍️ Shop Collection" },
          { id: "orders", title: "📦 Order Status" },
          { id: "ops", title: "⚙️ Return & Cancel" },
          { id: "loyalty", title: "💎 Rewards Hub" },
          { id: "support", title: "🎧 Customer Help" },
          { id: "faq", title: "❓ General FAQs" }
        ]
      }]
    }
  });
  edges.push(
    { id: `e_wa_menu`, source: IDS.W_A, target: IDS.MENU },
    { id: `e_wb_menu`, source: IDS.W_B, target: IDS.MENU },
    { id: `e_m_faq`, source: IDS.MENU, target: IDS.FAQ_NODE, sourceHandle: "faq" }
  );

  // --- 3. DISCOVERY (16 Nodes) ---
  if (products.length === 0) {
    nodes.push({
      id: IDS.CATALOG,
      type: "interactive",
      position: { x: LAYOUT.PRODUCT_X, y: LAYOUT.Y_STEP * 4 },
      data: {
        label: "Store Redirect",
        interactiveType: "button",
        text: "We are currently updating our WhatsApp catalog. Check out our latest collection on our website!",
        buttonsList: [{ id: "menu", title: "⬅️ Main Menu" }]
      }
    });
    edges.push(
      { id: `e_menu_cat`, source: IDS.MENU, target: IDS.CATALOG, sourceHandle: "discovery" },
      { id: `e_cat_m`, source: IDS.CATALOG, target: IDS.MENU, sourceHandle: "menu" }
    );
  } else {
    // Categorization logic
    const categories = Array.from(new Set(products.map(p => p.category || "General")));
    
    if (categories.length > 1) {
      nodes.push({
        id: IDS.CATALOG,
        type: "interactive",
        position: { x: LAYOUT.PRODUCT_X, y: LAYOUT.Y_STEP * 4 },
        data: {
          label: "Category Menu",
          interactiveType: "list",
          text: "Select a category to browse:",
          rows: categories.slice(0, 10).map(cat => ({ id: `cat_${cat.toLowerCase().replace(/\s+/g, '_')}`, title: cat }))
        }
      });
      edges.push({ id: `e_menu_cat`, source: IDS.MENU, target: IDS.CATALOG, sourceHandle: "discovery" });

      categories.forEach((cat, idx) => {
        const catId = `cat_list_${idx}_${ts}`;
        const catProducts = products.filter(p => (p.category || "General") === cat).slice(0, 10);
        
        nodes.push({
          id: catId,
          type: "interactive",
          position: { x: LAYOUT.PRODUCT_X + 400, y: LAYOUT.Y_STEP * (4 + idx) },
          data: {
            label: `Cat: ${cat}`,
            interactiveType: "list",
            text: `Showing our best ${cat} items:`,
            rows: catProducts.map((p, pi) => ({ id: `p_${idx}_${pi}`, title: p.name.substring(0, 24) }))
          }
        });
        edges.push({ id: `e_cat_${idx}`, source: IDS.CATALOG, target: catId, sourceHandle: `cat_${cat.toLowerCase().replace(/\s+/g, '_')}` });

        catProducts.forEach((p, pi) => {
          const pId = `${IDS.DETAIL_PREFIX}${idx}_${pi}`;
          nodes.push({
            id: pId,
            type: "interactive",
            position: { x: LAYOUT.PRODUCT_X + 800, y: LAYOUT.Y_STEP * (4 + idx + pi/2) },
            data: {
              label: `Prod: ${p.name}`,
              interactiveType: "button",
              text: `*${p.name}*\n\nPrice: ₹${p.price}\n\n${p.description || "Premium quality guaranteed."}`,
              imageUrl: p.imageUrl,
              buttonsList: [{ id: "buy", title: "🛒 Buy on Web" }, { id: "menu", title: "⬅️ Main Menu" }]
            }
          });
          edges.push(
            { id: `e_cl_${idx}_p${pi}`, source: catId, target: pId, sourceHandle: `p_${idx}_${pi}` },
            { id: `e_p${idx}_${pi}_menu`, source: pId, target: IDS.MENU, sourceHandle: "menu" }
          );
        });
      });
    } else {
      nodes.push({
        id: IDS.CATALOG,
        type: "interactive",
        position: { x: LAYOUT.PRODUCT_X, y: LAYOUT.Y_STEP * 4 },
        data: {
          label: "Simple Catalog",
          interactiveType: "list",
          text: content.product_menu_text,
          rows: products.slice(0, 15).map((p, i) => ({ id: `p_${i}`, title: (p.name || "Product").substring(0, 24) }))
        }
      });
      edges.push({ id: `e_menu_cat`, source: IDS.MENU, target: IDS.CATALOG, sourceHandle: "discovery" });
    
      products.slice(0, 15).forEach((p, i) => {
        const pId = `${IDS.DETAIL_PREFIX}${i}`;
        nodes.push({
          id: pId,
          type: "interactive",
          position: { x: LAYOUT.PRODUCT_X + 400, y: LAYOUT.Y_STEP * (4 + i) },
          data: {
            label: `Prod: ${p.name}`,
            interactiveType: "button",
            text: `*${p.name}*\n\nPrice: ₹${p.price}\n\n${p.description || "Premium quality guaranteed."}`,
            imageUrl: p.imageUrl,
            buttonsList: [{ id: "buy", title: "🛒 Buy on Web" }, { id: "menu", title: "⬅️ Main Menu" }]
          }
        });
        edges.push(
          { id: `e_cat_p${i}`, source: IDS.CATALOG, target: pId, sourceHandle: `p_${i}` },
          { id: `e_p${i}_menu`, source: pId, target: IDS.MENU, sourceHandle: "menu" }
        );
      });
    }
  }

  // --- 4. OPERATIONS (14 Nodes) ---
  nodes.push(
    { id: IDS.ORDER_STATUS, type: "shopify_call", position: { x: LAYOUT.ORDER_X, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "Sync Status", action: "ORDER_STATUS" } },
    { id: IDS.CANCEL_START, type: "interactive", position: { x: LAYOUT.OPS_X, y: LAYOUT.Y_STEP * 4 }, data: { label: "Verify Cancellation", interactiveType: "button", text: "Are you sure you want to cancel order?", buttonsList: [{id:"yes", title:"Yes, Cancel"},{id:"no", title:"Keep It"}] } },
    { id: IDS.CANCEL_LOGIC, type: "logic", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 4 }, data: { label: "Check Shipping", variable: "is_shipped", operator: "equals", value: "false" } },
    { id: IDS.CANCEL_REASON, type: "capture_input", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 3.5 }, data: { label: "Ask Reason", variable: "cancel_reason", text: "Please tell us why you are cancelling?" } },
    { id: IDS.CANCEL_ALREADY_SHIPPED, type: "message", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "In Transit Error", text: "Sorry! Your order is already shipped and cannot be cancelled now. 🚚" } },
    { id: IDS.CANCEL_FINAL, type: "shopify_call", position: { x: LAYOUT.OPS_X + 1200, y: LAYOUT.Y_STEP * 3.5 }, data: { label: "Process Cancel", action: "CANCEL_ORDER" } },
    
    { id: IDS.RETURN_START, type: "interactive", position: { x: LAYOUT.OPS_X, y: LAYOUT.Y_STEP * 6 }, data: { label: "Return Hub", interactiveType: "button", text: "Need to return something?", buttonsList: [{id:"pol", title:"Policy"},{id:"form", title:"Start Return"}] } },
    { id: IDS.RETURN_POLICY, type: "message", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 6 }, data: { label: "Return T&C", text: content.returns_policy_short } },
    { id: IDS.RETURN_FORM, type: "capture_input", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 7 }, data: { label: "Capture Photo", variable: "return_photo", text: "Please upload a photo of the product damange." } },
    { id: IDS.RETURN_SUCCESS, type: "message", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 7 }, data: { label: "Confirm Recpt", text: "We've received your request! Our team will verify and arrange pickup." } },
    
    { id: IDS.REFUND_START, type: "interactive", position: { x: LAYOUT.OPS_X, y: LAYOUT.Y_STEP * 9 }, data: { label: "Refund Hub", interactiveType: "button", text: "Check refund status?", buttonsList:[{id:"check", title:"Check"},{id:"menu", title:"Back"}] } },
    { id: IDS.REFUND_STATUS, type: "shopify_call", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 9 }, data: { label: "Check Refunds", action: "ORDER_REFUND_STATUS" } },
    { id: IDS.REFUND_FINAL, type: "message", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 9 }, data: { label: "Refund Policy", text: content.refund_policy_short } }
  );
  edges.push(
    { id: `e_m_ord`, source: IDS.MENU, target: IDS.ORDER_STATUS, sourceHandle: "orders" },
    { id: `e_m_ops`, source: IDS.MENU, target: IDS.CANCEL_START, sourceHandle: "ops" },
    { id: `e_can_y`, source: IDS.CANCEL_START, target: IDS.CANCEL_LOGIC, sourceHandle: "yes" },
    { id: `e_log_t`, source: IDS.CANCEL_LOGIC, target: IDS.CANCEL_REASON, sourceHandle: "true" },
    { id: `e_log_f`, source: IDS.CANCEL_LOGIC, target: IDS.CANCEL_ALREADY_SHIPPED, sourceHandle: "false" },
    { id: `e_can_fin`, source: IDS.CANCEL_REASON, target: IDS.CANCEL_FINAL },
    { id: `e_ret_sh`, source: IDS.RETURN_START, target: IDS.RETURN_FORM, sourceHandle: "form" },
    { id: `e_ret_end`, source: IDS.RETURN_FORM, target: IDS.RETURN_SUCCESS }
  );

  // --- 4.2 WARRANTY MODULE (7 Nodes) ---
  nodes.push(
    { id: IDS.WARRANTY_HUB, type: "interactive", position: { x: LAYOUT.OPS_X, y: LAYOUT.Y_STEP * 11 }, data: { label: "Warranty Hub", interactiveType: "button", text: content.warranty_welcome || `Protect your purchase! Our products come with ${warrantyDuration} warranty.`, buttonsList: [{id:"reg", title:"Register"},{id:"check", title:"Check Status"}] } },
    { id: IDS.WARRANTY_REG_SERIAL, type: "capture_input", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 11 }, data: { label: "Capture Serial", variable: "warranty_serial", text: "Please enter your Product Serial Number or Order ID." } },
    { id: IDS.WARRANTY_REG_DATE, type: "capture_input", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 11 }, data: { label: "Capture Date", variable: "purchase_date", text: "Please provide the date of purchase (DD/MM/YYYY)." } },
    { id: IDS.WARRANTY_REG_TAG, type: "tag_lead", position: { x: LAYOUT.OPS_X + 1200, y: LAYOUT.Y_STEP * 11 }, data: { label: "Tag: Warranted", action: "add", tag: "warranty-enrolled" } },
    { id: IDS.WARRANTY_REG_SUCCESS, type: "message", position: { x: LAYOUT.OPS_X + 1600, y: LAYOUT.Y_STEP * 11 }, data: { label: "Reg Success", text: `Success! Your warranty is now active for ${warrantyDuration}. We've saved your details.` } },
    
    { id: IDS.WARRANTY_LOOKUP_SER, type: "capture_input", position: { x: LAYOUT.OPS_X + 400, y: LAYOUT.Y_STEP * 12.5 }, data: { label: "Lookup Prompt", variable: "lookup_serial", text: content.warranty_lookup_prompt || "Enter your serial number to check status." } },
    { id: IDS.WARRANTY_LOOKUP_EXEC, type: "warranty_lookup", position: { x: LAYOUT.OPS_X + 800, y: LAYOUT.Y_STEP * 12.5 }, data: { label: "Engine Lookup", duration: warrantyDuration, policy: warrantyPolicy } }
  );
  edges.push(
    { id: `e_m_war`, source: IDS.MENU, target: IDS.WARRANTY_HUB, sourceHandle: "ops" }, // Hub choice
    { id: `e_war_reg`, source: IDS.WARRANTY_HUB, target: IDS.WARRANTY_REG_SERIAL, sourceHandle: "reg" },
    { id: `e_war_s_d`, source: IDS.WARRANTY_REG_SERIAL, target: IDS.WARRANTY_REG_DATE },
    { id: `e_war_d_t`, source: IDS.WARRANTY_REG_DATE, target: IDS.WARRANTY_REG_TAG },
    { id: `e_war_t_s`, source: IDS.WARRANTY_REG_TAG, target: IDS.WARRANTY_REG_SUCCESS },
    { id: `e_war_look`, source: IDS.WARRANTY_HUB, target: IDS.WARRANTY_LOOKUP_SER, sourceHandle: "check" },
    { id: `e_war_l_ex`, source: IDS.WARRANTY_LOOKUP_SER, target: IDS.WARRANTY_LOOKUP_EXEC }
  );

  // --- 4.3 B2B NEXUS (6 Nodes) ---
  if (b2bEnabled) {
    nodes.push(
      { id: IDS.B2B_TRIGGER, type: "trigger", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * -1 }, data: { label: "B2B Intent", triggerType: "keyword", keywords: ["wholesale", "bulk", "b2b", "bulk order", "partnership"] } },
      { id: IDS.B2B_FORM, type: "capture_input", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * 0.5 }, data: { label: "Company Name", variable: "b2b_company", text: "Exciting! We love bulk partners. What's your company/store name?" } },
      { id: IDS.B2B_CAPTURE_IND, type: "capture_input", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * 2 }, data: { label: "Volume Inquiry", variable: "b2b_volume", text: `Roughly how many units are you looking for? (Min ${wizardData.b2bThreshold || 10} units for wholesale pricing)` } },
      { id: IDS.B2B_TAG, type: "tag_lead", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * 3.5 }, data: { label: "Tag: B2B Lead", action: "add", tag: "b2b-prospect" } },
      { id: IDS.B2B_ALERT, type: "admin_alert", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * 5 }, data: { label: "Enterprise Alert", priority: "high", topic: "NEW B2B WHOLESALE LEAD", phone: wizardData.b2bAdminPhone } },
      { id: IDS.B2B_CONFIRM, type: "message", position: { x: LAYOUT.PRODUCT_X - 400, y: LAYOUT.Y_STEP * 6.5 }, data: { label: "B2B Wait", text: "Information captured! Our wholesale team will reach out to you within 2 hours with a special quote. 👔" } }
    );
    edges.push(
      { id: `e_b2b_tr`, source: IDS.B2B_TRIGGER, target: IDS.B2B_FORM },
      { id: `e_b2b_f_i`, source: IDS.B2B_FORM, target: IDS.B2B_CAPTURE_IND },
      { id: `e_b2b_i_t`, source: IDS.B2B_CAPTURE_IND, target: IDS.B2B_TAG },
      { id: `e_b2b_t_a`, source: IDS.B2B_TAG, target: IDS.B2B_ALERT },
      { id: `e_b2b_a_c`, source: IDS.B2B_ALERT, target: IDS.B2B_CONFIRM }
    );
  }

  // --- 5. SUPPORT & ROUTING (8 Nodes) ---
  nodes.push(
    { id: IDS.SUPPORT_MENU, type: "interactive", position: { x: LAYOUT.ESCALATE_X, y: LAYOUT.Y_STEP * 4 }, data: { label: "Support Dispatch", interactiveType: "button", text: "How can we help today?", buttonsList:[{id:"talk", title:"Talk to Human"},{id:"hrs", title:"Check Hours"}] } },
    { id: IDS.SUPPORT_HOURS, type: "message", position: { x: LAYOUT.ESCALATE_X, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "Shop Hours", text: "We are available Mon-Sat, 10 AM - 7 PM." } },
    { id: IDS.SCHED_NODE, type: "schedule", position: { x: LAYOUT.ESCALATE_X + 400, y: LAYOUT.Y_STEP * 4 }, data: { 
       label: "Check Availability", 
       openTime, 
       closeTime, 
       days: workingDays,
       closedMessage: "Our agents are currently offline, but our AI is here to help!" 
    } },
    { id: IDS.ESC_LOGIC, type: "logic", position: { x: LAYOUT.ESCALATE_X + 800, y: LAYOUT.Y_STEP * 3 }, data: { label: "Name Known?", variable: "name", operator: "exists" } },
    { id: IDS.ESC_CAP, type: "capture_input", position: { x: LAYOUT.ESCALATE_X + 1200, y: LAYOUT.Y_STEP * 2 }, data: { label: "Ask Identity", variable: "name", text: "May I have your name to connect you?" } },
    { id: IDS.ESC_TAG, type: "tag_lead", position: { x: LAYOUT.ESCALATE_X + 1200, y: LAYOUT.Y_STEP * 4 }, data: { label: "Mark: Pending", action: "add", tag: "pending-human" } },
    { id: IDS.ESC_ALERT, type: "admin_alert", position: { x: LAYOUT.ESCALATE_X + 1600, y: LAYOUT.Y_STEP * 4 }, data: { label: "Alert Team", priority: "high", topic: "High Priority Human Requested" } },
    { id: IDS.ESC_FINAL, type: "message", position: { x: LAYOUT.ESCALATE_X + 2000, y: LAYOUT.Y_STEP * 4 }, data: { label: "Wait Conf", text: content.agent_handoff_msg } }
  );
  edges.push(
    { id: `e_m_sup`, source: IDS.MENU, target: IDS.SUPPORT_MENU, sourceHandle: "support" },
    { id: `e_sup_t`, source: IDS.SUPPORT_MENU, target: IDS.SCHED_NODE, sourceHandle: "talk" },
    { id: `e_sch_o`, source: IDS.SCHED_NODE, target: IDS.ESC_LOGIC, sourceHandle: "open" },
    { id: `e_sch_c`, source: IDS.SCHED_NODE, target: IDS.FB_NODE, sourceHandle: "closed" },
    { id: `e_esc_t`, source: IDS.ESC_LOGIC, target: IDS.ESC_TAG, sourceHandle: "true" },
    { id: `e_esc_f`, source: IDS.ESC_LOGIC, target: IDS.ESC_CAP, sourceHandle: "false" },
    { id: `e_cap_t`, source: IDS.ESC_CAP, target: IDS.ESC_TAG },
    { id: `e_tag_alt`, source: IDS.ESC_TAG, target: IDS.ESC_ALERT },
    { id: `e_alt_fin`, source: IDS.ESC_ALERT, target: IDS.ESC_FINAL }
  );

  // --- 6. LOYALTY & SEGMENTATION (7 Nodes) ---
  nodes.push(
    { id: IDS.LOY_MENU, type: "interactive", position: { x: LAYOUT.LOYALTY_X, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "Rewards Hub", interactiveType: "list", text: content.loyalty_welcome, rows:[{id:"pts", title:"Balance"},{id:"ref", title:"Refer"},{id:"vip", title:"VIP Status"}] } },
    { id: IDS.LOY_POINTS, type: "message", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 3.5 }, data: { label: "Wallet Check", text: content.loyalty_points_msg } },
    { id: IDS.LOY_REFER, type: "message", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "Referral Program", text: content.referral_msg } },
    { id: IDS.LOY_SEG, type: "segment", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "Profile Divider", segments: [{id: "vip", label: "VIP Only", type: "vip"}, {id: "new", label: "New Member", type: "new"}] } },
    { id: IDS.LOY_VIP_PERK, type: "message", position: { x: LAYOUT.LOYALTY_X + 800, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "VIP Perk", text: "You are a VIP! Exclusive 20% discount code: VIP20" } },
    { id: IDS.LOY_NEW_NUDGE, type: "message", position: { x: LAYOUT.LOYALTY_X + 800, y: LAYOUT.Y_STEP * 6.5 }, data: { label: "Member Intro", text: "You're getting closer! Shop for ₹500 more to unlock VIP perks. 🚀" } }
  );
  edges.push(
    { id: `e_m_loy`, source: IDS.MENU, target: IDS.LOY_MENU, sourceHandle: "loyalty" },
    { id: `e_loy_p`, source: IDS.LOY_MENU, target: IDS.LOY_POINTS, sourceHandle: "pts" },
    { id: `e_loy_r`, source: IDS.LOY_MENU, target: IDS.LOY_REFER, sourceHandle: "ref" },
    { id: `e_loy_v`, source: IDS.LOY_MENU, target: IDS.LOY_SEG, sourceHandle: "vip" },
    { id: `e_seg_v`, source: IDS.LOY_SEG, target: IDS.LOY_VIP_PERK, sourceHandle: "vip" },
    { id: `e_seg_n`, source: IDS.LOY_SEG, target: IDS.LOY_NEW_NUDGE, sourceHandle: "new" }
  );

  // --- 7. AUTOMATION & VISUAL SEQUENCE (6 Nodes) ---
  nodes.push(
    { id: IDS.CART_TR, type: "trigger", position: { x: LAYOUT.AUTO_X, y: LAYOUT.Y_STEP * 3 }, data: { label: "Checkout Abandoned", triggerType: "shopify_event", event: "checkout_abandoned" } },
    { id: IDS.CART_SEQ, type: "sequence", position: { x: LAYOUT.AUTO_X + 400, y: LAYOUT.Y_STEP * 3 }, data: { label: "Recovery Drip", steps: [{id:"1", text: content.cart_recovery_1, delay: 15}, {id:"2", text: content.cart_recovery_2, delay: 120}, {id:"3", text: content.cart_recovery_3, delay: 1440}] } },
    { id: IDS.CONF_TR, type: "trigger", position: { x: LAYOUT.AUTO_X, y: LAYOUT.Y_STEP * 6 }, data: { label: "Order Created", triggerType: "shopify_event", event: "order_created" } },
    { id: IDS.CONF_MSG, type: "message", position: { x: LAYOUT.AUTO_X + 400, y: LAYOUT.Y_STEP * 6 }, data: { label: "Confirmation", text: content.order_confirmed_msg } },
    { id: IDS.COD_NUDGE, type: "cod_prepaid", position: { x: LAYOUT.AUTO_X + 800, y: LAYOUT.Y_STEP * 6 }, data: { label: "Prepay & Save", discountAmount: 50, text: content.cod_nudge } }
  );
  edges.push(
    { id: `e_cart_s`, source: IDS.CART_TR, target: IDS.CART_SEQ },
    { id: `e_pay_conf`, source: IDS.CONF_TR, target: IDS.CONF_MSG },
    { id: `e_conf_cod`, source: IDS.CONF_MSG, target: IDS.COD_NUDGE }
  );

  // --- 8. REVIEWS & TAGGING (3 Nodes) ---
  nodes.push(
    { id: IDS.REV_TRIG, type: "trigger", position: { x: LAYOUT.REVIEW_X - 400, y: LAYOUT.Y_STEP * 9 }, data: { label: "Delivered Signal", triggerType: "shopify_event", event: "order_fulfilled" } },
    { id: IDS.REV_ASK, type: "review", position: { x: LAYOUT.REVIEW_X, y: LAYOUT.Y_STEP * 9 }, data: { label: "Sentiment Hub", text: content.sentiment_ask, rewardText: "COUPON15" } }
  );
  edges.push(
    { id: `e_rev_start`, source: IDS.REV_TRIG, target: IDS.REV_ASK }
  );

  return { nodes, edges };
}

function buildDefaultContent(businessName, botName, products, ops = {}) {
  const { referralPoints = 500, signupPoints = 100 } = ops;
  return {
    welcome_a: `Welcome to *${businessName}*! 👋 I'm ${botName}, your personal assistant. How can I help you today?`,
    welcome_b: `Hello! Looking for something special at *${businessName}*? 🛍️ check out our catalog below!`,
    product_menu_text: "Broaden your horizon! Choose an option from our shop menu:",
    order_status_msg: "📦 *Order Tracking*\n\nYour order is currently in transit.\nProgress: [■■■□] *Dispatched*\n\nExpected delivery: 2-3 business days. 🚚",
    agent_handoff_msg: "Understood! I've priority-paged our customer success team for you. Someone will be with you shortly. 🎧",
    sentiment_ask: "How was your experience with us? We'd love to hear from you! 😊",
    review_positive: "That's wonderful! We value your feedback. Would you mind sharing your love on Google?",
    review_negative: "Oh, I'm sorry to hear that. 😔 Let me connect you with an expert right away to fix this for you.",
    returns_policy_short: "We offer a 7-day hassle-free return policy for all unused products. 🔄",
    refund_policy_short: "Refunds are processed within 5-7 business days after the product arrives back. 💳",
    installation_msg: "Need help? our team can guide you or schedule an expert visit. 🛠️",
    loyalty_welcome: `Welcome to our Rewards Program! ✨ Earn ${signupPoints} points just for joining, and more on every purchase.`,
    loyalty_points_msg: `You have points waiting! That's equivalent to ₹54 off on your next order. 💎`,
    referral_msg: `Invite a friend and get *${referralPoints} Points* when they make their first purchase! 🎁`,
    cod_nudge: "Save ₹50 extra by paying online now! Avoid the COD hassle. 💳"
  };
}

async function generateSystemPrompt(client, wizardData) {
  const { businessName, businessDescription, botName, tone, botLanguage, products = [] } = wizardData;
  const prompt = `Write a professional WhatsApp chatbot system prompt for ${businessName}.
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${tone}
Language: ${botLanguage}
Products: ${products.slice(0, 5).map(p => p.name).join(", ")}
`;
  try {
    const res = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    return res || `Default prompt for ${businessName}`;
  } catch (_) {
    return `Default system prompt for ${businessName}`;
  }
}

function getPrebuiltTemplates(wizardData) {
  const { businessName, googleReviewUrl } = wizardData;
  return [
    {
      name:     `order_confirmation_msg`,
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `✅ Your order #{{1}} from ${businessName} is confirmed!\n\nItems: {{2}} | Total: ₹{{3}}\n\nWe'll notify you when it ships! 📦`,
      variables: ["order_id", "cart_items", "order_total"],
      description: "Sent immediately after order placed",
      required:  true
    },
    ...(googleReviewUrl ? [{
      id:       "review_request",
      name:     `post_delivery_review`,
      category: "MARKETING",
      language: "en",
      status:   "not_submitted",
      body:     `Hi {{1}}! How was your experience with ${businessName}? 😊\n\nPlease leave us a quick review — it takes just 30 seconds:\n${googleReviewUrl}`,
      variables: ["customer_name"],
      description: "Sent 4 days after delivery",
      required:  false
    }] : []),
    {
      id:       "admin_handoff_alert",
      name:     "admin_human_alert",
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `🚨 *Human Agent Requested!*\n\nCustomer: {{1}} ({{2}})\nMessage: {{3}}\n\nReply to them now: https://whatsapp.facebook.com/{{4}}`,
      variables: ["customer_name", "customer_phone", "last_message", "waba_id"],
      description: "Sent to Admin when a human is requested",
      required:  true
    }
  ];
}

module.exports = { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates };
