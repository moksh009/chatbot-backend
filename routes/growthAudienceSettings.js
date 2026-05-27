'use strict';

const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');

/** Cart recovery / marketing consent settings (still used by cron and public flows). */
function mountGrowthAudienceSettingsRoutes(router) {
  router.get('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const doc = await Client.findOne({ clientId }).select('growthCompliance growthWidgetConfig').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
      const compliance = doc.growthCompliance || {};
      res.json({
        success: true,
        compliance: {
          cartRecoveryRequiresOptIn: compliance.cartRecoveryRequiresOptIn === true,
          defaultOptInPolicy: compliance.defaultOptInPolicy || 'single',
          applyPolicyToNewSignups: compliance.applyPolicyToNewSignups !== false,
          stopKeywords: compliance.stopKeywords?.length
            ? compliance.stopKeywords
            : ['STOP', 'UNSUBSCRIBE', 'OPT OUT', 'REMOVE', 'CANCEL'],
          doubleOptInEnabled: doc.growthWidgetConfig?.doubleOptInEnabled === true,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  router.put('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const updates = {};
      if (req.body.cartRecoveryRequiresOptIn !== undefined) {
        updates['growthCompliance.cartRecoveryRequiresOptIn'] = req.body.cartRecoveryRequiresOptIn === true;
      }
      if (req.body.defaultOptInPolicy) {
        updates['growthCompliance.defaultOptInPolicy'] =
          req.body.defaultOptInPolicy === 'double' ? 'double' : 'single';
      }
      if (req.body.applyPolicyToNewSignups !== undefined) {
        updates['growthCompliance.applyPolicyToNewSignups'] = req.body.applyPolicyToNewSignups !== false;
      }
      if (Array.isArray(req.body.stopKeywords)) {
        updates['growthCompliance.stopKeywords'] = req.body.stopKeywords
          .map((k) => String(k || '').trim().toUpperCase())
          .filter(Boolean);
      }
      const widgetUpdates = {};
      if (req.body.doubleOptInEnabled !== undefined) {
        widgetUpdates['growthWidgetConfig.doubleOptInEnabled'] = req.body.doubleOptInEnabled === true;
      }
      const doc = await Client.findOneAndUpdate(
        { clientId },
        { $set: { ...updates, ...widgetUpdates } },
        { new: true }
      ).select('growthCompliance growthWidgetConfig');
      if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
      res.json({
        success: true,
        compliance: doc.growthCompliance || {},
        growthWidgetConfig: doc.growthWidgetConfig,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = { mountGrowthAudienceSettingsRoutes };
