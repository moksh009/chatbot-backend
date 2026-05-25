"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

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

async function extractOrderDetails(message, productsList, apiKey) {
  if (!apiKey) return { isOrderIntent: false, items: [] };

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ 
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT 
  });

  const inventoryString = productsList.map(p => `- ${p.title || p.name}: ₹${p.price} (SKU: ${p.sku || 'N/A'})`).join('\n');

  const prompt = `
    INVENTORY:
    ${inventoryString}

    CUSTOMER MESSAGE:
    "${message}"
  `;

  try {
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    const cleaned = responseText.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("[Order Parser] Error:", e.message);
    return { isOrderIntent: false, items: [], error: e.message };
  }
}

module.exports = { extractOrderDetails };
