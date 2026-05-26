const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { protect } = require('../middleware/auth');
const { clearClientCache, apiCache } = require('../middleware/apiCache');
const { invalidateClientCache } = require('../utils/core/clientCache');
const {
  getCachedFlowGraphAsync,
  setCachedFlowGraph,
  invalidateFlowGraphCache,
} = require('../utils/flow/flowGraphCache');
const { fixFlowWithAI } = require('../controllers/flowFixController');
const { clearTriggerCache } = require('../utils/flow/triggerEngine');

router.post('/fix', protect, fixFlowWithAI);

/**
 * POST /api/flow/generate-from-wizard
 * Builds the multi-flow commerce pack (main + abandoned cart + COD confirmation, etc.),
 * persists optional wizard payload to the client, and creates draft WhatsAppFlow docs.
 */
router.post('/generate-from-wizard', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const body = req.body || {};
    const persist = body.persist !== false;

    if (persist) {
      const { universalFeaturesToWizardFeatures } = require('../utils/commerce/universalCommerceMapper');
      const featuresObj = body.features || body.onboardingData?.features;
      const wfSet = {};
      if (featuresObj && typeof featuresObj === 'object' && Object.keys(featuresObj).length > 0) {
        const flat = universalFeaturesToWizardFeatures(featuresObj);
        for (const [k, v] of Object.entries(flat)) {
          if (v !== undefined) wfSet[`wizardFeatures.${k}`] = v;
        }
        wfSet['onboardingData.features'] = featuresObj;
      }
      const step1 = body.step1 || body.onboardingData?.step1 || {};
      const brandName = body.brandName || step1.brandName;
      const supportPhone = body.supportPhone || step1.supportPhone;
      const supportEmail = body.supportEmail || step1.supportEmail;
      const industry = body.industry || step1.industry || body.onboardingData?.industry;
      const websiteUrl = body.websiteUrl || step1.websiteUrl || body.onboardingData?.websiteUrl;

      const $set = { ...wfSet };
      if (brandName) {
        $set['onboardingData.brandName'] = brandName;
        $set.businessName = brandName;
        $set.name = brandName;
        $set['platformVars.brandName'] = brandName;
      }
      if (industry) $set['onboardingData.industry'] = industry;
      if (supportPhone) {
        $set['platformVars.supportWhatsapp'] = supportPhone;
        $set.adminPhone = supportPhone;
      }
      if (supportEmail) {
        $set['platformVars.supportEmail'] = supportEmail;
        $set.adminEmail = supportEmail;
      }
      if (body.botName) {
        $set['ai.persona.name'] = body.botName;
        $set['platformVars.agentName'] = body.botName;
      }
      if (body.primaryLanguage) $set['ai.persona.language'] = body.primaryLanguage;
      if (body.brandTone) {
        $set['ai.persona.tone'] = body.brandTone;
        $set['platformVars.defaultTone'] = body.brandTone;
      }
      if (body.aiKnowledgeBaseText) {
        $set['ai.persona.knowledgeBase'] = String(body.aiKnowledgeBaseText).slice(0, 12000);
      }
      if (body.facebookCatalogId != null && String(body.facebookCatalogId).trim()) {
        $set.facebookCatalogId = String(body.facebookCatalogId).trim();
      }
      if (body.adminAlerts && typeof body.adminAlerts === 'object') {
        $set['onboardingData.adminAlerts'] = body.adminAlerts;
      }
      if (brandName || supportPhone || supportEmail || industry || websiteUrl || Object.keys(step1).length) {
        $set['onboardingData.step1'] = {
          ...step1,
          ...(brandName ? { brandName } : {}),
          ...(supportPhone ? { supportPhone } : {}),
          ...(supportEmail ? { supportEmail } : {}),
          ...(industry ? { industry } : {}),
          ...(websiteUrl ? { websiteUrl } : {}),
        };
      }

      if (Object.keys($set).length > 0) {
        await Client.updateOne({ clientId }, { $set });
      }
    }

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const { generateCommerceWizardPack } = require('../utils/flow/flowGenerator');
    const { createFlowsFromCommercePack } = require('../utils/flow/wizardCommercePackPersist');
    const pack = await generateCommerceWizardPack(client, body);

    const folderId = body.folderId || '';
    const persisted = await createFlowsFromCommercePack(clientId, pack.flows, {
      generatedBy: 'commerce_wizard_v2',
      status: 'DRAFT',
      idPrefix: 'flow_gfw',
      folderId,
      visualInlineGraph: true,
      visualMaxNodes: -1,
    });

    const created = persisted.created.map((c) => ({
      id: c.flowId,
      slug: c.f.slug,
      name: c.f.name,
      isAutomation: !!c.f.isAutomation,
      automationTrigger: c.f.automationTrigger || '',
      nodeCount: (c.f.nodes || []).length,
      edgeCount: (c.f.edges || []).length,
    }));

    for (const entry of persisted.visualEntries) {
      await Client.updateOne({ clientId }, { $push: { visualFlows: entry } });
    }

    await clearClientCache(clientId);
    clearTriggerCache(clientId);

    res.json({
      success: true,
      flows: created,
      automationFlows: pack.automationFlows || [],
    });
  } catch (err) {
    console.error('[POST /flow/generate-from-wizard]', err);
    res.status(500).json({ success: false, message: err.message || 'Generation failed' });
  }
});

// POST /api/flow — create draft flow (canonical WhatsAppFlow + Client.visualFlows append)
router.post('/', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const body = req.body || {};
    const name = String(body.name || 'Untitled automation').trim();
    const platform = body.platform || 'whatsapp';
    const folderId = body.folderId || '';
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    const edges = Array.isArray(body.edges) ? body.edges : [];

    const flowId = `flow_${Date.now()}`;
    await WhatsAppFlow.create({
      clientId,
      flowId,
      name: name || 'Untitled automation',
      platform,
      folderId,
      status: 'DRAFT',
      version: 1,
      nodes,
      edges,
      publishedNodes: [],
      publishedEdges: [],
    });

    await Client.updateOne(
      { clientId },
      {
        $push: {
          visualFlows: {
            id: flowId,
            name: name || 'Untitled automation',
            platform,
            folderId,
            isActive: false,
            nodes,
            edges,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      }
    );

    await clearClientCache(clientId);

    res.json({
      success: true,
      flow: {
        id: flowId,
        name: name || 'Untitled automation',
        platform,
        folderId,
        nodes,
        edges,
        isActive: false,
        status: 'DRAFT',
      },
    });
  } catch (err) {
    console.error('[POST /flow] create error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to create flow' });
  }
});

// POST /api/flow/ai-build — removed Phase 6 (use POST /api/flow/generate)
router.post('/ai-build', protect, (req, res) => {
  return res.status(410).json({
    success: false,
    error: 'gone',
    message: 'This endpoint was removed. Use POST /api/flow/generate instead.',
    canonical: '/api/flow/generate',
  });
});

// POST /api/flow/simulate
// Processes a simulation step on the backend without hitting WhatsApp API
router.post('/simulate', protect, async (req, res) => {
  try {
    const { flowId, currentNodeId, userInput, variables, nodes, edges } = req.body;
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    
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
      } else if (currentNode?.type === 'review') {
        const textLower = String(userInput || '').toLowerCase();
        let sourceHandle = '';
        if (
          textLower.includes('excellent') ||
          textLower.includes('great') ||
          textLower.includes('good') ||
          textLower.includes('love') ||
          textLower.includes('5') ||
          textLower.includes('4') ||
          textLower.includes('positive')
        ) {
          sourceHandle = 'positive';
        } else if (
          textLower.includes('bad') ||
          textLower.includes('poor') ||
          textLower.includes('issue') ||
          textLower.includes('negative') ||
          textLower.includes('1') ||
          textLower.includes('2')
        ) {
          sourceHandle = 'negative';
        } else if (textLower.includes('average') || textLower.includes('3')) {
          sourceHandle = 'negative';
        }
        edgeUsed = outgoingEdges.find(e => String(e.sourceHandle || '') === sourceHandle) || null;
      } else if (currentNode?.type === 'order_action') {
        const act = String(currentNode?.data?.actionType || currentNode?.data?.action || 'CHECK_ORDER_STATUS');
        if (act === 'CHECK_ORDER_STATUS') {
          const found = String(updatedVariables?.last_order_lookup_found || '').toLowerCase() === 'true';
          if (found) {
            edgeUsed =
              outgoingEdges.find(e => String(e.sourceHandle || '').toLowerCase() === 'success') ||
              outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output') ||
              null;
          } else {
            edgeUsed =
              outgoingEdges.find(e =>
                ['no_order', 'not_found', 'error'].includes(String(e.sourceHandle || '').toLowerCase())
              ) || null;
          }
        } else {
          edgeUsed =
            outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'output') ||
            outgoingEdges[0] ||
            null;
        }
      } else if (currentNode?.type === 'shopify_call') {
        const shopAct = String(currentNode?.data?.action || '');
        if (shopAct === 'CHECK_ORDER_STATUS') {
          const silent = !!currentNode?.data?.silent;
          const found = String(updatedVariables?.last_order_lookup_found || '').toLowerCase() === 'true';
          if (!found) {
            edgeUsed =
              outgoingEdges.find(e =>
                ['no_order', 'not_found', 'error'].includes(String(e.sourceHandle || '').toLowerCase())
              ) || null;
          } else if (silent) {
            edgeUsed = outgoingEdges.find(e => String(e.sourceHandle || '').toLowerCase() === 'success') || null;
          } else {
            edgeUsed =
              outgoingEdges.find(e => String(e.sourceHandle || '').toLowerCase() === 'success') ||
              outgoingEdges.find(e => !e.sourceHandle || e.sourceHandle === 'a') ||
              null;
          }
        } else {
          edgeUsed = outgoingEdges[0] || null;
        }
      } else if (currentNode?.type === 'warranty_check') {
        const branch = String(updatedVariables?._warranty_branch || 'active').toLowerCase();
        const normalized = ['active', 'expired', 'none'].includes(branch) ? branch : 'none';
        edgeUsed = outgoingEdges.find(e => String(e.sourceHandle || '') === normalized) || null;
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

// POST /api/flow/publish/:clientId — canonical publish (Phase 4)
router.post('/publish/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { denyUnlessTenant } = require('../utils/core/queryHelpers');
    if (!denyUnlessTenant(req, res, clientId)) return;
    const { publishFlowForClient } = require('../services/flowPublishService');
    const io = req.app.get('socketio');
    const result = await publishFlowForClient({
      clientId,
      flowId: req.body.flowId,
      nodes: req.body.nodes,
      edges: req.body.edges,
      publishedBy: req.user?.email || req.user?.name,
      forcePublish: !!req.body.forcePublish,
      io,
    });
    return res.json({ success: true, ...result });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      success: false,
      message: e.message,
      errors: e.errors,
      warnings: e.warnings,
    });
  }
});

// POST /api/flow/generate — canonical AI flow generation (Phase 4)
router.post('/generate', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { generateFlow } = require('../services/flowGeneration');
    const io = req.app.get('socketio');
    const out = await generateFlow({ clientId, ...req.body, user: req.user, io });
    return res.json({ success: true, ...out });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/publish', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { publishFlowForClient } = require('../services/flowPublishService');
    const io = req.app.get('socketio');
    const result = await publishFlowForClient({
      clientId,
      flowId: req.body.flowId,
      publishedBy: req.user?.email || req.user?.name,
      io,
    });
    return res.json({ success: true, message: `Flow published (v${result.versionNumber})`, ...result });
  } catch (e) {
    return res.status(e.status || 500).json({
      success: false,
      message: e.message,
      errors: e.errors,
      warnings: e.warnings,
    });
  }
});

// GET /api/flow/:flowId/versions
// Returns history of published versions
router.get('/:flowId/versions', protect, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/flow/:flowId/versions', req.user?.clientId || '');
  try {
    const { flowId } = req.params;
    const clientId = tenantClientId(req) || req.user.clientId;
    const FlowHistory = require('../models/FlowHistory');

    const history = await timer.time('FlowHistory.find', () =>
      FlowHistory.find({ clientId, flowId }).sort({ version: -1 }).limit(20).lean()
    );
    res.json({ success: true, history });
    timer.finish(`200 ok | count=${history.length}`);
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/flow/:flowId/rollback/:versionId
// Reverts published state to a previous version
router.post('/:flowId/rollback/:versionId', protect, async (req, res) => {
  try {
    const { flowId, versionId } = req.params;
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

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

// GET /api/flow/ — deprecated: use GET /api/flow/flows?lite=1 (no full node payloads)
router.get('/', protect, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { getCachedClient } = require('../utils/core/clientCache');
  const timer = createTimer('GET /api/flow/ (deprecated)', req.user?.clientId || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const [client, dbFlows] = await Promise.all([
      timer.time('getCachedClient', () => getCachedClient(clientId, 'flowFolders clientId')),
      timer.time('WhatsAppFlow.find_lite', () =>
        WhatsAppFlow.find({ clientId })
          .select('flowId name platform folderId status version createdAt updatedAt nodes edges')
          .lean()
      ),
    ]);

    const flows = dbFlows
      .filter((f) => f.flowId)
      .map((f) => ({
        id: f.flowId,
        name: f.name,
        platform: f.platform || 'whatsapp',
        isActive: f.status === 'PUBLISHED',
        folderId: f.folderId || '',
        nodeCount: Array.isArray(f.nodes) ? f.nodes.length : 0,
        edgeCount: Array.isArray(f.edges) ? f.edges.length : 0,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        status: f.status || 'DRAFT',
      }));

    res.setHeader('X-Deprecated-Endpoint', 'Use GET /api/flow/flows?lite=1 and GET /api/flow/flows/:flowId/graph');
    res.json({
      success: true,
      flows,
      flowFolders: client?.flowFolders || [],
      deprecated: true,
    });
    timer.finish(`200 ok | lite count=${flows.length}`);
  } catch (err) {
    console.error('Error fetching flows:', err);
    timer.finish(`500 error=${err.message}`);
    res.status(500).json({ error: 'Failed to fetch flows' });
  }
});


// GET /api/flow/flows
router.get('/flows', protect, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { getCachedClient } = require('../utils/core/clientCache');
  const timer = createTimer('GET /api/flow/flows', req.user?.clientId || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized access to flows' });
    }

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const { mergeFlowsListForDashboard } = require('../utils/flow/flowGraphResolver');
    const lite = req.query.lite === '1' || req.query.lite === 'true';
    const flowFind = WhatsAppFlow.find({ clientId });
    if (lite) {
      flowFind.select(
        'flowId name platform folderId status version createdAt updatedAt lastSyncedAt nodes edges publishedNodes publishedEdges'
      );
    }
    const clientSelect = lite
      ? 'flowFolders visualFlows clientId flowNodes flowEdges'
      : 'flowFolders flowNodes flowEdges visualFlows clientId';
    const [client, dbFlows] = await Promise.all([
      timer.time('getCachedClient', () => getCachedClient(clientId, clientSelect)),
      timer.time('WhatsAppFlow.find', () => flowFind.lean()),
    ]);
    if (!client) {
      timer.finish('404');
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const { resolveFlowGraphByRef } = require('../utils/flow/flowGraphResolver');
    const sources = {
      whatsappFlows: dbFlows,
      visualFlows: client.visualFlows || [],
      legacyNodes: client.flowNodes || [],
      legacyEdges: client.flowEdges || [],
      flowFolders: client.flowFolders || [],
    };

    const merged = mergeFlowsListForDashboard(
      dbFlows,
      client.visualFlows || [],
      client.flowFolders || [],
      client.flowNodes || [],
      client.flowEdges || []
    );

    const formattedFlows = [];
    for (const f of merged.flows) {
      let row = {
        ...f,
        ...(lite
          ? {}
          : (() => {
              const doc = dbFlows.find((d) => d.flowId === f.id);
              const vf = (client.visualFlows || []).find((v) => v.id === f.id);
              const nodes = doc?.nodes?.length
                ? doc.nodes
                : doc?.publishedNodes?.length
                  ? doc.publishedNodes
                  : vf?.nodes || [];
              const edges = doc?.edges?.length
                ? doc.edges
                : doc?.publishedEdges?.length
                  ? doc.publishedEdges
                  : vf?.edges || [];
              return { nodes, edges };
            })()),
      };

      if (!row.nodeCount || !row.edgeCount) {
        try {
          const resolved = await resolveFlowGraphByRef(clientId, f.id, { sources });
          if (resolved?.nodes?.length) {
            const { resolveFlowListCounts: countPair } = require('../utils/flow/flowGraphResolver');
            const c = countPair(resolved.nodes, null, resolved.edges || [], null, row);
            if (c.nodeCount > 0 || c.edgeCount > 0) {
              row = {
                ...row,
                nodeCount: Math.max(row.nodeCount || 0, c.nodeCount),
                edgeCount: Math.max(row.edgeCount || 0, c.edgeCount),
                graphSource: 'resolved',
              };
            }
          }
        } catch (resolveErr) {
          console.warn(`[Flow API] List count resolve failed for ${f.id}:`, resolveErr.message);
        }
      }

      formattedFlows.push(row);
    }

    res.json({
      success: true,
      flows: formattedFlows,
      flowFolders: merged.flowFolders,
      legacy: lite
        ? { nodes: [], edges: [] }
        : {
            nodes: client.flowNodes || [],
            edges: client.flowEdges || [],
          },
    });
    timer.finish(`200 ok | lite=${lite} count=${formattedFlows.length}`);
  } catch (error) {
    console.error('[Flow API] List error:', error);
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/flow/:flowId/duplicate
// Creates a copy of a flow with a new flowId
router.post('/:flowId/duplicate', protect, async (req, res) => {
  try {
    const { flowId } = req.params;
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });
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
    await clearClientCache(clientId);
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

async function runFlowOrganizeForClient(clientId, flowId) {
  const { applyCanvasLayout, countOrphanLayoutNodes } = require('../utils/flow/flowLayoutOrganize');
  const { loadClientFlowSources, resolveFlowGraphByRef } = require('../utils/flow/flowGraphResolver');
  const { persistFlowCanvasGraph } = require('../utils/flow/flowLayoutPersist');
  const { autoPatchMpmFlowNodes } = require('../utils/flow/flowMpmPatch');
  const sources = await loadClientFlowSources(clientId);
  let resolved = await resolveFlowGraphByRef(clientId, flowId, { sources });
  if (!resolved?.nodes?.length) {
    const { getCachedFlowGraphAsync } = require('../utils/flow/flowGraphCache');
    const cached = await getCachedFlowGraphAsync(clientId, flowId);
    if (cached?.nodes?.length) {
      resolved = {
        id: flowId,
        name: cached.name,
        nodes: cached.nodes,
        edges: cached.edges || [],
        status: cached.status,
        platform: cached.platform,
      };
    }
  }
  if (!resolved?.nodes?.length) {
    return { error: { status: 404, message: 'Flow not found' } };
  }

  const layout = applyCanvasLayout(resolved.nodes, resolved.edges || [], {
    keepPositions: true,
    addEntryEdges: true,
    stampSections: true,
    force: true,
  });

  let nodes = layout.nodes;
  let edges = layout.edges;

  const mpmResult = await autoPatchMpmFlowNodes(clientId, { flowId });
  if (mpmResult?.nodes?.length) {
    nodes = mpmResult.nodes;
  }

  await persistFlowCanvasGraph(clientId, flowId, nodes, edges, {
    name: resolved.name,
    platform: resolved.platform,
    status: resolved.status,
    layoutSpecVersion: layout.layoutSpecVersion,
  });
  await clearClientCache(clientId);

  return {
    success: true,
    flow: { id: flowId, nodes, edges },
    layoutSpecVersion: layout.layoutSpecVersion,
    orphansBefore: layout.orphansBefore,
    orphansAfter: countOrphanLayoutNodes(nodes),
    folderCount: nodes.filter((n) => n.type === 'folder').length,
    mpmPatched: mpmResult?.patched || 0,
    mpmNodesTotal: mpmResult?.mpmNodesTotal,
    mpmNodesWithIds: mpmResult?.mpmNodesWithIds,
    mpmNodeIdsMissing: mpmResult?.mpmNodeIdsMissing || [],
  };
}

// POST /api/flow/flows/:flowId/organize — folderize orphan nodes + optional MPM product fill
async function handleFlowOrganize(req, res) {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to flows' });
    }
    const { flowId } = req.params;
    const result = await runFlowOrganizeForClient(clientId, flowId);
    if (result.error) {
      return res.status(result.error.status).json({ success: false, message: result.error.message });
    }
    res.json(result);
  } catch (error) {
    console.error('[Flow API] Organize error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

router.post('/flows/:flowId/organize', protect, handleFlowOrganize);
router.post('/:flowId/organize', protect, handleFlowOrganize);

// GET /api/flow/flows/:flowId/graph — full nodes/edges for one flow (Flow Builder canvas)
router.get('/flows/:flowId/graph', protect, apiCache(30), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const timer = createTimer('GET /api/flow/flows/:flowId/graph', req.user?.clientId || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized access to flows' });
    }
    const { flowId } = req.params;

    const { flattenFlowNodes, resolveFlowGraphByRef, loadClientFlowSources } = require('../utils/flow/flowGraphResolver');

    let flowPayload = await timer.time('flow_graph_cache', () =>
      getCachedFlowGraphAsync(clientId, flowId)
    );

    if (!flowPayload?.nodes?.length) {
      const sources = await loadClientFlowSources(clientId);
      const resolved = await resolveFlowGraphByRef(clientId, flowId, { sources });
      if (!resolved?.nodes?.length) {
        timer.finish('404');
        return res.status(404).json({ success: false, message: 'Flow not found' });
      }
      const waDoc = sources.whatsappFlows.find((d) => d.flowId === flowId);
      const vf = sources.visualFlows.find((v) => v.id === flowId);
      const flatNodes = resolved.nodes;
      flowPayload = {
        flowId: resolved.id || flowId,
        name: resolved.name || waDoc?.name || vf?.name || 'Flow',
        platform: waDoc?.platform || vf?.platform || 'whatsapp',
        folderId: waDoc?.folderId || vf?.folderId || '',
        status: resolved.status || waDoc?.status || (vf?.isActive ? 'PUBLISHED' : 'DRAFT'),
        version: waDoc?.version || vf?.version || 1,
        nodes: flatNodes,
        edges: resolved.edges || [],
        createdAt: waDoc?.createdAt || vf?.createdAt,
        updatedAt: waDoc?.updatedAt || vf?.updatedAt,
        lastSyncedAt: waDoc?.lastSyncedAt,
      };
      setCachedFlowGraph(clientId, flowId, flowPayload);
    }

    const { applyCanvasLayout } = require('../utils/flow/flowLayoutOrganize');
    const { persistFlowCanvasGraph } = require('../utils/flow/flowLayoutPersist');
    const layout = applyCanvasLayout(flowPayload.nodes || [], flowPayload.edges || [], {
      keepPositions: true,
      addEntryEdges: true,
      stampSections: true,
    });
    const displayNodes = layout.nodes;
    const displayEdges = layout.edges;
    const flatCount = flattenFlowNodes(displayNodes).length;

    if (layout.layoutApplied && layout.orphansBefore > 0) {
      persistFlowCanvasGraph(clientId, flowId, displayNodes, displayEdges, {
        name: flowPayload.name,
        platform: flowPayload.platform,
        status: flowPayload.status,
        layoutSpecVersion: layout.layoutSpecVersion,
      })
        .then(() => clearClientCache(clientId))
        .catch((err) => console.warn('[Flow API] layout persist:', err?.message));
    }

    res.json({
      success: true,
      flow: {
        id: flowPayload.flowId,
        name: flowPayload.name,
        platform: flowPayload.platform || 'whatsapp',
        folderId: flowPayload.folderId || '',
        isActive: flowPayload.status === 'PUBLISHED',
        status: flowPayload.status || 'DRAFT',
        version: flowPayload.version || 1,
        nodes: displayNodes,
        edges: displayEdges,
        nodeCount: flatCount || displayNodes.length,
        edgeCount: displayEdges.length,
        layoutSpecVersion: layout.layoutSpecVersion,
        layoutOrganized: layout.layoutApplied,
        orphansBeforeLayout: layout.orphansBefore,
        createdAt: flowPayload.createdAt,
        updatedAt: flowPayload.updatedAt,
        lastSyncedAt: flowPayload.lastSyncedAt,
      },
    });
    timer.finish('200 ok');
  } catch (error) {
    console.error('[Flow API] Graph load error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/flow/:flowId/summary
// Brief stats card data: entry count, dropoff rate, last published
router.get('/:flowId/summary', protect, apiCache(60), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const timer = createTimer('GET /api/flow/:flowId/summary', req.user?.clientId || '');
  try {
    const { flowId } = req.params;
    const clientId = tenantClientId(req) || req.user.clientId;
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const FlowHistory = require('../models/FlowHistory');

    const payload = await dedupeAsync(`flow-summary:${clientId}:${flowId}`, async () => {
      const [flow, history] = await Promise.all([
        timer.time('WhatsAppFlow.findOne', () =>
          WhatsAppFlow.findOne({ clientId, flowId }, 'name version status lastSyncedAt nodes edges').lean()
        ),
        timer.time('FlowHistory.countDocuments', () => FlowHistory.countDocuments({ clientId, flowId })),
      ]);
      if (!flow) return null;
      return {
        name: flow.name,
        version: flow.version,
        status: flow.status,
        nodeCount: (flow.nodes || []).length,
        edgeCount: (flow.edges || []).length,
        totalVersions: history,
        lastPublishedAt: flow.lastSyncedAt || null,
      };
    });

    if (!payload) {
      timer.finish('404');
      return res.status(404).json({ success: false, message: 'Flow not found' });
    }

    res.json({ success: true, summary: payload });
    timer.finish('200 ok');
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});



router.get('/:clientId/analytics', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const { collectQuestionsBeforeFallbacks } = require('../utils/flow/flowIntelligenceAggregations');
  const timer = createTimer('GET /api/flow/unanswered-questions', req.params.clientId || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const payload = await dedupeAsync(`flow:unanswered:${clientId}`, async () => {
      const rows = await collectQuestionsBeforeFallbacks(clientId, { limit: 20 });
      const seenQueries = new Set();
      const unansweredQuestions = [];
      for (const row of rows) {
        const q = String(row.query || '').trim();
        if (!q) continue;
        const key = q.toLowerCase();
        if (seenQueries.has(key)) continue;
        seenQueries.add(key);
        unansweredQuestions.push({
          id: row.queryId,
          query: q,
          count: 1,
          date: row.date,
        });
      }
      return { unansweredQuestions };
    });

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
      unansweredQuestions: payload.unansweredQuestions,
      agentCorrections: [],
      aiSuggestions
    });
    timer.finish(`200 ok | unanswered=${payload.unansweredQuestions?.length ?? 0}`);

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
    const clientId = tenantClientId(req);

    if (!clientId) return res.status(403).json({ error: 'Unauthorized' });

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

    await clearClientCache(clientId);
    res.json({ success: true, message: 'Flow deleted and state synchronized successfully' });
  } catch (error) {
    console.error('[FlowDelete] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// BOT INTELLIGENCE API — Dedicated Endpoints
// ════════════════════════════════════════════════════════════════════

// POST /api/flow/:clientId/intelligence/answer
// Adds an answer to the knowledge base for a previously unanswered question
router.post('/:clientId/intelligence/answer', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { question, answer, category = 'faq' } = req.body;

    if (!question?.trim() || !answer?.trim()) {
      return res.status(400).json({ success: false, message: 'Question and answer are required' });
    }

    await Client.findOneAndUpdate(
      { clientId },
      {
        $push: {
          'knowledgeBase.faqs': {
            question: question.trim(),
            answer: answer.trim(),
            category,
            addedAt: new Date(),
            addedBy: req.user?._id || 'admin',
            source: 'bot_intelligence'
          }
        }
      }
    );

    res.json({ success: true, message: 'Answer added to knowledge base' });
  } catch (err) {
    console.error('[Intelligence] Answer save error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/flow/:clientId/intelligence/suggestions
// Clusters unanswered questions by keyword frequency to suggest new flows
router.get('/:clientId/intelligence/suggestions', protect, async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const { collectQuestionsBeforeFallbacks } = require('../utils/flow/flowIntelligenceAggregations');
  const timer = createTimer('GET /api/flow/intelligence/suggestions', req.params.clientId || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await dedupeAsync(`flow:intelligence:${clientId}`, () =>
      collectQuestionsBeforeFallbacks(clientId, { limit: 200, since: thirtyDaysAgo })
    );
    const questions = rows.map((r) => String(r.query || '').trim()).filter(Boolean);

    // Cluster by keyword frequency (stop-words filtered)
    const stopWords = new Set(['what','when','where','how','does','your','this','that','have',
      'the','and','for','are','you','can','will','with','from','about','please','help','want']);
    const wordFreq = {};
    questions.forEach(q => {
      q.toLowerCase().split(/\s+/).forEach(word => {
        if (word.length > 3 && !stopWords.has(word)) {
          wordFreq[word] = (wordFreq[word] || 0) + 1;
        }
      });
    });

    const suggestions = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .filter(([, count]) => count >= 2)
      .map(([word, count]) => ({
        id: `sug_${word}_${Date.now()}`,
        topic: word.charAt(0).toUpperCase() + word.slice(1),
        description: `${count} customers asked about "${word}" but received no answer`,
        frequency: count,
        suggestedFlow: `Create a flow to handle "${word}" inquiries automatically`,
        sampleQuestions: questions.filter(q => q.toLowerCase().includes(word)).slice(0, 3)
      }));

    res.json({ success: true, suggestions, totalUnanswered: questions.length });
    timer.finish(`200 ok | suggestions=${suggestions.length}`);
  } catch (err) {
    console.error('[Intelligence] Suggestions error:', err);
    timer.finish(`500 ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
