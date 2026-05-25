const Conversation = require('../models/Conversation');
const { getGeminiModel } = require('../utils/core/gemini');
const { validateAndCleanFlow } = require('../utils/flow/aiFlowBuilder');

/**
 * AI smart-fix for ReactFlow graphs (same contract as POST /api/admin/flow/fix).
 */
exports.fixFlowWithAI = async (req, res) => {
  try {
    const { diagnostics, nodes, edges } = req.body;
    if (!diagnostics || !nodes || !edges) {
      return res.status(400).json({ error: 'Missing diagnostic or graph data' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    let model = getGeminiModel(apiKey);

    const systemPrompt = `You are a WhatsApp chatbot flow engineer debugging a ReactFlow JSON graph.
    You will receive the current graph (nodes and edges) and a list of diagnostic errors.
    Your task is to fix the errors by intelligently modifying the "nodes" or "edges" array.
    
    Diagnostics:
    ${JSON.stringify(diagnostics, null, 2)}
    
    Current Nodes:
    ${JSON.stringify(nodes, null, 2)}
    
    Current Edges:
    ${JSON.stringify(edges, null, 2)}
    
    Return ONLY valid JSON with exactly two properties: "nodes" and "edges".
    DO NOT DELETE nodes unless absolutely necessary. Just fix the broken edges or properties.
    The response MUST be a valid JSON object. Do not add markdown formatting or explanations.`;

    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      model = getGeminiModel(apiKey);
      result = await model.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI did not return valid JSON' });
    }

    let fixedGraph;
    try {
      fixedGraph = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message });
    }

    if (!fixedGraph.nodes || !fixedGraph.edges) {
      return res.status(500).json({ error: 'AI output missing nodes/edges' });
    }

    const cleanedGraph = validateAndCleanFlow(
      {
        nodes: fixedGraph.nodes || nodes || [],
        edges: fixedGraph.edges || edges || [],
      },
      0
    );

    res.json({ success: true, nodes: cleanedGraph.nodes, edges: cleanedGraph.edges });
  } catch (error) {
    console.error('[FlowFix] fixFlowWithAI error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
};

/** Legacy live-chat correction endpoint — training cases disabled. */
exports.correctAIResponse = async (req, res) => {
  try {
    const { conversationId } = req.body;
    const clientId = req.user?.clientId;

    if (conversationId && clientId) {
      await Conversation.findOneAndUpdate(
        { _id: conversationId, clientId },
        { $set: { aiNeedsTuning: true } }
      ).catch(() => {});
    }

    res.status(200).json({
      success: true,
      message: 'Correction noted. Agent training cases are disabled.',
    });
  } catch (error) {
    console.error('[FlowFixController] correctAIResponse error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
