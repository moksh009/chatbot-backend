/**
 * routes/validation.js
 * TopEdge AI — Phase 19: Pre-flight Validation API
 */
const express = require('express');
const router  = express.Router();
const { protect, verifyClientAccess } = require('../middleware/auth');
const Client  = require('../models/Client');
const {
  validateTemplateForSend,
  validateEmailConfig,
  validateCampaign,
  validateAutomationFlow,
  validateFlowNode,
  getSystemHealth
} = require('../utils/validator');

// All routes require authentication
router.use(protect);

// ── Pre-flight check for campaign before sending ─────────────────────────────
router.post('/:clientId/campaign', verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ valid: false, errors: [{ code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }], warnings: [] });

    const result = await validateCampaign(client, req.body);
    res.json(result);
  } catch (err) {
    console.error('[validate/campaign]', err.message);
    res.status(500).json({ valid: false, errors: [{ code: 'SERVER_ERROR', message: err.message }], warnings: [] });
  }
});

// ── Pre-flight check for a single template send ──────────────────────────────
router.post('/:clientId/template', verifyClientAccess, async (req, res) => {
  try {
    const { templateName, variables } = req.body;
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ valid: false, errors: [{ code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }], warnings: [] });

    const result = await validateTemplateForSend(client, templateName, variables || []);
    res.json(result);
  } catch (err) {
    console.error('[validate/template]', err.message);
    res.status(500).json({ valid: false, errors: [{ code: 'SERVER_ERROR', message: err.message }], warnings: [] });
  }
});

// ── Validate entire flow before publishing ───────────────────────────────────
router.post('/:clientId/flow', verifyClientAccess, async (req, res) => {
  try {
    const { nodes = [], edges = [] } = req.body;
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ valid: false, errors: [{ code: 'CLIENT_NOT_FOUND', message: 'Client not found.' }], warnings: [] });

    const allErrors   = [];
    const allWarnings = [];

    // Flatten nested nodes (handle group/folder nodes)
    const flattenNodes = (nodeList) => {
      const flat = [];
      for (const n of nodeList) {
        flat.push(n);
        if (n.children) flat.push(...flattenNodes(n.children));
      }
      return flat;
    };

    const flat = flattenNodes(nodes);

    flat.forEach(node => {
      const result = validateFlowNode(node, client);
      allErrors.push(...result.errors);
      allWarnings.push(...result.warnings);
    });

    // Structural check: must have a trigger
    const hasTrigger = flat.some(n => n.type === 'TriggerNode' || n.type === 'trigger');
    if (!hasTrigger && flat.length > 0) {
      allWarnings.push({
        code:    'NO_TRIGGER',
        nodeId:  null,
        message: 'Flow has no Trigger node. The bot may not start automatically.',
        fix:     'Add a Trigger node at the beginning of your flow.'
      });
    }

    // Structural check: disconnected nodes warning
    if (edges.length === 0 && flat.length > 1) {
      allWarnings.push({
        code:    'NO_CONNECTIONS',
        nodeId:  null,
        message: 'No edges connecting your nodes. The flow will not advance.',
        fix:     'Connect your nodes with arrows in the Flow Builder.'
      });
    }

    res.json({ valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings });
  } catch (err) {
    console.error('[validate/flow]', err.message);
    res.status(500).json({ valid: false, errors: [{ code: 'SERVER_ERROR', message: err.message }], warnings: [] });
  }
});

// ── Check automation flow health ─────────────────────────────────────────────
router.get('/:clientId/automations', verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({});

    const flowTypes = ['abandoned_cart', 'cod_to_prepaid', 'review_collection', 'birthday'];
    const results   = {};

    for (const flowType of flowTypes) {
      results[flowType] = await validateAutomationFlow(client, flowType);
    }

    res.json(results);
  } catch (err) {
    console.error('[validate/automations]', err.message);
    res.status(500).json({});
  }
});

// ── System health check ───────────────────────────────────────────────────────
router.get('/:clientId/system-health', verifyClientAccess, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ overallStatus: 'error', checks: [] });

    const health = await getSystemHealth(client);
    res.json(health);
  } catch (err) {
    console.error('[validate/system-health]', err.message);
    res.status(500).json({ overallStatus: 'error', checks: [] });
  }
});

module.exports = router;
