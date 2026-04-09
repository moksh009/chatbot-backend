"use strict";

const { generateText } = require("./gemini");

/**
 * FLOW GENERATOR — Phase 20
 * Takes wizard form data and generates a complete working flow.
 * The structure is pre-designed; Gemini only writes the MESSAGE TEXT.
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
    razorpayKeyId   = "",
    cashfreeAppId   = "",
    adminPhone      = "",
    abTestingEnabled = true,
    templates = [] // Passed from wizard.js
  } = wizardData;

  // ── STEP 1: Generate message text with Gemini ──────────────────────────────
  let content = {};
  try {
    const contentPrompt = `You are writing WhatsApp chatbot messages for an Indian ecommerce business.

Business: ${businessName}
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${tone}
Language: ${botLanguage} (use Hinglish for warmth where appropriate)
Products: ${products.slice(0, 5).map(p => `${p.name} at ₹${p.price}`).join(", ")}

Write the following messages. Keep each under 3 lines. Use WhatsApp formatting (*bold*).
Format response as VALID JSON ONLY with these exact keys:

{
  "welcome_a": "friendly greeting introduces bot and invites to explore",
  "welcome_b": "promotional greeting mentions a gift/discount and invites to explore",
  "product_menu": "message asking which product they want to know about (3 lines max)",
  "catalog_list_header": "short header (max 8 chars)",
  "catalog_list_button": "view button label (max 18 chars)",
  "price_enquiry": "message when user asks about price (mention range)",
  "buy_now": "purchase CTA with urgency",
  "agent_request_response": "message confirming human will reach out",
  "fallback": "AI fallback message for unknown questions",
  "cart_recovery_1": "first cart recovery (casual, no discount, ${cartTiming.msg1}min delay)",
  "cart_recovery_2": "second recovery with urgency (${cartTiming.msg2}hr delay)",
  "cart_recovery_3": "final recovery with last-chance tone (${cartTiming.msg3}hr delay)",
  "cod_nudge": "COD to prepaid conversion with ₹50 saving incentive",
  "review_request": "post-delivery Google review request",
  "order_confirmed": "order confirmation message"
}`;

    const raw = await generateText(contentPrompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    if (raw) {
      const jsonStr = raw.replace(/```json|```/g, "").trim();
      content = JSON.parse(jsonStr);
    }
  } catch (err) {
    console.warn("[FlowGenerator] Gemini failed, using defaults:", err.message);
    content = buildDefaultContent(businessName, botName, products, cartTiming);
  }

  // Ensure all keys exist with fallbacks
  content = { ...buildDefaultContent(businessName, botName, products, cartTiming), ...content };

  // ── STEP 2: Build node and edge IDs ────────────────────────────────────────
  const ts = Date.now();
  const IDS = {
    TRIGGER:         `gen_trigger_${ts}`,
    AB_WELCOME:      `gen_ab_welcome_${ts}`,
    WELCOME_A:       `gen_welcome_a_${ts}`,
    WELCOME_B:       `gen_welcome_b_${ts}`,
    WELCOME_MERGE:   `gen_wel_merge_${ts}`,
    PRODUCT_MENU:    `gen_menu_${ts}`,
    ORDER_STATUS:    `gen_order_${ts}`,
    AI_FALLBACK:     `gen_ai_${ts}`,
    
    // Human Support Path
    ESCALATE_CHECK:  `gen_esc_logic_${ts}`,
    ESCALATE_CAPTURE:`gen_esc_cap_${ts}`,
    ESCALATE_TAG:    `gen_esc_tag_${ts}`,
    ESCALATE_LIMIT:  `gen_esc_delay_${ts}`,
    ESCALATE_ALERT:  `gen_esc_alert_${ts}`,
    ESCALATE_FINAL:  `gen_escalate_${ts}`,
    
    CART_1:          `gen_cart1_${ts}`,
    CART_2:          `gen_cart2_${ts}`,
    CART_3:          `gen_cart3_${ts}`,
    COD_NUDGE:       `gen_cod_${ts}`,
    REVIEW:          `gen_review_${ts}`,
    ORDER_CONFIRMED: `gen_order_confirm_${ts}`,
  };

  // Product rows for the list menu
  const productRows = products.slice(0, 10).map((p, i) => ({
    id:          `sel_prod_${i}`,
    title:       (p.name || "Product").substring(0, 24),
    description: p.price ? `₹${p.price}` : ""
  }));

  // Helper for common node data (injecting templates everywhere)
  const baseData = { waTemplates: templates };

  // ── STEP 3: Build nodes (Production Schema) ────────────────────────────────
  const COL = 600;
  const nodes = [

    // ── TRIGGER ─────────────────────────────────────────────────────────────
    {
      id:   IDS.TRIGGER,
      type: "trigger",
      position: { x: COL, y: 0 },
      data: {
        ...baseData,
        label:       "Incoming Message",
        triggerType: "keyword",
        keyword:     "hi, hello, hey, help, menu",
        trigger: {
          type: "keyword",
          keywords: ["hi", "hello", "hey", "help", "menu"],
          channel: "both",
          matchMode: "contains"
        }
      }
    },

    // ── AB TEST WELCOME ─────────────────────────────────────────────────────
    ...(abTestingEnabled ? [{
      id:   IDS.AB_WELCOME,
      type: "ab_test",
      position: { x: COL, y: 150 },
      data: { 
        ...baseData,
        label: "A/B Welcome Split", 
        variantA: "Friendly Tone", 
        variantB: "Promotional Tone" 
      }
    }] : []),

    // ── WELCOME A (Friendly) ─────────────────────────────────────────────────
    {
      id:   IDS.WELCOME_A,
      type: "message",
      position: { x: COL - 300, y: 300 },
      data: {
        ...baseData,
        label: "Welcome A",
        text:  content.welcome_a,
      }
    },

    // ── WELCOME B (Promo) ────────────────────────────────────────────────────
    {
      id:   IDS.WELCOME_B,
      type: "message",
      position: { x: COL + 300, y: 300 },
      data: {
        ...baseData,
        label: "Welcome B",
        text:  content.welcome_b,
      }
    },

    // ── PRODUCT MENU (High-Fidelity Interactive List) ──────────────────────
    {
      id:   IDS.PRODUCT_MENU,
      type: "interactive",
      position: { x: COL, y: 500 },
      data: {
        ...baseData,
        label:           "Main Product Menu",
        interactiveType: "list",
        text:            content.product_menu, // UI uses 'text'
        header:          content.catalog_list_header || "Shop Now",
        footer:          "Select an option below",
        buttonText:      content.catalog_list_button || "View Items",
        buttonsList: [
          ...productRows,
          { id: "check_order",   title: "📦 Track My Order" },
          { id: "talk_to_agent", title: "📞 Talk to Expert" }
        ]
      }
    },

    // ── PRODUCT DETAIL NODES (Rich Interactive Buttons) ──────────────────────
    ...products.slice(0, 10).map((p, i) => ({
      id:   `gen_prod_detail_${i}_${ts}`,
      type: "interactive",
      position: { x: (i - products.length / 2) * 350 + COL, y: 800 },
      data: {
        ...baseData,
        label: `Prod: ${p.name}`,
        interactiveType: "button",
        text:  `*${p.name}*\n\n${p.description ? p.description.substring(0, 120) + "..." : ""}\n\n💰 Price: *₹${p.price}*\n🚚 *Express Shipping* | ✅ *100% Genuine*`,
        imageUrl: p.imageUrl || undefined,
        buttonsList: [
          { id: `buy_prod_${i}`,   title: "🛒 Order Now" },
          { id: `agent_prod_${i}`, title: "📱 WhatsApp Us" },
          { id: "back_to_menu",    title: "⬅️ Show All" }
        ]
      }
    })),

    // ── ORDER STATUS (Shopify Action Node) ───────────────────────────────────
    {
      id:   IDS.ORDER_STATUS,
      type: "shopify_call",
      position: { x: COL + 600, y: 800 },
      data: {
        ...baseData,
        label:  "Shopify: Status",
        action: "ORDER_STATUS"
      }
    },

    // ── AI ASSISTANT (Fallback Path) ─────────────────────────────────────────
    {
      id:   IDS.AI_FALLBACK,
      type: "message",
      position: { x: COL + 1000, y: 500 },
      data: {
        ...baseData,
        label: "AI Smart Help",
        text:  content.fallback,
        action: "AI_FALLBACK"
      }
    },

    // ── ADVANCED ESCALATION (Logic + Capture + Admin Alert) ──────────────────
    {
      id:   IDS.ESCALATE_CHECK,
      type: "logic",
      position: { x: COL + 1000, y: 900 },
      data: { 
        ...baseData,
        label: "Lead Check",
        variable: "email",
        operator: "exists",
        value: ""
      }
    },
    {
      id:   IDS.ESCALATE_CAPTURE,
      type: "capture_input",
      position: { x: COL + 1350, y: 850 },
      data: {
        ...baseData,
        label: "Capture Contact",
        variable: "email",
        text: "Could you please share your *contact number or email*? Our team will use this to reach you. 👤"
      }
    },
    {
      id:   IDS.ESCALATE_TAG,
      type: "tag_lead",
      position: { x: COL + 1700, y: 900 },
      data: { 
        ...baseData,
        label: "Tag: Support Request", 
        action: "add", 
        tag: "Wizard_Generated_Support" 
      }
    },
    {
      id:   IDS.ESCALATE_ALERT,
      type: "admin_alert",
      position: { x: COL + 2050, y: 900 },
      data: {
        ...baseData,
        label: "Admin: Handoff",
        topic: "🚨 Enterprise Support Requested",
        channel: "whatsapp",
        priority: "high",
        recipientPhone: adminPhone,
        templateId: "admin_handoff_alert"
      }
    },
    {
      id:   IDS.ESCALATE_FINAL,
      type: "message",
      position: { x: COL + 2400, y: 900 },
      data: {
        ...baseData,
        label: "Confirmation Msg",
        text:  content.agent_request_response
      }
    },

    // ── AUTOMATIONS: EXTERNAL TRIGGERS ──────────────────────────────────────
    ...(wizardData.selectedTemplates?.includes('cart_recovery_1') ? [{
      id:   `trig_cart_${ts}`,
      type: "trigger",
      position: { x: -800, y: 1200 },
      data: {
        ...baseData,
        label: "On Abandoned Cart",
        triggerType: "shopify_event",
        event: "checkout_abandoned"
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('order_confirmation') ? [{
      id:   `trig_order_${ts}`,
      type: "trigger",
      position: { x: -400, y: 1600 },
      data: {
        ...baseData,
        label: "On Order Placed",
        triggerType: "shopify_event",
        event: "order_created"
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('review_request') ? [{
      id:   `trig_delivered_${ts}`,
      type: "trigger",
      position: { x: 400, y: 1600 },
      data: {
        ...baseData,
        label: "On Order Delivered",
        triggerType: "shopify_event",
        event: "order_fulfilled"
      }
    }] : []),

    // ── AUTOMATIONS: MESSAGE NODES ──────────────────────────────────────────
    ...(wizardData.selectedTemplates?.includes('cart_recovery_1') ? [{
      id:   IDS.CART_1,
      type: "message",
      position: { x: -400, y: 1200 },
      data: {
        ...baseData,
        label: "Cart Recover 1",
        text:  content.cart_recovery_1,
        source: "automation_cart_msg1"
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('cart_recovery_2') ? [{
      id:   IDS.CART_2,
      type: "message",
      position: { x: 0, y: 1200 },
      data: {
        ...baseData,
        label: "Cart Recover 2",
        text:  content.cart_recovery_2,
        source: "automation_cart_msg2"
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('cart_recovery_3') ? [{
      id:   IDS.CART_3,
      type: "message",
      position: { x: 400, y: 1200 },
      data: {
        ...baseData,
        label: "Cart Recover 3",
        text:  content.cart_recovery_3,
        source: "automation_cart_msg3"
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('order_confirmation') ? [{
      id:   IDS.ORDER_CONFIRMED,
      type: "message",
      position: { x: -400, y: 1800 },
      data: {
        ...baseData,
        label: "Order Confirmed",
        text:  content.order_confirmed
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('cod_to_prepaid') ? [{
      id:   IDS.COD_NUDGE,
      type: "interactive",
      position: { x: 0, y: 1800 },
      data: {
        ...baseData,
        label: "COD → Prepaid",
        interactiveType: "button",
        text:  content.cod_nudge,
        buttonsList: [
          { id: "cod_pay_link",  title: "💳 Pay Online" },
          { id: "cod_keep_cod",  title: "Keep COD" }
        ]
      }
    }] : []),
    ...(wizardData.selectedTemplates?.includes('review_request') ? [{
      id:   IDS.REVIEW,
      type: "message",
      position: { x: 400, y: 1800 },
      data: {
        ...baseData,
        label: "Review Request",
        text:  content.review_request
      }
    }] : [])
  ].filter(n => n !== null);

  // ── STEP 4: Build edges ────────────────────────────────────────────────────
  const edges = [
    // Trigger → AB Split (or direct to Welcome A)
    ...(abTestingEnabled ? [
      { id: `e_trig_ab_${ts}`, source: IDS.TRIGGER, target: IDS.AB_WELCOME, animated: true },
      { id: `e_ab_a_${ts}`, source: IDS.AB_WELCOME, target: IDS.WELCOME_A, sourceHandle: "a", animated: true },
      { id: `e_ab_b_${ts}`, source: IDS.AB_WELCOME, target: IDS.WELCOME_B, sourceHandle: "b", animated: true },
      // Merge results to menu
      { id: `e_wel_a_menu_${ts}`, source: IDS.WELCOME_A, target: IDS.PRODUCT_MENU, animated: true },
      { id: `e_wel_b_menu_${ts}`, source: IDS.WELCOME_B, target: IDS.PRODUCT_MENU, animated: true },
    ] : [
      { id: `e_trig_wel_a_${ts}`, source: IDS.TRIGGER, target: IDS.WELCOME_A, animated: true },
      { id: `e_wel_a_menu_${ts}`, source: IDS.WELCOME_A, target: IDS.PRODUCT_MENU, animated: true },
    ]),
    
    // Menu Connections
    { id: `e_menu_order_${ts}`, source: IDS.PRODUCT_MENU, target: IDS.ORDER_STATUS, sourceHandle: "check_order", animated: true },
    { id: `e_menu_agent_${ts}`, source: IDS.PRODUCT_MENU, target: IDS.ESCALATE_CHECK, sourceHandle: "talk_to_agent", animated: true },

    // Product Grid Edges
    ...products.slice(0, 10).map((p, i) => ({
      id: `e_menu_prod_${i}_${ts}`, source: IDS.PRODUCT_MENU, target: `gen_prod_detail_${i}_${ts}`, sourceHandle: `sel_prod_${i}`, animated: true
    })),
    ...products.slice(0, 10).map((p, i) => ({
      id: `e_prod_agent_${i}_${ts}`, source: `gen_prod_detail_${i}_${ts}`, target: IDS.ESCALATE_CHECK, sourceHandle: `agent_prod_${i}`, animated: true
    })),
    ...products.slice(0, 10).map((p, i) => ({
      id: `e_prod_back_${i}_${ts}`, source: `gen_prod_detail_${i}_${ts}`, target: IDS.PRODUCT_MENU, sourceHandle: "back_to_menu", animated: true
    })),

    // Escalation Path Edges
    { id: `e_esc_logic_t_${ts}`,  source: IDS.ESCALATE_CHECK, target: IDS.ESCALATE_TAG, sourceHandle: "true", animated: true },
    { id: `e_esc_logic_f_${ts}`,  source: IDS.ESCALATE_CHECK, target: IDS.ESCALATE_CAPTURE, sourceHandle: "false", animated: true },
    { id: `e_esc_cap_tag_${ts}`,  source: IDS.ESCALATE_CAPTURE, target: IDS.ESCALATE_TAG, animated: true },
    { id: `e_esc_tag_alert_${ts}`,source: IDS.ESCALATE_TAG, target: IDS.ESCALATE_ALERT, animated: true },
    { id: `e_esc_alt_final_${ts}`,source: IDS.ESCALATE_ALERT, target: IDS.ESCALATE_FINAL, animated: true },

    // ── AUTOMATION EDGES ─────────────────────────────────────────────────────
    ...(wizardData.selectedTemplates?.includes('cart_recovery_1') ? [{ id: `e_trig_cart_c1_${ts}`, source: `trig_cart_${ts}`, target: IDS.CART_1, animated: true }] : []),
    ...(wizardData.selectedTemplates?.includes('cart_recovery_1') && wizardData.selectedTemplates?.includes('cart_recovery_2') ? [{ id: `e_c1_c2_${ts}`, source: IDS.CART_1, target: IDS.CART_2, animated: true }] : []),
    ...(wizardData.selectedTemplates?.includes('cart_recovery_2') && wizardData.selectedTemplates?.includes('cart_recovery_3') ? [{ id: `e_c2_c3_${ts}`, source: IDS.CART_2, target: IDS.CART_3, animated: true }] : []),

    ...(wizardData.selectedTemplates?.includes('order_confirmation') ? [{ id: `e_trig_order_conf_${ts}`, source: `trig_order_${ts}`, target: IDS.ORDER_CONFIRMED, animated: true }] : []),
    ...(wizardData.selectedTemplates?.includes('cod_to_prepaid') ? [{ id: `e_trig_order_nudge_${ts}`, source: `trig_order_${ts}`, target: IDS.COD_NUDGE, animated: true }] : []),
    
    ...(wizardData.selectedTemplates?.includes('review_request') ? [{ id: `e_trig_deliv_rev_${ts}`,  source: `trig_delivered_${ts}`, target: IDS.REVIEW, animated: true }] : [])
  ].filter(e => e !== null);

  return { nodes, edges };
}



/**
 * Generate the AI system prompt from wizard data.
 * Falls back to a template if Gemini is unavailable.
 */
async function generateSystemPrompt(client, wizardData) {
  const {
    businessName,
    businessDescription,
    botName      = "Assistant",
    tone         = "friendly",
    botLanguage  = "Hinglish",
    fallbackMessage = "That's a great question! Let me connect you with our team.",
    products     = []
  } = wizardData;

  const toneMap = {
    friendly:     "warm, helpful, and conversational",
    professional: "formal, professional, and concise",
    fun:          "energetic, fun, and uses emojis liberally",
    direct:       "concise, direct, and no-nonsense"
  };

  const toneDesc = toneMap[tone] || toneMap.friendly;

  try {
    const prompt = `Write a WhatsApp chatbot system prompt for this business.

Business: ${businessName}
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${toneDesc}
Language: ${botLanguage}
Products: ${products.slice(0, 5).map(p => p.name).join(", ")}
Fallback message when unsure: "${fallbackMessage}"

Write a 150-200 word system prompt that:
1. Sets the bot's name and personality
2. Lists what topics the bot can help with
3. Describes how to handle unknown questions (use the fallback message)
4. Mentions the product catalog
5. Instructs to always guide toward purchase

Write the prompt directly (don't add any JSON or code blocks).`;

    const result = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    if (result) return result;
  } catch (_) {}

  // Fallback system prompt
  return `You are ${botName}, a helpful WhatsApp assistant for ${businessName}.

${businessDescription}

Your role:
- Help customers with product inquiries and pricing for: ${products.slice(0, 5).map(p => p.name).join(", ")}
- Guide customers toward making a purchase
- Answer questions about orders, shipping, and returns
- Be ${toneDesc}
- Respond in ${botLanguage}

When you don't know an answer, say: "${fallbackMessage}"

Always be helpful, accurate, and keep your responses under 3 lines.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONTENT FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
function buildDefaultContent(businessName, botName, products, cartTiming = {}, checkoutUrl = "") {
  const productList = products.slice(0, 3).map(p => `• *${p.name}* — ₹${p.price}`).join("\n");
  const baseCheckoutUrl = checkoutUrl || "your-store.com/cart";
  return {
    welcome:               `Hi {{customer_name}}! 👋 Welcome to *${businessName}*!\n\nI'm ${botName}, your shopping assistant. ${productList ? "Here's what we offer:\n" + productList : ""}`,
    product_menu:          "Which product would you like to know more about? 👇",
    catalog_list_header:   "Products",
    catalog_list_button:   "View Products",
    price_enquiry:         `Our products start at just ₹${products[0]?.price || "999"}! 💰\n\nSelect a product from the menu below to see exact pricing.`,
    buy_now:               `Great choice! 🛒\n\nClick here to order now: ${baseCheckoutUrl}/{{checkout_id}}\n\nFree shipping | Easy returns`,
    agent_request_response:`✅ *Perfect!* I've notified our team and they'll contact you shortly on this number.\n\nIn the meantime, feel free to browse our catalog! 😊`,
    fallback:              `That's a great question! 🤔\n\nLet me connect you with our team who can answer that perfectly. One moment...`,
    cart_recovery_1:       `Hey {{customer_name}}! 👋 You left something in your cart!\n\n🛒 *{{cart_items}}*\n💰 Total: *{{cart_total}}*\n\nComplete your order: ${baseCheckoutUrl}/{{checkout_id}}`,
    cart_recovery_2:       `⏰ Still thinking, {{customer_name}}?\n\nYour items are waiting — but stock is limited! \nOrder now: ${baseCheckoutUrl}/{{checkout_id}}`,
    cart_recovery_3:       `🚨 Last chance, {{customer_name}}!\n\nYour cart expires soon. Don't miss out:\n${baseCheckoutUrl}/{{checkout_id}}`,
    cod_nudge:             `🎉 Your COD order *{{order_id}}* is confirmed!\n\nPay online now & save *₹{{discount_amount}}* instantly: {{payment_link}}`,
    review_request:        `Hi {{customer_name}}! 😊 Hope you're loving your purchase from *${businessName}*!\n\nWould you mind leaving us a quick review? It really helps! ⭐`,
    order_confirmed:       `✅ *Order Confirmed!* Thank you, {{customer_name}}!\n\nOrder *{{order_id}}* | Total: *{{order_total}}*\nWe'll keep you updated on your shipment! 📦`
  };
}

// Pre-built WhatsApp templates for the wizard's Template Approval step
function getPrebuiltTemplates(wizardData) {
  const {
    businessName = "Store",
    products     = [],
    cartTiming   = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl = "",
    razorpayKeyId   = "",
    cashfreeAppId   = ""
  } = wizardData;

  const hasGateway = !!(razorpayKeyId || cashfreeAppId);

  return [
    {
      id:       "cart_recovery_1",
      name:     `cart_recovery_msg1`,
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `Hey {{1}}, you left {{2}} in your cart! 🛒\n\nComplete your purchase and get free shipping:\n{{3}}`,
      variables: ["customer_name", "cart_items", "checkout_url"],
      description: `Sent ${cartTiming.msg1} minutes after cart abandon`,
      required:  true
    },
    {
      id:       "cart_recovery_2",
      name:     `cart_recovery_msg2`,
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `Last chance, {{1}}! ⏰\n\nYour cart is about to expire. Complete your order now:\n{{2}}`,
      variables: ["customer_name", "checkout_url"],
      description: `Sent ${cartTiming.msg2} hours after cart abandon`,
      required:  true
    },
    ...(hasGateway ? [{
      id:       "cod_to_prepaid",
      name:     `cod_prepaid_nudge`,
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `Hi {{1}}! Your COD order #{{2}} is confirmed! 🎉\n\nPay online now and save ₹{{3}}:\n{{4}}`,
      variables: ["customer_name", "order_id", "discount_amount", "payment_link"],
      description: "Sent 3 minutes after COD order placement",
      required:  true
    }] : []),
    {
      id:       "order_confirmation",
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
