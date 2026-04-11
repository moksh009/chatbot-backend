"use strict";

const { generateText } = require("./gemini");

/**
 * FLOW GENERATOR — Phase R2 REFINEMENT
 * Takes wizard form data and generates a complete 50+ node enterprise flow.
 *
 * @param {Object} client     - Client document
 * @param {Object} wizardData - Data from the onboarding wizard form
 * @returns {{ nodes, edges }}
 */
async function generateEcommerceFlow(client, wizardData) {
  const {
    businessName,
    businessDescription,
    products   = [],
    botName    = "Assistant",
    tone       = "friendly",
    botLanguage = "Hinglish",
    cartTiming = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl = "",
    adminPhone      = ""
  } = wizardData;

  // ── STEP 1: Generate message text via Gemini ──────────────────────────────
  let content = {};
  const prompt = `You are a world-class WhatsApp UX Architect for an Indian e-commerce brand.
Business: ${businessName}
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${tone}
Language: ${botLanguage} (Mix of English and local warmth)

Generate a JSON object for 25 different UI touchpoints.
REQUIRED KEYS:
"welcome_a", "welcome_b", "product_menu_text", "product_list_btn", 
"order_status_msg", "fallback_msg", "returns_policy_short", "refund_policy_short",
"cancellation_confirm", "cancellation_success", "installation_msg",
"loyalty_welcome", "loyalty_points_msg", "referral_msg",
"sentiment_ask", "review_positive", "review_negative",
"upsell_intro", "cross_sell_msg", "cart_recovery_1", "cart_recovery_2",
"cart_recovery_3", "cod_nudge", "order_confirmed_msg", "agent_handoff_msg"
`;

  try {
    const res = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    if (res) {
      const jsonStr = res.replace(/```json|```/g, "").trim();
      content = JSON.parse(jsonStr);
    }
  } catch (err) {
    console.warn("[FlowGenerator] AI failure, using hardcoded enterprise logic.");
  }

  // Merge with defaults
  content = { ...buildDefaultContent(businessName, botName, products), ...content };

  const ts = Date.now();
  const IDS = {
    // Entry
    TRIGGER: `trig_${ts}`,
    AB_TEST: `ab_${ts}`,
    W_A: `w_a_${ts}`,
    W_B: `w_b_${ts}`,
    MENU: `menu_${ts}`,
    
    // Discovery (1 + 15 = 16 nodes)
    CATALOG: `cat_${ts}`,
    DETAIL_PREFIX: `det_${ts}_`,
    
    // Operations - Order Status (1)
    ORDER_STATUS: `ord_stat_${ts}`,
    
    // Operations - Cancellation (5 nodes)
    CANCEL_START: `can_start_${ts}`,
    CANCEL_LOGIC: `can_log_${ts}`,
    CANCEL_REASON: `can_reason_${ts}`,
    CANCEL_ALREADY_SHIPPED: `can_err_ship_${ts}`,
    CANCEL_FINAL: `can_final_${ts}`,
    
    // Operations - Returns (4 nodes)
    RETURN_START: `ret_start_${ts}`,
    RETURN_POLICY: `ret_pol_${ts}`,
    RETURN_FORM: `ret_form_${ts}`,
    RETURN_SUCCESS: `ret_succ_${ts}`,
    
    // Operations - Refunds (3 nodes)
    REFUND_START: `ref_start_${ts}`,
    REFUND_STATUS: `ref_stat_${ts}`,
    REFUND_FINAL: `ref_fin_${ts}`,
    
    // Support Module (6 nodes)
    SUPPORT_MENU: `sup_menu_${ts}`,
    SUPPORT_HOURS: `sup_hours_${ts}`,
    ESC_LOGIC: `esc_log_${ts}`,
    ESC_CAP: `esc_cap_${ts}`,
    ESC_TAG: `esc_tag_${ts}`,
    ESC_ALERT: `esc_alt_${ts}`,
    ESC_FINAL: `esc_fin_${ts}`,
    
    // Loyalty Module (5 nodes)
    LOY_MENU: `loy_menu_${ts}`,
    LOY_POINTS: `loy_pts_${ts}`,
    LOY_REDEEM: `loy_red_${ts}`,
    LOY_REFER: `loy_ref_${ts}`,
    LOY_VIP: `loy_vip_${ts}`,
    
    // Automation Module (7 nodes)
    CART_TR: `c_tr_${ts}`,
    CART_1: `c1_${ts}`,
    CART_2: `c2_${ts}`,
    CART_3: `c3_${ts}`,
    CONF_TR: `conf_tr_${ts}`,
    CONF_MSG: `conf_msg_${ts}`,
    COD_NUDGE: `cod_${ts}`,
    
    // Reviews & Sentiment (5 nodes)
    REV_TRIG: `rev_trig_${ts}`,
    REV_ASK: `rev_ask_${ts}`,
    REV_LOGIC: `rev_log_${ts}`,
    REV_POS_LINK: `rev_pos_l_${ts}`,
    REV_NEG_SUPPORT: `rev_neg_s_${ts}`
  };

  const LAYOUT = {
    ENTRY_X: 600,
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

  // --- 1. ENTRY MODULE (4 Nodes) ---
  nodes.push(
    { id: IDS.TRIGGER, type: "trigger", position: { x: LAYOUT.ENTRY_X, y: 0 }, data: { label: "Main Trigger", triggerType: "keyword", keywords: ["hi", "hello", "menu", "start"] } },
    { id: IDS.AB_TEST, type: "ab_test", position: { x: LAYOUT.ENTRY_X, y: LAYOUT.Y_STEP }, data: { label: "Split Test Welcome", variantA: "Tone A", variantB: "Tone B" } },
    { id: IDS.W_A, type: "message", position: { x: LAYOUT.ENTRY_X - 250, y: LAYOUT.Y_STEP * 2 }, data: { label: "Welcome A", text: content.welcome_a } },
    { id: IDS.W_B, type: "message", position: { x: LAYOUT.ENTRY_X + 250, y: LAYOUT.Y_STEP * 2 }, data: { label: "Welcome B", text: content.welcome_b } }
  );
  edges.push(
    { id: `e_tr_ab`, source: IDS.TRIGGER, target: IDS.AB_TEST },
    { id: `e_ab_wa`, source: IDS.AB_TEST, target: IDS.W_A, sourceHandle: "a" },
    { id: `e_ab_wb`, source: IDS.AB_TEST, target: IDS.W_B, sourceHandle: "b" }
  );

  // --- 2. HUB (1 Node) ---
  nodes.push({
    id: IDS.MENU,
    type: "interactive",
    position: { x: LAYOUT.MENU_X, y: LAYOUT.Y_STEP * 3.5 },
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
          { id: "support", title: "🎧 Customer Help" }
        ]
      }]
    }
  });
  edges.push(
    { id: `e_wa_menu`, source: IDS.W_A, target: IDS.MENU },
    { id: `e_wb_menu`, source: IDS.W_B, target: IDS.MENU }
  );

  // --- 3. DISCOVERY (16 Nodes) ---
  nodes.push({
    id: IDS.CATALOG,
    type: "interactive",
    position: { x: LAYOUT.PRODUCT_X, y: LAYOUT.Y_STEP * 4 },
    data: {
      label: "Categorized Catalog",
      interactiveType: "list",
      text: "Select a category to browse our best-sellers:",
      rows: products.slice(0, 15).map((p, i) => ({ id: `p_${i}`, title: p.name.substring(0, 24) }))
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
        buttonsList: [
          { id: "buy", title: "🛒 Buy on Web" },
          { id: "menu", title: "⬅️ Main Menu" }
        ]
      }
    });
    edges.push(
      { id: `e_cat_p${i}`, source: IDS.CATALOG, target: pId, sourceHandle: `p_${i}` },
      { id: `e_p${i}_menu`, source: pId, target: IDS.MENU, sourceHandle: "menu" }
    );
  });

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
    { id: `e_can_no`, source: IDS.CANCEL_START, target: IDS.MENU, sourceHandle: "no" },
    { id: `e_log_t`, source: IDS.CANCEL_LOGIC, target: IDS.CANCEL_REASON, sourceHandle: "true" },
    { id: `e_log_f`, source: IDS.CANCEL_LOGIC, target: IDS.CANCEL_ALREADY_SHIPPED, sourceHandle: "false" },
    { id: `e_can_fin`, source: IDS.CANCEL_REASON, target: IDS.CANCEL_FINAL },
    
    { id: `e_ret_st`, source: IDS.RETURN_START, target: IDS.RETURN_POLICY, sourceHandle: "pol" },
    { id: `e_ret_sh`, source: IDS.RETURN_START, target: IDS.RETURN_FORM, sourceHandle: "form" },
    { id: `e_ret_end`, source: IDS.RETURN_FORM, target: IDS.RETURN_SUCCESS },
    
    { id: `e_ref_st`, source: IDS.REFUND_START, target: IDS.REFUND_STATUS, sourceHandle: "check" }
  );

  // --- 5. SUPPORT (7 Nodes) ---
  nodes.push(
    { id: IDS.SUPPORT_MENU, type: "interactive", position: { x: LAYOUT.ESCALATE_X, y: LAYOUT.Y_STEP * 4 }, data: { label: "Support Dispatch", interactiveType: "button", text: "How can we help today?", buttonsList:[{id:"talk", title:"Talk to Human"},{id:"hrs", title:"Check Hours"}] } },
    { id: IDS.SUPPORT_HOURS, type: "message", position: { x: LAYOUT.ESCALATE_X, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "Shop Hours", text: "We are available Mon-Sat, 10 AM - 7 PM." } },
    { id: IDS.ESC_LOGIC, type: "logic", position: { x: LAYOUT.ESCALATE_X + 400, y: LAYOUT.Y_STEP * 4 }, data: { label: "Name Known?", variable: "name", operator: "exists" } },
    { id: IDS.ESC_CAP, type: "capture_input", position: { x: LAYOUT.ESCALATE_X + 800, y: LAYOUT.Y_STEP * 3 }, data: { label: "Ask Identity", variable: "name", text: "May I have your name to connect you?" } },
    { id: IDS.ESC_TAG, type: "tag_lead", position: { x: LAYOUT.ESCALATE_X + 800, y: LAYOUT.Y_STEP * 5 }, data: { label: "Mark: Pending", action: "add", tag: "pending-human" } },
    { id: IDS.ESC_ALERT, type: "admin_alert", position: { x: LAYOUT.ESCALATE_X + 1200, y: LAYOUT.Y_STEP * 4 }, data: { label: "Alert Team", recipientPhone: adminPhone, priority: "high" } },
    { id: IDS.ESC_FINAL, type: "message", position: { x: LAYOUT.ESCALATE_X + 1600, y: LAYOUT.Y_STEP * 4 }, data: { label: "Wait Conf", text: content.agent_handoff_msg } }
  );
  edges.push(
    { id: `e_m_sup`, source: IDS.MENU, target: IDS.SUPPORT_MENU, sourceHandle: "support" },
    { id: `e_sup_t`, source: IDS.SUPPORT_MENU, target: IDS.ESC_LOGIC, sourceHandle: "talk" },
    { id: `e_sup_h`, source: IDS.SUPPORT_MENU, target: IDS.SUPPORT_HOURS, sourceHandle: "hrs" },
    { id: `e_esc_t`, source: IDS.ESC_LOGIC, target: IDS.ESC_TAG, sourceHandle: "true" },
    { id: `e_esc_f`, source: IDS.ESC_LOGIC, target: IDS.ESC_CAP, sourceHandle: "false" },
    { id: `e_cap_t`, source: IDS.ESC_CAP, target: IDS.ESC_TAG },
    { id: `e_tag_alt`, source: IDS.ESC_TAG, target: IDS.ESC_ALERT },
    { id: `e_alt_fin`, source: IDS.ESC_ALERT, target: IDS.ESC_FINAL }
  );

  // --- 6. LOYALTY (5 Nodes) ---
  nodes.push(
    { id: IDS.LOY_MENU, type: "interactive", position: { x: LAYOUT.LOYALTY_X, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "Rewards Program", interactiveType: "list", text: content.loyalty_welcome, rows:[{id:"pts", title:"Balance"},{id:"ref", title:"Refer"},{id:"vip", title:"VIP Status"}] } },
    { id: IDS.LOY_POINTS, type: "message", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 3.5 }, data: { label: "Wallet Check", text: content.loyalty_points_msg } },
    { id: IDS.LOY_REFER, type: "message", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 4.5 }, data: { label: "Referral Program", text: content.referral_msg } },
    { id: IDS.LOY_VIP, type: "logic", position: { x: LAYOUT.LOYALTY_X + 400, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "Is VIP?", variable: "leadScore", operator: "gt", value: "500" } },
    { id: IDS.LOY_REDEEM, type: "message", position: { x: LAYOUT.LOYALTY_X + 800, y: LAYOUT.Y_STEP * 5.5 }, data: { label: "VIP Perk", text: "You are a VIP! Exclusive 20% discount code: VIP20" } }
  );
  edges.push(
    { id: `e_m_loy`, source: IDS.MENU, target: IDS.LOY_MENU, sourceHandle: "loyalty" },
    { id: `e_loy_p`, source: IDS.LOY_MENU, target: IDS.LOY_POINTS, sourceHandle: "pts" },
    { id: `e_loy_r`, source: IDS.LOY_MENU, target: IDS.LOY_REFER, sourceHandle: "ref" },
    { id: `e_loy_v`, source: IDS.LOY_MENU, target: IDS.LOY_VIP, sourceHandle: "vip" },
    { id: `e_vip_t`, source: IDS.LOY_VIP, target: IDS.LOY_REDEEM, sourceHandle: "true" }
  );

  // --- 7. AUTOMATION (7 Nodes) ---
  nodes.push(
    { id: IDS.CART_TR, type: "trigger", position: { x: LAYOUT.AUTO_X, y: LAYOUT.Y_STEP * 3 }, data: { label: "Abandoned Signal", triggerType: "shopify_event", event: "checkout_abandoned" } },
    { id: IDS.CART_1, type: "message", position: { x: LAYOUT.AUTO_X + 400, y: LAYOUT.Y_STEP * 2 }, data: { label: "Recover 1 (15m)", text: content.cart_recovery_1, delay: 15 } },
    { id: IDS.CART_2, type: "message", position: { x: LAYOUT.AUTO_X + 800, y: LAYOUT.Y_STEP * 2 }, data: { label: "Recover 2 (2h)", text: content.cart_recovery_2, delay: 120 } },
    { id: IDS.CART_3, type: "message", position: { x: LAYOUT.AUTO_X + 1200, y: LAYOUT.Y_STEP * 2 }, data: { label: "Recover 3 (24h)", text: content.cart_recovery_3, delay: 1440 } },
    
    { id: IDS.CONF_TR, type: "trigger", position: { x: LAYOUT.AUTO_X, y: LAYOUT.Y_STEP * 6 }, data: { label: "Payment Signal", triggerType: "shopify_event", event: "order_created" } },
    { id: IDS.CONF_MSG, type: "message", position: { x: LAYOUT.AUTO_X + 400, y: LAYOUT.Y_STEP * 6 }, data: { label: "Confirm TXN", text: content.order_confirmed_msg } },
    { id: IDS.COD_NUDGE, type: "interactive", position: { x: LAYOUT.AUTO_X + 800, y: LAYOUT.Y_STEP * 6 }, data: { label: "Prepaid Nudge", interactiveType: "button", text: content.cod_nudge, buttonsList: [{id:"pay", title:"Pay Prepaid"}] } }
  );
  edges.push(
    { id: `e_c_t1`, source: IDS.CART_TR, target: IDS.CART_1 },
    { id: `e_c_12`, source: IDS.CART_1, target: IDS.CART_2 },
    { id: `e_c_23`, source: IDS.CART_2, target: IDS.CART_3 },
    { id: `e_f_t1`, source: IDS.CONF_TR, target: IDS.CONF_MSG },
    { id: `e_f_nudge`, source: IDS.CONF_MSG, target: IDS.COD_NUDGE }
  );

  // --- 8. REVIEWS (5 Nodes) ---
  nodes.push(
    { id: IDS.REV_TRIG, type: "trigger", position: { x: LAYOUT.REVIEW_X, y: LAYOUT.Y_STEP * 10 }, data: { label: "Delivery Pulse", triggerType: "shopify_event", event: "order_fulfilled" } },
    { id: IDS.REV_ASK, type: "interactive", position: { x: LAYOUT.REVIEW_X + 400, y: LAYOUT.Y_STEP * 10 }, data: { label: "Exp Feedback", interactiveType: "button", text: content.sentiment_ask, buttonsList:[{id:"pos", title:"Loved It!"},{id:"neg", title:"Need Help"}] } },
    { id: IDS.REV_LOGIC, type: "logic", position: { x: LAYOUT.REVIEW_X + 800, y: LAYOUT.Y_STEP * 10 }, data: { label: "Is Positive?", variable: "last_sentiment", operator: "equals", value: "pos" } },
    { id: IDS.REV_POS_LINK, type: "message", position: { x: LAYOUT.REVIEW_X + 1200, y: LAYOUT.Y_STEP * 9.5 }, data: { label: "Review Redirect", text: content.review_positive + " " + googleReviewUrl } },
    { id: IDS.REV_NEG_SUPPORT, type: "message", position: { x: LAYOUT.REVIEW_X + 1200, y: LAYOUT.Y_STEP * 10.5 }, data: { label: "Concierge Direct", text: content.review_negative } }
  );
  edges.push(
    { id: `e_r_tr`, source: IDS.REV_TRIG, target: IDS.REV_ASK },
    { id: `e_r_pos`, source: IDS.REV_ASK, target: IDS.REV_LOGIC, sourceHandle: "pos" },
    { id: `e_r_neg`, source: IDS.REV_ASK, target: IDS.REV_NEG_SUPPORT, sourceHandle: "neg" },
    { id: `e_r_l`, source: IDS.REV_LOGIC, target: IDS.REV_POS_LINK, sourceHandle: "true" },
    { id: `e_r_s`, source: IDS.REV_LOGIC, target: IDS.REV_NEG_SUPPORT, sourceHandle: "false" }
  );

  return { nodes, edges };
}

function buildDefaultContent(businessName, botName, products) {
  return {
    welcome_a: `Welcome to *${businessName}*! 👋 I'm ${botName}, your personal assistant. How can I help you today?`,
    welcome_b: `Hello! Looking for something special at *${businessName}*? 🛍️ check out our catalog below!`,
    product_menu_text: "Broaden your horizon! Choose an option from our shop menu:",
    agent_handoff_msg: "Understood! I've priority-paged our customer success team for you. Someone will be with you shortly. 🎧",
    sentiment_ask: "How was your experience with us? We'd love to hear from you! 😊",
    review_positive: "That's wonderful! We value your feedback. Would you mind sharing your love on Google?",
    review_negative: "Oh, I'm sorry to hear that. 😔 Let me connect you with an expert right away to fix this for you.",
    returns_policy_short: "We offer a 7-day hassle-free return policy for all unused products. 🔄",
    refund_policy_short: "Refunds are processed within 5-7 business days after the product arrives back. 💳",
    installation_msg: "Need help? our team can guide you or schedule an expert visit. 🛠️",
    loyalty_welcome: "Welcome to our Rewards Program! ✨ Earn points on every purchase and redeem for massive discounts.",
    loyalty_points_msg: "You have *540 Points*! That's equivalent to ₹54 off on your next order. 💎",
    referral_msg: "Invite a friend and get *500 Points* when they make their first purchase! 🎁",
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
