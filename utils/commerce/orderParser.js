"use strict";

const { callAIJSON } = require("../core/aiGateway");

/**
 * Order Parser — Phase 28 Track 5
 *
 * Extracts structured order data from natural language messages.
 */

const SYSTEM_PROMPT = `
You are an Order Processing AI for an e-commerce store.
Your goal is to analyze a customer's message and determine if they want to PLACE AN ORDER.

## INVENTORY CONTEXT
You will be provided with a list of available products. ONLY extract items that match or closely resemble these products.

## OUTPUT FORMAT
Return a JSON object with:
1. "isOrderIntent": boolean (true if they are explicitly asking to buy/order items)
2. "items": array of { "name": string, "quantity": number, "price": number, "sku": string }
3. "paymentMethod": "cod" | "online" | "unspecified"
4. "address": string | null (extract if provided in the message)
5. "confidence": number (0 to 1)

## RULES
- If quantities aren't specified, assume 1.
- If they are just asking a question about a product, set isOrderIntent to false.
- Return ONLY raw JSON. No explanation.
`;

async function extractOrderDetails(message, productsList, clientId) {
  if (!clientId) return { isOrderIntent: false, items: [] };

  const inventoryString = (productsList || [])
    .slice(0, 30)
    .map((p) => `- ${p.title || p.name}: ₹${p.price} (SKU: ${p.sku || "N/A"})`)
    .join("\n");

  const prompt = `
    INVENTORY:
    ${inventoryString}

    CUSTOMER MESSAGE:
    "${message}"
  `;

  try {
    const result = await callAIJSON({
      clientId,
      feature: 'other',
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      maxTokens: 512,
      fast: true,
    });
    return result.data || { isOrderIntent: false, items: [] };
  } catch (e) {
    console.error("[Order Parser] Error:", e.message);
    return { isOrderIntent: false, items: [], error: e.message };
  }
}

module.exports = { extractOrderDetails };
