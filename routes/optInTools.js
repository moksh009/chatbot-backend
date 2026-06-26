'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { listTemplates } = require('../constants/optInToolTemplates');
const optInService = require('../services/optInToolsService');

const toolScope = verifyTenantScope({ lookupBy: 'optInTool', param: 'id' });

function resolveBackendUrl(req) {
  return (
    process.env.BACKEND_URL ||
    process.env.SERVER_URL ||
    `${req.protocol}://${req.get('host')}`
  );
}

/**
 * GET /api/opt-in-tools
 */
router.get('/', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

    const { status, type, search, fields } = req.query;
    const result = await optInService.listTools(clientId, { status, type, search, fields });
    return res.json({ success: true, ...result });
  } catch (e) {
    console.error('[optInTools] list', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/opt-in-tools/templates
 */
router.get('/templates', protect, async (req, res) => {
  try {
    const templates = listTemplates({
      type: req.query.type,
      search: req.query.search,
    });
    return res.json({ success: true, templates });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/brand-extract
 */
router.post('/brand-extract', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ success: false, message: 'url required' });
    const { extractBrandFromUrl } = require('../services/optInBrandExtractService');
    const brandKit = await extractBrandFromUrl(clientId, url);
    return res.json({ success: true, brandKit });
  } catch (e) {
    console.warn('[optInTools] brand-extract', e.message);
    return res.status(400).json({
      success: false,
      message: 'Could not read store — set colors manually.',
    });
  }
});

/**
 * GET /api/opt-in-tools/saved-templates
 */
router.get('/saved-templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });
    const { listSavedTemplates } = require('../services/optInSavedTemplatesService');
    const templates = await listSavedTemplates(clientId, { type: req.query.type });
    return res.json({ success: true, templates });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/saved-templates — save from tool id
 */
router.post('/saved-templates', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });
    const toolId = String(req.body.toolId || '').trim();
    if (!toolId) return res.status(400).json({ success: false, message: 'toolId required' });
    const { saveTemplateFromTool } = require('../services/optInSavedTemplatesService');
    const saved = await saveTemplateFromTool(clientId, toolId, req.body.name);
    if (!saved) return res.status(404).json({ success: false, message: 'Tool not found' });
    return res.status(201).json({ success: true, template: saved });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * DELETE /api/opt-in-tools/saved-templates/:savedId
 */
router.delete('/saved-templates/:savedId', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });
    const { deleteSavedTemplate } = require('../services/optInSavedTemplatesService');
    const deleted = await deleteSavedTemplate(clientId, req.params.savedId);
    if (!deleted) return res.status(404).json({ success: false, message: 'Template not found' });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/sync-theme — re-inject theme snippet
 */
router.post('/sync-theme', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });
    const result = await optInService.syncThemeEmbed(clientId, resolveBackendUrl(req));
    return res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (e) {
    console.error('[optInTools] sync-theme', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools
 */
router.post('/', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(400).json({ success: false, message: 'clientId required' });

    const savedTemplateId = String(req.body.savedTemplateId || '').trim();
    if (savedTemplateId) {
      const OptInSavedTemplate = require('../models/OptInSavedTemplate');
      const saved = await OptInSavedTemplate.findOne({ _id: savedTemplateId, clientId }).lean();
      if (!saved) return res.status(404).json({ success: false, message: 'Saved template not found' });
      const tool = await optInService.createTool(clientId, {
        type: saved.type,
        name: req.body.name || saved.name,
        design: saved.design,
        triggers: saved.triggers,
        prizes: saved.prizes,
        mysteryRevealType: saved.mysteryRevealType,
      });
      return res.status(201).json({ success: true, tool });
    }

    const tool = await optInService.createTool(clientId, req.body || {});
    return res.status(201).json({ success: true, tool });
  } catch (e) {
    console.error('[optInTools] create', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/opt-in-tools/:id
 */
router.get('/:id', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const tool = await optInService.getToolForClient(clientId, req.params.id);
    if (!tool) return res.status(404).json({ success: false, message: 'Tool not found' });
    const workspace = await optInService.getToolWorkspaceMeta(clientId);
    return res.json({ success: true, tool, workspace });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * PUT /api/opt-in-tools/:id
 */
router.put('/:id', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const tool = await optInService.updateTool(clientId, req.params.id, req.body || {});
    if (!tool) return res.status(404).json({ success: false, message: 'Tool not found' });
    return res.json({ success: true, tool });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/:id/duplicate
 */
router.post('/:id/duplicate', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const tool = await optInService.duplicateTool(clientId, req.params.id);
    if (!tool) return res.status(404).json({ success: false, message: 'Tool not found' });
    return res.status(201).json({ success: true, tool });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * DELETE /api/opt-in-tools/:id
 */
router.delete('/:id', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const result = await optInService.deleteTool(clientId, req.params.id);
    if (!result.deleted) {
      const status = result.reason === 'not_found' ? 404 : 400;
      return res.status(status).json({ success: false, ...result });
    }
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/:id/publish
 */
router.post('/:id/publish', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const result = await optInService.publishTool(clientId, req.params.id, resolveBackendUrl(req));
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    return res.json(result);
  } catch (e) {
    console.error('[optInTools] publish', e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/:id/unpublish
 */
router.post('/:id/unpublish', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const result = await optInService.unpublishTool(clientId, req.params.id);
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/opt-in-tools/:id/report — conversion analytics
 */
router.get('/:id/report', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const { buildToolConversionReport } = require('../services/optInAnalyticsService');
    const report = await buildToolConversionReport(clientId, req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Tool not found' });
    return res.json({ success: true, report });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/opt-in-tools/:id/report/export — CSV download
 */
router.get('/:id/report/export', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const { buildToolConversionReport, reportToCsv } = require('../services/optInAnalyticsService');
    const report = await buildToolConversionReport(clientId, req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Tool not found' });
    const csv = reportToCsv(report);
    const safeName = String(report.tool?.name || 'opt-in-tool').replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-report.csv"`);
    return res.send(csv);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * POST /api/opt-in-tools/:id/generate-coupons
 */
router.post('/:id/generate-coupons', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const { replenishCouponPool } = require('../services/optInCouponService');
    const result = await replenishCouponPool(clientId, req.params.id);
    return res.json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

/**
 * GET /api/opt-in-tools/:id/coupon-pool
 */
router.get('/:id/coupon-pool', protect, toolScope, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    const OptInTool = require('../models/OptInTool');
    const tool = await OptInTool.findOne({ _id: req.params.id, clientId }).select('couponPool').lean();
    if (!tool) return res.status(404).json({ success: false, message: 'Tool not found' });
    const pool = tool.couponPool || [];
    const available = pool.filter((p) => !p.used).length;
    return res.json({ success: true, pool: { available, total: pool.length, pending: 0 } });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
