const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { fixFlowWithAI } = require('../controllers/flowFixController');

router.post('/fix', protect, fixFlowWithAI);
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
