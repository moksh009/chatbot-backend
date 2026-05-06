"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getLanguageInstructions } = require("./languageEngine");
const shopifyAdminApiVersion = require("./shopifyAdminApiVersion");

/**
 * Generate an AI-personalized WhatsApp cart recovery message.
 * Returns null on any failure (caller falls back to template).
 * 
 * @param {Object} client     - Client mongoose doc
 * @param {Object} lead       - AdLead mongoose doc
 * @param {number} stepNumber - 1 (warm), 2 (urgency), 3 (discount + last chance)
 * @returns {string|null}
 */
async function generateSmartRecoveryMessage(client, lead, stepNumber = 1) {
  try {
    const cart  = lead.cartSnapshot;
    if (!cart || (!cart.titles?.length && !cart.items?.length)) return null;

    const geminiKey = client.geminiApiKey || client.geminiKey || process.env.GEMINI_API_KEY;
    if (!geminiKey) return null;

    const productNames = (cart.titles || cart.items?.map(i => i.title || i.product_retailer_id) || []).slice(0, 3).join(", ");
    const cartTotal    = cart.total_price
      ? `₹${parseFloat(cart.total_price).toLocaleString("en-IN")}`
      : lead.cartValue
        ? `₹${Number(lead.cartValue).toLocaleString("en-IN")}`
        : "";

    const storeUrl     = client.nicheData?.storeUrl || (client.shopDomain ? `https://${client.shopDomain}` : "");
    const checkoutUrl  = lead.checkoutUrl || lead.cartUrl || storeUrl;
    const customerName = (lead.name || "there").split(" ")[0];
    const language     = lead.detectedLanguage || "en";
    const langInstr    = getLanguageInstructions(language);

    // Best-effort: try to enrich with Shopify product data
    let productContext = `Products: ${productNames}. Total: ${cartTotal}.`;
    try {
      if (client.shopDomain && client.shopifyAccessToken && cart.handles?.length) {
        const { default: axios } = require("axios");
        const productResp = await axios.get(
          `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products.json?handle=${cart.handles[0]}`,
          { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } }
        );
        const p = productResp.data?.products?.[0];
        if (p) {
          const desc = (p.body_html || "").replace(/<[^>]*>/g, "").substring(0, 150);
          const stock = p.variants?.[0]?.inventory_quantity;
          productContext = `Product: "${p.title}". ${desc ? "About: " + desc + "." : ""} Price: ₹${p.variants?.[0]?.price}. ${stock !== undefined ? (stock > 5 ? "In stock." : stock > 0 ? `Only ${stock} left!` : "Limited availability.") : ""}`;
        }
      }
    } catch { /* use basic context */ }

    const stepDirectives = {
      1: "Write the FIRST recovery message. Tone: warm, helpful, zero pressure. Just remind them. No discount.",
      2: "Write the SECOND recovery message. Create mild urgency — mention limited stock or that items are going fast. No discount yet.",
      3: `Write the THIRD and FINAL recovery message. Offer a discount code now: ${lead.activeDiscountCode || "SAVE10"}. Strong urgency — this is the last message. Make it count.`
    };

    const prompt = `You are writing a WhatsApp cart abandonment recovery message for a real customer.
${langInstr}

Business name: ${client.businessName}
Customer: ${customerName}
${productContext}
Cart total: ${cartTotal}
Checkout URL: ${checkoutUrl}
${stepNumber === 3 ? `Discount code to offer: ${lead.activeDiscountCode || "SAVE10"}` : ""}

Task: ${stepDirectives[stepNumber] || stepDirectives[1]}

Strict rules:
- Maximum 3 short paragraphs
- Use WhatsApp bold formatting (*word*) for product names and prices
- 1-2 emojis maximum, used naturally
- Include the checkout URL at the end of the message
- Use the customer's actual name ("${customerName}"), NOT {{name}} or any placeholder
- Sound human — conversational, not robotic
- ${stepNumber === 3 ? "Clearly highlight the discount code" : "Do NOT mention any discount code"}

Write ONLY the message text. No intro, no explanation, no quotes around the message.`;

    const genAI  = new GoogleGenerativeAI(geminiKey);
    const model  = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const text   = result.response.text().trim();

    return text || null;
  } catch (err) {
    console.error("[SmartCartRecovery] Gemini error:", err.message);
    return null; // Always fail silently — never block recovery flow
  }
}

module.exports = { generateSmartRecoveryMessage };
