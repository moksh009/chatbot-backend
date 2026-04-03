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
    razorpayKeyId   = ""
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
  "welcome": "greeting message that introduces the bot and invites to explore",
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
    WELCOME:         `gen_welcome_${ts}`,
    PRODUCT_MENU:    `gen_menu_${ts}`,
    ORDER_STATUS:    `gen_order_${ts}`,
    AI_FALLBACK:     `gen_ai_${ts}`,
    ESCALATE:        `gen_escalate_${ts}`,
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

  // ── STEP 3: Build nodes ────────────────────────────────────────────────────
  const COL = 400; // center column x
  const nodes = [

    // ── TRIGGER ─────────────────────────────────────────────────────────────
    {
      id:   IDS.TRIGGER,
      type: "TriggerNode",
      position: { x: COL, y: 0 },
      data: {
        label:       "Welcome Trigger",
        triggerType: "first_message",
        channel:     "both",
        trigger: {
          type:    "first_message",
          channel: "both"
        }
      }
    },

    // ── WELCOME MESSAGE ──────────────────────────────────────────────────────
    {
      id:   IDS.WELCOME,
      type: "MessageNode",
      position: { x: COL, y: 150 },
      data: {
        label: "Welcome Message",
        text:  content.welcome || `Hi {{customer_name}}! 👋 Welcome to *${businessName}*. I'm ${botName} — how can I help you today?`,
        role:  "welcome"
      }
    },

    // ── PRODUCT MENU (List) ──────────────────────────────────────────────────
    {
      id:   IDS.PRODUCT_MENU,
      type: "ListNode",
      position: { x: COL, y: 320 },
      data: {
        label:      "Product Menu",
        role:       "main_menu",
        header:     content.catalog_list_header || "Products",
        body:       content.product_menu || "Select a product to see details and pricing:",
        buttonText: content.catalog_list_button || "View Products",
        sections: [
          {
            title: "Our Products",
            rows:  productRows
          },
          {
            title: "Help & Support",
            rows: [
              { id: "check_order",   title: "Check My Order",   description: "Track your order status" },
              { id: "exclusive_offer", title: "🎁 Exclusive Offers", description: "Get 10% off your next purchase" },
              { id: "talk_to_agent", title: "Talk to a Person", description: "Get personalized help" }
            ]
          }
        ]
      }
    },

    // ── PRODUCT DETAIL NODES (one per product) ───────────────────────────────
    ...products.slice(0, 10).map((p, i) => ({
      id:   `gen_prod_detail_${i}_${ts}`,
      type: "InteractiveNode",
      position: { x: (i - products.length / 2) * 300 + COL, y: 540 },
      data: {
        label: `${p.name} Detail`,
        body:  `*${p.name}*\n\n${p.description ? p.description.substring(0, 100) + "..." : ""}\n\n💰 Price: *₹${p.price}*\n🚚 Free Shipping | ✅ Easy Returns`,
        header: p.imageUrl ? { type: "image", imageUrl: p.imageUrl } : undefined,
        buttons: [
          { id: `buy_prod_${i}`,   title: "🛒 Buy Now" },
          { id: `agent_prod_${i}`, title: "📞 Talk to Us" },
          { id: "back_to_menu",    title: "⬅️ Back" }
        ]
      }
    })),

    // ── ORDER STATUS ─────────────────────────────────────────────────────────
    {
      id:   IDS.ORDER_STATUS,
      type: "ShopifyNode",
      position: { x: COL + 400, y: 540 },
      data: {
        label:  "Check Order Status",
        action: "ORDER_STATUS",
        role:   "order_status"
      }
    },

    // ── AI FALLBACK ──────────────────────────────────────────────────────────
    {
      id:   IDS.AI_FALLBACK,
      type: "AINode",
      position: { x: COL + 700, y: 320 },
      data: {
        label:          "AI Assistant",
        role:           "ai_fallback",
        overridePrompt: null // uses client.systemPrompt
      }
    },

    // ── ESCALATE TO HUMAN ────────────────────────────────────────────────────
    {
      id:   IDS.ESCALATE,
      type: "EscalateNode",
      position: { x: COL + 700, y: 540 },
      data: {
        label:             "Human Handoff",
        role:              "escalate",
        userMessage:       content.agent_request_response || `✅ *Got it!* Our team has been notified and will reach out on this number shortly.\n\nFeel free to browse our products in the meantime! 😊`,
        adminNotification: true,
        trackStat:         "agentRequests"
      }
    },

    // ── CART RECOVERY NODES (triggered by cron automation) ──────────────────
    {
      id:   IDS.CART_1,
      type: "MessageNode",
      position: { x: 0, y: 800 },
      data: {
        label: `Cart Recovery 1 (${cartTiming.msg1}min)`,
        text:  content.cart_recovery_1 || `Hey {{customer_name}}! 👋 You left something in your cart.\n\n🛒 *{{cart_items}}*\n💰 Total: *{{cart_total}}*\n\nComplete your order: {{checkout_url}}`,
        role:  "cart_recovery_1"
      }
    },
    {
      id:   IDS.CART_2,
      type: "MessageNode",
      position: { x: 320, y: 800 },
      data: {
        label: `Cart Recovery 2 (${cartTiming.msg2}hr)`,
        text:  content.cart_recovery_2 || `⏰ Still thinking, {{customer_name}}? Your cart is waiting!\n\nItems may sell out soon. Order now: {{checkout_url}}`,
        role:  "cart_recovery_2"
      }
    },
    {
      id:   IDS.CART_3,
      type: "MessageNode",
      position: { x: 640, y: 800 },
      data: {
        label: `Cart Recovery 3 (${cartTiming.msg3}hr)`,
        text:  content.cart_recovery_3 || `🚨 Last chance, {{customer_name}}! Your cart expires soon.\n\nDon't miss out: {{checkout_url}}`,
        role:  "cart_recovery_3"
      }
    },

    // ── COD TO PREPAID NUDGE ─────────────────────────────────────────────────
    {
      id:   IDS.COD_NUDGE,
      type: "InteractiveNode",
      position: { x: 960, y: 800 },
      data: {
        label: "COD → Prepaid Nudge",
        body:  content.cod_nudge || `🎉 Your COD order *{{order_id}}* is confirmed!\n\nPay online now & save *₹{{discount_amount}}* instantly:\n{{payment_link}}`,
        role:  "cod_nudge",
        buttons: [
          { id: "cod_pay_link",  title: "💳 Pay via UPI/Card" },
          { id: "cod_keep_cod",  title: "Keep COD" }
        ]
      }
    },

    // ── ORDER CONFIRMATION ───────────────────────────────────────────────────
    {
      id:   IDS.ORDER_CONFIRMED,
      type: "MessageNode",
      position: { x: 1280, y: 800 },
      data: {
        label: "Order Confirmed",
        text:  content.order_confirmed || `✅ *Order Confirmed!*\n\nOrder *{{order_id}}* | Total: *{{order_total}}*\nWe'll notify you when it ships! 📦`,
        role:  "order_confirmation"
      }
    },

    // ── EXCLUSIVE OFFERS ADVANCED SEQUENCE ────────────────────────────────────
    {
      id:   `gen_capture_email_${ts}`,
      type: "CaptureNode",
      position: { x: COL + 1050, y: 320 },
      data: {
        label:          "Capture Email",
        captureType:    "text",
        variableName:   "email",
        question:       "Let's get you that 10% discount! 🎁\n\nPlease reply with your *email address* to receive the promo code."
      }
    },
    {
      id:   `gen_logic_email_${ts}`,
      type: "LogicNode",
      position: { x: COL + 1350, y: 320 },
      data: {
        label:    "Check Email Given",
        variable: "lead.capturedData.email",
        operator: "exists",
        value:    ""
      }
    },
    {
      id:   `gen_tag_subscriber_${ts}`,
      type: "TagNode",
      position: { x: COL + 1650, y: 220 },
      data: {
        label:  "Tag Subscriber",
        action: "add",
        tag:    "Email_Subscriber"
      }
    },
    {
      id:   `gen_delay_offer_${ts}`,
      type: "DelayNode",
      position: { x: COL + 1950, y: 220 },
      data: {
        label:    "Wait Before Sending",
        duration: "5s",
        unit:     "seconds" 
      }
    },
    {
      id:   `gen_msg_offer_${ts}`,
      type: "MessageNode",
      position: { x: COL + 2250, y: 220 },
      data: {
        label: "Send Coupon",
        text:  `Thanks for subscribing! 🎉\n\nHere is your 10% off code: *WELCOME10*\n\nEnjoy shopping! 🛍️`
      }
    },

    // ── REVIEW REQUEST ───────────────────────────────────────────────────────
    ...(googleReviewUrl ? [{
      id:   IDS.REVIEW,
      type: "InteractiveNode",
      position: { x: 1600, y: 800 },
      data: {
        label: "Review Request",
        body:  content.review_request || `Hi {{customer_name}}! 😊 How was your experience with *${businessName}*?\n\nYour feedback helps us improve for everyone!`,
        role:  "review_request",
        buttons: [
          { id: "review_yes", title: `⭐ Leave a Review` },
          { id: "review_no",  title:  "Not Now" }
        ]
      }
    }] : [])
  ];

  // ── STEP 4: Build edges ────────────────────────────────────────────────────
  const edges = [
    // Trigger → Welcome (auto)
    { id: `e_trig_welcome_${ts}`,   source: IDS.TRIGGER,      target: IDS.WELCOME,   data: { trigger: { type: "auto" } } },
    // Welcome → Product Menu (auto)
    { id: `e_welcome_menu_${ts}`,   source: IDS.WELCOME,      target: IDS.PRODUCT_MENU, sourceHandle: "a" },
    // Menu → Order Status
    { id: `e_menu_order_${ts}`,     source: IDS.PRODUCT_MENU, target: IDS.ORDER_STATUS,  sourceHandle: "check_order" },
    // Menu → Agent
    { id: `e_menu_agent_${ts}`,     source: IDS.PRODUCT_MENU, target: IDS.ESCALATE,      sourceHandle: "talk_to_agent" },
    // Order Status → AI Fallback (when no order found)
    { id: `e_order_ai_${ts}`,       source: IDS.ORDER_STATUS, target: IDS.AI_FALLBACK,   sourceHandle: "a" },

    // Menu → each product detail
    ...products.slice(0, 10).map((p, i) => ({
      id:           `e_menu_prod_${i}_${ts}`,
      source:       IDS.PRODUCT_MENU,
      target:       `gen_prod_detail_${i}_${ts}`,
      sourceHandle: `sel_prod_${i}`
    })),

    // Product detail → Agent
    ...products.slice(0, 10).map((p, i) => ({
      id:           `e_prod_agent_${i}_${ts}`,
      source:       `gen_prod_detail_${i}_${ts}`,
      target:       IDS.ESCALATE,
      sourceHandle: `agent_prod_${i}`
    })),

    // Product detail → Back to Menu
    ...products.slice(0, 10).map((p, i) => ({
      id:           `e_prod_back_${i}_${ts}`,
      source:       `gen_prod_detail_${i}_${ts}`,
      target:       IDS.PRODUCT_MENU,
      sourceHandle: "back_to_menu"
    })),

    // Advanced Sequence Edges
    { id: `e_menu_offer_${ts}`,     source: IDS.PRODUCT_MENU,           target: `gen_capture_email_${ts}`,  sourceHandle: "exclusive_offer" },
    { id: `e_capture_logic_${ts}`,  source: `gen_capture_email_${ts}`,  target: `gen_logic_email_${ts}`,    sourceHandle: "a" },
    { id: `e_logic_true_${ts}`,     source: `gen_logic_email_${ts}`,    target: `gen_tag_subscriber_${ts}`, sourceHandle: "true" },
    { id: `e_logic_false_${ts}`,    source: `gen_logic_email_${ts}`,    target: IDS.PRODUCT_MENU,           sourceHandle: "false" },
    { id: `e_tag_delay_${ts}`,      source: `gen_tag_subscriber_${ts}`, target: `gen_delay_offer_${ts}`,    sourceHandle: "a" },
    { id: `e_delay_msg_${ts}`,      source: `gen_delay_offer_${ts}`,    target: `gen_msg_offer_${ts}`,      sourceHandle: "a" }
  ];

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
function buildDefaultContent(businessName, botName, products, cartTiming = {}) {
  const productList = products.slice(0, 3).map(p => `• *${p.name}* — ₹${p.price}`).join("\n");
  return {
    welcome:               `Hi {{customer_name}}! 👋 Welcome to *${businessName}*!\n\nI'm ${botName}, your shopping assistant. ${productList ? "Here's what we offer:\n" + productList : ""}`,
    product_menu:          "Which product would you like to know more about? 👇",
    catalog_list_header:   "Products",
    catalog_list_button:   "View Products",
    price_enquiry:         `Our products start at just ₹${products[0]?.price || "999"}! 💰\n\nSelect a product from the menu below to see exact pricing.`,
    buy_now:               `Great choice! 🛒\n\nClick here to order now: {{checkout_url}}\n\nFree shipping | Easy returns`,
    agent_request_response:`✅ *Perfect!* I've notified our team and they'll contact you shortly on this number.\n\nIn the meantime, feel free to browse our catalog! 😊`,
    fallback:              `That's a great question! 🤔\n\nLet me connect you with our team who can answer that perfectly. One moment...`,
    cart_recovery_1:       `Hey {{customer_name}}! 👋 You left something in your cart!\n\n🛒 *{{cart_items}}*\n💰 Total: *{{cart_total}}*\n\nComplete your order: {{checkout_url}}`,
    cart_recovery_2:       `⏰ Still thinking, {{customer_name}}?\n\nYour items are waiting — but stock is limited! \nOrder now: {{checkout_url}}`,
    cart_recovery_3:       `🚨 Last chance, {{customer_name}}!\n\nYour cart expires soon. Don't miss out:\n{{checkout_url}}`,
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
    razorpayKeyId   = ""
  } = wizardData;

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
    ...(razorpayKeyId ? [{
      id:       "cod_to_prepaid",
      name:     `cod_prepaid_nudge`,
      category: "UTILITY",
      language: "en",
      status:   "not_submitted",
      body:     `Hi {{1}}! Your COD order #{{2}} is confirmed! 🎉\n\nPay online now and save ₹{{3}}:\n{{4}}`,
      variables: ["customer_name", "order_id", "discount_amount", "payment_link"],
      description: "Sent 3 minutes after COD order placement",
      required:  !!razorpayKeyId
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
    }] : [])
  ];
}

module.exports = { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates };
