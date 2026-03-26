const fs = require('fs');
const path = require('path');
const { getGeminiModel } = require('./gemini');
const log = require('./logger')('LegacyConverter');

/**
 * Uses AI to parse legacy JS flow files and convert them to React Flow JSON
 */
async function convertLegacyToVisual(clientId, fileCode) {
    try {
        const model = getGeminiModel(process.env.GEMINI_API_KEY);

        const systemPrompt = `You are a specialized code migration agent. 
Task: Convert the provided WhatsApp Chatbot legacy JavaScript code into a visual "flowNodes" and "flowEdges" JSON structure for React Flow.

LEGACY CODE:
${fileCode}

RULES:
1. Identify the 'Main Menu' and create a 'welcome' role node.
2. Identify all 'interactive' responses (buttons/lists) and create corresponding 'interactive' nodes.
3. Link nodes with 'edges'. Source handle should match the button ID.
4. If there are FAQs or Product constant objects, create nodes for them.
5. Identify any 'email' or 'template' logic and map them to 'email' or 'template' nodes.
6. Position nodes logically (increasing Y for depth, X-spacing for branches).
7. Return ONLY a valid JSON object:
{
  "nodes": [...],
  "edges": [...]
}

NODE TYPES: 'trigger', 'message', 'interactive', 'template', 'email'.
ROLE SUGGESTIONS: 'welcome', 'support', 'order_confirm'.

DO NOT return markdown fences. ONLY the raw JSON string.`;

        const result = await model.generateContent(systemPrompt);
        const response = await result.response;
        let text = response.text().trim();
        
        // Cleanup markdown if AI ignores instructions
        text = text.replace(/^```json/, '').replace(/```$/, '').trim();

        return JSON.parse(text);
    } catch (err) {
        log.error(`Conversion failed for ${clientId}`, err.message);
        throw err;
    }
}

module.exports = { convertLegacyToVisual };
