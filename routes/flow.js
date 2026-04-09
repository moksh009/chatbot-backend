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

module.exports = router;
