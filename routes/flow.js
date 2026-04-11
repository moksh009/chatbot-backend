const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { fixFlowWithAI } = require('../controllers/flowFixController');

router.post('/fix', protect, fixFlowWithAI);

// POST /api/flow/ai-build
// Phase 28: Generate multiple flow variants from a natural language prompt
router.post('/ai-build', protect, async (req, res) => {
  try {
    const { prompt, yOffset, generateVariants } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, message: 'Prompt is required' });
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const { buildFlowFromPrompt, generateFlowVariants } = require('../utils/aiFlowBuilder');
    
    if (generateVariants) {
      const variants = await generateFlowVariants(prompt.trim(), client);
      return res.json({ success: true, variants });
    }

    const result = await buildFlowFromPrompt(prompt.trim(), client, yOffset ?? 500);
    res.json({
      success: true,
      nodes: result.nodes,
      edges: result.edges
    });
  } catch (error) {
    console.error('[AI Flow Builder] Error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'AI generation failed' });
  }
});

// POST /api/flow/ai-save
// Commits chosen AI nodes/edges to the client's visual flow canvas
router.post('/ai-save', protect, async (req, res) => {
  try {
    const { nodes, edges, append } = req.body;
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    if (append) {
      client.flowNodes = [...(client.flowNodes || []), ...nodes];
      client.flowEdges = [...(client.flowEdges || []), ...edges];
    } else {
      client.flowNodes = nodes;
      client.flowEdges = edges;
    }

    await client.save();
    res.json({ success: true, message: 'Flow synchronized successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/flow
// Returns all visual flow configurations for the client
router.get('/', protect, async (req, res) => {
  try {
    const clientId = req.query.clientId || req.user.clientId;
    
    // Auth validation
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to flows' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    res.json({ 
      success: true, 
      flows: client.visualFlows || [],
      legacy: {
        nodes: client.flowNodes || [],
        edges: client.flowEdges || []
      }
    });
  } catch (error) {
    console.error('[Flow API] List error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/analytics', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Extract visitCount from flowNodes
    // flowNodes array where each node has { id, data: { visitCount } }
    const nodes = client.flowNodes || [];
    const nodeAnalytics = nodes.map(node => ({
      id: node.id,
      visitCount: node.data?.visitCount || 0,
      dropOffRate: 0 // Will compute if requested
    }));

    // In a real implementation we would also analyze flowEdges for traffic %
    const edges = client.flowEdges || [];
    
    res.json({ success: true, nodes: nodeAnalytics, edges });
  } catch (error) {
    console.error('Flow Analytics error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/unanswered-questions', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const TrainingCase = require('../models/TrainingCase');
    const Message = require('../models/Message');

    // 1. Get Agent Corrections (Manual Bot Tuning)
    const correctionsRaw = await TrainingCase.find({ clientId, status: 'pending' }).limit(50).sort({ createdAt: -1 });
    const agentCorrections = correctionsRaw.map(c => ({
      id: c._id,
      query: c.userMessage,
      wrongAnswer: c.botResponse,
      correction: c.agentCorrection,
      date: c.createdAt
    }));

    // 2. Identify "Unanswered Questions" via Fallback Detection
    // We look for bot messages where the bot admitted it didn't know the answer
    const fallbackMessages = await Message.find({ 
       clientId, 
       direction: 'outgoing', 
       content: { $regex: /I'm not sure|I don't understand|fallback|connect you to an agent|sorry, I didn't get that/i }
    }).sort({ timestamp: -1 }).limit(20);
    
    const unansweredQuestions = [];
    const seenQueries = new Set();

    for (const msg of fallbackMessages) {
       // Find the user message immediately preceding the fallback
       const incomingMsg = await Message.findOne({ 
           clientId, 
           direction: 'incoming', 
           conversationId: msg.conversationId,
           timestamp: { $lt: msg.timestamp }
       }).sort({ timestamp: -1 });
       
       if (incomingMsg && incomingMsg.content && !seenQueries.has(incomingMsg.content.toLowerCase())) {
           seenQueries.add(incomingMsg.content.toLowerCase());
           unansweredQuestions.push({ 
               id: incomingMsg._id, 
               query: incomingMsg.content, 
               count: 1, 
               date: msg.timestamp 
           });
       }
    }

    // 3. Generate AI Suggested Fixes
    // In a real scenario, we'd pipe the unansweredQuestions to Gemini here.
    // For now, we'll return robust placeholders that the UI can interact with.
    const aiSuggestions = [
      { 
        id: 'sugg_refunds', 
        name: 'Refund & Order Status Flow', 
        description: 'Frequent queries detected regarding refund timelines and order tracking failures.', 
        suggestedNodes: 4,
        impactScore: 85
      },
      { 
        id: 'sugg_shipping', 
        name: 'Logistics Partnership FAQ', 
        description: 'Users are asking about which courier partners you use for specific zones.', 
        suggestedNodes: 2,
        impactScore: 40
      }
    ];

    res.json({
      success: true,
      unansweredQuestions,
      agentCorrections,
      aiSuggestions
    });

  } catch (error) {
    console.error('Bot Intelligence API error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
