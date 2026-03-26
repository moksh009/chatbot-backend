const { GoogleGenerativeAI } = require('@google/generative-ai');
const log = require('./logger')('FlowAutogen');

/**
 * Generates a complete React Flow graph (nodes & edges) using Gemini AI
 * based on the client's niche and system prompt.
 */
async function generateFlowForClient(client, customPrompt = '') {
    try {
        const apiKey = client.openaiApiKey || process.env.GEMINI_API_KEY; // Using openaiApiKey field as a fallback if client-specific
        const geminiKey = process.env.GEMINI_API_KEY;
        
        if (!geminiKey) {
            log.error('GEMINI_API_KEY not found in environment');
            return null;
        }

        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

        const niche = client.niche || client.businessType || 'business';
        const businessInfo = customPrompt || client.systemPrompt || `A professional ${niche} service.`;
        
        // --- PHASE 10: Inject Niche Data for richer flow ---
        let contextData = businessInfo;
        if (client.nicheData) {
            const nd = client.nicheData;
            if (nd.products?.length) contextData += `\nProducts: ${nd.products.map(p => p.title + ' (₹' + p.price + ')').join(', ')}`;
            if (nd.services?.length) contextData += `\nServices: ${nd.services.map(s => s.name + ' (₹' + s.price + ')').join(', ')}`;
            if (nd.faqs?.length) contextData += `\nFAQs: ${nd.faqs.map(f => f.question).join(', ')}`;
        }

        const systemPrompt = `You are an expert WhatsApp conversational designer for TopEdge AI.
Generate a high-conversion, PROFESSIONAL WhatsApp Flow Diagram for a ${niche} business.
CONTEXT: "${contextData}"

The flow MUST be comprehensive (10-15 nodes) and include:
1. A 'trigger' node (keyword "hi" or "hello").
2. A 'welcome' role node (Interactive) with options: "Browse Info", "Ask Question", "Our Team".
3. Multiple browsing nodes (Interactive/Message) specifically for the products/services listed in the context.
4. A 'support' role node that handles generic inquiries.
5. An 'email' node (role: "abandoned_1") connected to a path where users didn't finish booking.
6. A 'template' node for order/booking confirmation.
7. An 'order_confirm' role node at the end.

Return ONLY a JSON object:
{
  "nodes": [
    { "id": "node_0", "type": "trigger", "position": {"x": 250, "y": 0}, "data": {"keyword": "hi"} },
    { "id": "node_1", "type": "interactive", "position": {"x": 250, "y": 150}, "data": {"text": "Welcome!", "role": "welcome", "buttonsList": [...]}} },
    ... 10-15 nodes total ...
  ],
  "edges": [
    { "id": "e1", "source": "node_0", "target": "node_1" },
    ... logical connections ...
  ]
}

RULES:
- 'type': 'trigger', 'message', 'interactive', 'template', 'email'.
- 'role': 'welcome', 'support', 'abandoned_1', 'order_confirm'.
- Position nodes logically (increasing Y for depth, spacing 150-200px).
- DO NOT return markdown fences. ONLY raw JSON string.`;

        let result;
        try {
            result = await model.generateContent(systemPrompt);
        } catch (err) {
            log.warn('Gemini 1.5 Flash failed, falling back to Pro', err.message);
            const proModel = genAI.getGenerativeModel({ model: 'gemini-1.0-pro' });
            result = await proModel.generateContent(systemPrompt);
        }

        const rawText = result.response.text().trim();
        let cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
        
        // Final fallback if Gemini still includes markdown or extra text
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            log.error('AI did not return valid JSON structure');
            return null;
        }

        const flow = JSON.parse(jsonMatch[0]);
        log.success(`Generated flow for ${client.clientId} with ${flow.nodes?.length} nodes`);
        return flow;

    } catch (err) {
        log.error('Flow Autogen Error', err.message);
        return null;
    }
}

module.exports = { generateFlowForClient };
