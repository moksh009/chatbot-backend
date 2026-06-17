'use strict';

const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const {
  validateCustomOptOutKeywords,
  serializeComplianceForApi,
  DEFAULT_OPT_OUT_AUTO_REPLY,
  DEFAULT_OPT_IN_AUTO_REPLY,
  MAX_KEYWORD_LENGTH,
} = require('../utils/commerce/marketingConsentConfig');

/** Cart recovery / marketing consent settings (cron, public flows, WhatsApp keywords). */
function mountGrowthAudienceSettingsRoutes(router) {
  router.get('/:clientId/growth-compliance', protect, verifyClientAccess, async (req, res) => {
    try {
      const { clientId } = req.params;
      const doc = await Client.findOne({ clientId }).select('growthCompliance growthWidgetConfig').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });
      res.json({
        success: true,
        compliance: serializeComplianceForApi(doc.growthCompliance || {}, doc.growthWidgetConfig || {}),
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

      const keywordPayload =
        req.body.customOptOutKeywords !== undefined ? req.body.customOptOutKeywords : req.body.stopKeywords;
      if (keywordPayload !== undefined) {
        const validation = validateCustomOptOutKeywords(keywordPayload);
        if (!validation.ok) {
          return res.status(400).json({ success: false, message: validation.message });
        }
        updates['growthCompliance.customOptOutKeywords'] = validation.normalized;
        updates['growthCompliance.stopKeywords'] = validation.normalized;
      }

      if (req.body.optOutAutoReplyMessage !== undefined) {
        const msg = String(req.body.optOutAutoReplyMessage || '').trim();
        if (msg.length > 1000) {
          return res.status(400).json({
            success: false,
            message: 'Opt-out auto-reply must be 1000 characters or less.',
          });
        }
        updates['growthCompliance.optOutAutoReplyMessage'] = msg;
      }

      if (req.body.optInAutoReplyMessage !== undefined) {
        const msg = String(req.body.optInAutoReplyMessage || '').trim();
        if (msg.length > 1000) {
          return res.status(400).json({
            success: false,
            message: 'Opt-in auto-reply must be 1000 characters or less.',
          });
        }
        updates['growthCompliance.optInAutoReplyMessage'] = msg;
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
        compliance: serializeComplianceForApi(doc.growthCompliance || {}, doc.growthWidgetConfig || {}),
        growthWidgetConfig: doc.growthWidgetConfig,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
}

module.exports = {
  mountGrowthAudienceSettingsRoutes,
  DEFAULT_OPT_OUT_AUTO_REPLY,
  DEFAULT_OPT_IN_AUTO_REPLY,
  MAX_KEYWORD_LENGTH,
};
