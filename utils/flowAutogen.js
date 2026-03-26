const { GoogleGenerativeAI } = require('@google/generative-ai');
const log = require('./logger')('FlowAutogen');

/**
 * Generates a complete React Flow graph (nodes & edges) using Gemini AI
 * based on the client's niche and system prompt.
 */
async function generateFlowForClient(client, customPrompt = '') {
    try {
        const geminiKey = process.env.GEMINI_API_KEY;
        
        if (!geminiKey) {
            log.error('GEMINI_API_KEY not found in environment');
            return null;
        }

        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

        const niche = client.niche || client.businessType || 'business';
        const businessInfo = customPrompt || client.systemPrompt || `A professional ${niche} service.`;
        
        let contextData = businessInfo;
        if (client.nicheData) {
            const nd = client.nicheData;
            if (nd.products?.length) contextData += `\nProducts: ${nd.products.map(p => p.title + ' (₹' + p.price + ')').join(', ')}`;
            if (nd.services?.length) contextData += `\nServices: ${nd.services.map(s => s.name + ' (₹' + s.price + ')').join(', ')}`;
            if (nd.faqs?.length) contextData += `\nFAQs: ${nd.faqs.map(f => f.question).join(', ')}`;
        }

        const systemPrompt = `You are an expert Chatbot Flow Architect.
Your goal is to generate a PRODUCTION-READY React Flow JSON for a "${niche}" business.

BUSINESS CONTEXT:
${contextData}
User Intent/Request: ${customPrompt || 'Create a comprehensive business flow'}

STRICT NODE REQUIREMENTS:
1. One 'trigger' node at the top (data.keyword="hi").
2. One 'interactive' node with data.role="welcome" as the first greeting.
3. Multiple nodes for: Pricing, Services, FAQs, and Contact/Booking.
4. IMPORTANT: Assign data.role ('pricing', 'support', 'booking', 'products') to relevant nodes.
5. Add data.keywords (comma-separated) to nodes (e.g. keywords: "price,cost,pricing").

STRUCTURE:
- Node types: 'trigger', 'message', 'interactive', 'template', 'email', 'image'.
- 'image' nodes for product previews (placeholder: https://placehold.co/600x400/indigo/white?text=Product).

LAYOUT:
- Position nodes with increasing Y (180px gap per level).
- Spacing for branches in X (350px gap).
- Return ONLY a valid JSON object: { "nodes": [...], "edges": [...] }
Do NOT return markdown blocks.`;

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
