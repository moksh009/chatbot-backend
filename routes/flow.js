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

// POST /api/flow/simulate
// Processes a simulation step on the backend without hitting WhatsApp API
router.post('/simulate', protect, async (req, res) => {
  try {
    const { flowId, currentNodeId, userInput, variables, nodes, edges } = req.body;
    const clientId = req.user.clientId;
    
    // Fallback simple traversal logic mirroring frontend if not using full engine
    const safeNodes = Array.isArray(nodes) ? nodes : [];
    const safeEdges = Array.isArray(edges) ? edges : [];
    
    let nextNode = null;
    let edgeUsed = null;
    let updatedVariables = { ...variables };

    if (!currentNodeId) {
      nextNode = safeNodes.find(n => n.type === 'trigger');
    } else {
      const currentNode = safeNodes.find(n => n.id === currentNodeId);
      const outgoingEdges = safeEdges.filter(e => e.source === currentNodeId);

      if (currentNode?.type === 'interactive') {
        const textLower = (userInput || '').toLowerCase();
        const buttons = currentNode.data?.buttonsList || [];
        const btnIndex = buttons.findIndex(b => b.title.toLowerCase() === textLower);
        const sourceHandle = btnIndex !== -1 ? (buttons[btnIndex].id || `btn_${btnIndex}`) : textLower.replace(/\s+/g, '_');
        edgeUsed = outgoingEdges.find(e => e.sourceHandle === sourceHandle);
      } else if (currentNode?.type === 'capture_input' || currentNode?.type === 'CaptureNode') {
        const varName = currentNode.data?.variable || 'captured_input';
        updatedVariables[varName] = userInput;
        edgeUsed = outgoingEdges[0];
      } else {
        edgeUsed = outgoingEdges[0];
      }

      if (edgeUsed) {
        nextNode = safeNodes.find(n => n.id === edgeUsed.target);
      }
    }

    res.json({
      success: true,
      nextNode,
      updatedVariables,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/flow/save
// Saves draft nodes/edges to the WhatsAppFlow model
router.post('/save', protect, async (req, res) => {
  try {
    const { flowId, nodes, edges } = req.body;
    const clientId = req.user.clientId;

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    let flow = await WhatsAppFlow.findOne({ clientId, flowId });

    if (!flow) {
      flow = new WhatsAppFlow({
        clientId,
        flowId,
        name: `Automated Flow ${Date.now()}`,
        nodes,
        edges
      });
    } else {
      flow.nodes = nodes;
      flow.edges = edges;
    }

    await flow.save();

    // Legacy fallback: also save to Client model for compatibility
    await Client.updateOne({ clientId }, { flowNodes: nodes, flowEdges: edges });

    res.json({ success: true, message: 'Draft saved successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/flow/publish
// Syncs draft to published state and increments version
router.post('/publish', protect, async (req, res) => {
  try {
    const { flowId } = req.body;
    const clientId = req.user.clientId;

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const FlowHistory = require('../models/FlowHistory');
    const flow = await WhatsAppFlow.findOne({ clientId, flowId });

    if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });

    // 1. Create a snapshot in FlowHistory
    await FlowHistory.create({
      clientId,
      flowId,
      version: flow.version,
      nodes: flow.publishedNodes,
      edges: flow.publishedEdges,
      publishedBy: req.user.name || req.user.email
    });

    // 2. Deactivate other flows for the same platform
    await WhatsAppFlow.updateMany(
      { clientId, platform: flow.platform, flowId: { $ne: flowId } },
      { $set: { status: 'DRAFT' } }
    );

    // 3. Sync draft to published
    flow.publishedNodes = flow.nodes;
    flow.publishedEdges = flow.edges;
    flow.status = 'PUBLISHED';
    flow.version += 1;
    flow.lastSyncedAt = Date.now();

    await flow.save();
    
    // Clear trigger cache to load the fresh flows
    const { clearTriggerCache } = require('../utils/triggerEngine');
    clearTriggerCache(clientId);

    res.json({ success: true, message: `Flow published successfully (v${flow.version})`, version: flow.version });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/flow/:flowId/versions
// Returns history of published versions
router.get('/:flowId/versions', protect, async (req, res) => {
  try {
    const { flowId } = req.params;
    const clientId = req.user.clientId;
    const FlowHistory = require('../models/FlowHistory');
    
    const history = await FlowHistory.find({ clientId, flowId }).sort({ version: -1 }).limit(20);
    res.json({ success: true, history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/flow/:flowId/rollback/:versionId
// Reverts published state to a previous version
router.post('/:flowId/rollback/:versionId', protect, async (req, res) => {
  try {
    const { flowId, versionId } = req.params;
    const clientId = req.user.clientId;

    const FlowHistory = require('../models/FlowHistory');
    const WhatsAppFlow = require('../models/WhatsAppFlow');

    const historyRecord = await FlowHistory.findById(versionId);
    if (!historyRecord) return res.status(404).json({ success: false, message: 'History record not found' });

    const flow = await WhatsAppFlow.findOne({ clientId, flowId });
    if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });

    // Rollback published state (doesn't affect current draft automatically unless desired)
    flow.publishedNodes = historyRecord.nodes;
    flow.publishedEdges = historyRecord.edges;
    flow.lastSyncedAt = Date.now();
    
    await flow.save();
    res.json({ success: true, message: `Rolled back to version ${historyRecord.version}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/flow/
// Root handler for frontend compatibility
// --- GET ALL FLOWS ---
router.get('/', protect, async (req, res) => {
  try {
    const clientId = (req.user.role === 'SUPER_ADMIN' && req.query.clientId) ? req.query.clientId : req.user.clientId;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    // Fetch from the source-of-truth collection
    const dbFlows = await WhatsAppFlow.find({ clientId });

    // Map and filter out any corrupted flows with missing IDs
    const flows = dbFlows
      .filter(f => f.flowId) // Strict filter for ghost flows with null IDs
      .map(f => ({
        id:          f.flowId,
        name:        f.name,
        platform:    f.platform || 'whatsapp',
        isActive:    f.status === 'PUBLISHED',
        folderId:    f.folderId || '',
        nodes:       f.nodes || [],
        edges:       f.edges || [],
        nodeCount:   f.nodes?.length || 0,
        edgeCount:   f.edges?.length || 0,
        createdAt:   f.createdAt,
        updatedAt:   f.updatedAt,
        status:      f.status || 'DRAFT'
      }));

    res.json({ success: true, flows });
  } catch (err) {
    console.error('Error fetching flows:', err);
    res.status(500).json({ error: 'Failed to fetch flows' });
  }
});


// GET /api/flow/flows
router.get('/flows', protect, async (req, res) => {
  try {
    const clientId = req.query.clientId || req.user.clientId;
    
    // Auth validation
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to flows' });
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const dbFlows = await WhatsAppFlow.find({ clientId });
    const formattedFlows = dbFlows.map(f => ({
      id: f.flowId,
      name: f.name,
      platform: f.platform || 'whatsapp',
      folderId: f.folderId || '',
      isActive: f.status === 'PUBLISHED',
      status: f.status || 'DRAFT',
      version: f.version || 1,
      nodes: f.nodes || [],
      edges: f.edges || [],
      nodeCount: (f.nodes || []).length,
      edgeCount: (f.edges || []).length,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      lastSyncedAt: f.lastSyncedAt
    }));

    res.json({ 
      success: true, 
      flows: formattedFlows,
      flowFolders: client.flowFolders || [],
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

// POST /api/flow/:flowId/duplicate
// Creates a copy of a flow with a new flowId
router.post('/:flowId/duplicate', protect, async (req, res) => {
  try {
    const { flowId } = req.params;
    const clientId = req.user.clientId;
    const WhatsAppFlow = require('../models/WhatsAppFlow');

    const original = await WhatsAppFlow.findOne({ clientId, flowId });
    if (!original) return res.status(404).json({ success: false, message: 'Flow not found' });

    const newFlowId = `flow_${Date.now()}`;
    const clone = new WhatsAppFlow({
      clientId,
      flowId: newFlowId,
      name: `${original.name} (Copy)`,
      platform: original.platform || 'whatsapp',
      folderId: original.folderId || '',
      status: 'DRAFT',
      version: 1,
      nodes: JSON.parse(JSON.stringify(original.nodes || [])),
      edges: JSON.parse(JSON.stringify(original.edges || [])),
    });

    await clone.save();
    res.json({
      success: true,
      message: 'Flow duplicated successfully',
      newFlowId,
      flow: {
        id: newFlowId,
        name: clone.name,
        platform: clone.platform,
        folderId: clone.folderId,
        status: 'DRAFT',
        nodes: clone.nodes,
        edges: clone.edges,
        createdAt: clone.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/flow/:flowId/summary
// Brief stats card data: entry count, dropoff rate, last published
router.get('/:flowId/summary', protect, async (req, res) => {
  try {
    const { flowId } = req.params;
    const clientId = req.user.clientId;

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const FlowHistory = require('../models/FlowHistory');

    const [flow, history] = await Promise.all([
      WhatsAppFlow.findOne({ clientId, flowId }, 'name version status lastSyncedAt nodes edges').lean(),
      FlowHistory.countDocuments({ clientId, flowId })
    ]);

    if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });

    res.json({
      success: true,
      summary: {
        name:       flow.name,
        version:    flow.version,
        status:     flow.status,
        nodeCount:  (flow.nodes || []).length,
        edgeCount:  (flow.edges || []).length,
        totalVersions: history,
        lastPublishedAt: flow.lastSyncedAt || null,
      }
    });
  } catch (error) {
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

// DELETE /api/flow/:flowId
// Deletes a flow from WhatsAppFlow and removes it from Client's visualFlows
router.delete('/:flowId', protect, async (req, res) => {
  try {
    const { flowId } = req.params;
    const clientId = (req.user.role === 'SUPER_ADMIN' && req.query.clientId) ? req.query.clientId : req.user.clientId;

    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    console.log(`[FlowDelete] Deleting flow ${flowId} for client ${clientId}`);

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    // 1. Delete from WhatsAppFlow collection (The main source of truth)
    // Try by flowId first, fallback to _id if flowId looks like an ObjectId
    let deleteResult = await WhatsAppFlow.findOneAndDelete({ clientId, flowId });
    if (!deleteResult && /^[0-9a-fA-F]{24}$/.test(flowId)) {
      deleteResult = await WhatsAppFlow.findOneAndDelete({ clientId, _id: flowId });
    }

    // 2. Comprehensive cleanup of the Client document
    // We pull from visualFlows by BOTH 'id' and 'flowModelId' to catch all mapping variations
    await Client.updateOne(
      { clientId },
      { 
        $pull: { 
          visualFlows: { 
            $or: [
              { id: flowId },
              { flowModelId: flowId }
            ]
          } 
        } 
      }
    );

    // 3. LEGACY CLEANUP: If this was the "Main" flow stored in flowNodes, clear it
    // to prevent the UI from reconstructing a ghost flow from stale fields.
    const client = await Client.findOne({ clientId }).select('flowNodes flowEdges visualFlows');
    if (client) {
      // If no flows remain in visualFlows, or if this flow was active, clear legacy fields
      const remainingFlows = client.visualFlows || [];
      if (remainingFlows.length === 0) {
        await Client.updateOne({ clientId }, { $set: { flowNodes: [], flowEdges: [] } });
        console.log(`[FlowDelete] Cleared legacy flowNodes for ${clientId} (zero flows remaining)`);
      }
    }

    res.json({ success: true, message: 'Flow deleted and state synchronized successfully' });
  } catch (error) {
    console.error('[FlowDelete] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
