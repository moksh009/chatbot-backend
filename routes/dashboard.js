const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const { protect } = require('../middleware/auth');
const dashboardController = require('../controllers/dashboardController');

/**
 * Phase 29: Dashboard Utility Routes
 */

// POST /api/dashboard/batch-data
// @desc    Fetch data for multiple dashboard widgets in a single optimized request
// @access  Private
router.post('/batch-data', protect, dashboardController.getBatchData);

// Layout management
router.get('/layout', protect, dashboardController.getLayout);
router.post('/layout', protect, dashboardController.saveLayout);
router.delete('/layout/reset', protect, dashboardController.resetLayout);

// Individual widget data (for refresh intervals)
router.get('/widget/:widgetType', protect, (req, res) => {
  // Simple wrapper around batch-data logic for single widget
  req.body.widgets = [{ type: req.params.widgetType, config: req.query, id: 'req' }];
  dashboardController.getBatchData(req, res);
});

router.get('/forecast', protect, dashboardController.getForecast);
router.get('/competitors', protect, dashboardController.getCompetitorIntel); // Alias to original
router.get('/competitor-intel', protect, dashboardController.getCompetitorIntel);
router.get('/suppliers', protect, dashboardController.getSuppliers);
router.get('/restock-drafts', protect, dashboardController.getRestockDrafts);
router.get('/quality-stats', protect, dashboardController.getQualityStats);
router.post('/competitors', protect, dashboardController.createCompetitor);
router.post('/competitors/:id/battle-plan', protect, dashboardController.generateBattlePlan);
router.post('/suppliers', protect, dashboardController.createSupplier);
router.get('/flows', protect, dashboardController.getFlows);
router.post('/export-pdf', protect, async (req, res) => {
  try {
    const { generateDashboardPDF } = require('../utils/pdfExporter');
    const { widgetIds, period, data } = req.body;
    const client = await require('../models/Client').findOne({ clientId: req.user.clientId }).lean();
    
    if (!client) return res.status(404).json({ message: "Client not found" });

    const pdfBuffer = await generateDashboardPDF(client, data, { widgetIds, period });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=TopEdge_Report_${new Date().toISOString().split('T')[0]}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error("PDF Export error:", error);
    res.status(500).json({ message: "Failed to generate PDF" });
  }
});

module.exports = router;
