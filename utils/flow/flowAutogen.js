const log = require('../core/logger')('FlowAutogen');
const { callAIJSON } = require('../core/aiGateway');

/**
 * Generates a complete React Flow graph (nodes & edges) using Gemini AI
 * based on the client's niche and system prompt.
 */
async function generateFlowForClient(client, customPrompt = '', existingFlow = null) {
  try {
    const clientId = client?.clientId;
    if (!clientId) return null;

    const niche = client.niche || client.businessType || 'business';
    const businessInfo = customPrompt || client.systemPrompt || `A professional ${niche} service.`;

    let contextData = businessInfo;
    if (existingFlow && existingFlow.nodes?.length > 0) {
      contextData += `\n\nCURRENT FLOW STRUCTURE (JSON):\n${JSON.stringify(existingFlow)}\n\nINSTRUCTION: Refine or update the existing flow above according to the user's request. Preserve existing node IDs if possible to maintain connections.`;
    }
    if (client.nicheData) {
      const nd = client.nicheData;
      if (nd.products?.length) contextData += `\nProducts: ${nd.products.map((p) => `${p.title} (₹${p.price})`).join(', ')}`;
      if (nd.services?.length) contextData += `\nServices: ${nd.services.map((s) => `${s.name} (₹${s.price})`).join(', ')}`;
      if (nd.faqs?.length) contextData += `\nFAQs: ${nd.faqs.map((f) => f.question).join(', ')}`;
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
- CRITICAL: Do NOT include trailing commas in arrays or objects.
Do NOT return markdown blocks. Return ONLY raw JSON.`;

    const result = await callAIJSON({
      clientId,
      feature: 'flow_builder',
      systemPrompt,
      prompt: customPrompt || 'Generate the flow graph now.',
      maxTokens: 8192,
      fast: false,
      temperature: 0.3,
    });

    const flow = result.data;
    if (!flow?.nodes) {
      log.error('AI did not return valid JSON structure');
      return null;
    }

    log.info(`Generated flow for ${clientId} with ${flow.nodes?.length} nodes`);
    return flow;
  } catch (err) {
    if (err.code !== 'AI_NOT_CONFIGURED') {
      log.error('Flow Autogen Error', err.message);
    }
    return null;
  }
}

module.exports = { generateFlowForClient };
