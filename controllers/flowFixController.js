const { generateText } = require('../utils/gemini');
const Client = require('../models/Client');
const log = require('../utils/logger')('FlowFixAI');

/**
 * AI Flow Healer
 * Fixes specific issues in the flow nodes without regenerating the entire structure.
 */
exports.fixFlowWithAI = async (req, res) => {
  try {
    const { clientId, diagnostics, nodes, edges } = req.body;
    
    if (!diagnostics || !nodes) {
      return res.status(400).json({ success: false, error: 'Diagnostics and nodes are required' });
    }

    const client = await Client.findOne({ clientId });
    const businessContext = client ? `The business is a ${client.business_type || 'service-based'} store named "${client.name || 'TopEdge Client'}".` : '';

    const systemPrompt = `
You are a Chatbot Flow Architect. Your task is to FIX specific errors in a visual flow without changing its overall structure.
${businessContext}

DIAGNOSTIC ERRORS:
${diagnostics.map(d => `- ${d}`).join('\n')}

INSTRUCTIONS:
1. Review the provided JSON for "flowNodes".
2. Fix "empty text" errors by providing high-quality, professional chatbot copy that fits the node's label and purpose.
3. If a node is "disconnected", look at its label and find a logical target or source for an edge.
4. ONLY return a JSON object with two fields: "nodes" and "edges".
5. Keep existing node IDs and positions. ONLY update the "data" fields to fix the errors.

CURRENT NODES (JSON):
${JSON.stringify(nodes)}

CURRENT EDGES (JSON):
${JSON.stringify(edges)}

Return the EXACT fixed JSON structure (nodes and edges). Do not add any markdown formatting or explanations.
`;

    const aiResult = await generateText(systemPrompt, process.env.GEMINI_API_KEY);
    
    if (!aiResult) {
      throw new Error("AI failed to generate a fix.");
    }

    // Clean up AI response if it contains markdown
    const cleanJson = aiResult.replace(/```json/g, '').replace(/```/g, '').trim();
    const fixedGraph = JSON.parse(cleanJson);

    log.info(`✅ Flow fixed with AI for client: ${clientId}`);
    res.json({ 
      success: true, 
      nodes: fixedGraph.nodes || nodes, 
      edges: fixedGraph.edges || edges 
    });

  } catch (error) {
    log.error('Flow Fix error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};
