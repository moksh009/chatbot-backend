const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
router.put('/:clientId/working-hours', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { enabled, timezone, hours, afterHoursMessage } = req.body;
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { "workingHours.enabled": enabled, "workingHours.timezone": timezone, "workingHours.hours": hours, "workingHours.afterHoursMessage": afterHoursMessage } },
      { new: true }
    );
    res.json({ success: true, workingHours: client.workingHours });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/quick-replies', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId }).select('quickReplies');
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    res.json({ success: true, quickReplies: client.quickReplies || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/quick-replies', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { quickReplies } = req.body; // Array of objects
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { quickReplies } },
      { new: true }
    );
    res.json({ success: true, quickReplies: client.quickReplies });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/escalation-rules', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { escalationRules } = req.body; 
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { escalationRules } },
      { new: true }
    );
    res.json({ success: true, escalationRules: client.escalationRules });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/custom-variables', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId }).select('customVariables').lean();
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, customVariables: client.customVariables || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/custom-variables', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { customVariables } = req.body; // Array of objects
    
    if (Array.isArray(customVariables)) {
      for (const v of customVariables) {
        if (v.validationRegex) {
          try {
            new RegExp(v.validationRegex);
          } catch(e) {
            return res.status(400).json({ success: false, message: `Invalid regex pattern in variable ${v.name}` });
          }
        }
      }
    }
    
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: { customVariables } },
      { new: true }
    );
    res.json({ success: true, customVariables: client.customVariables });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const { mountGrowthAudienceSettingsRoutes } = require('./growthAudienceSettings');
mountGrowthAudienceSettingsRoutes(router);

// --- Website chat widget (Settings → Chat Widget) ---
const {
  mergeWebsiteWidgetConfig,
  buildWebsiteWidgetSettingsBundle,
} = require('../utils/core/websiteWidgetDefaults');
const { isWebsiteChatWidgetSettingsEnabled } = require('../utils/core/featureFlags');

router.get('/:clientId/website-chat-widget', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const doc = await Client.findOne({ clientId })
      .select('websiteChatWidgetConfig visualFlows businessName brand.businessName businessLogo')
      .lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });

    const origin = `${req.protocol}://${req.get('host')}`;
    const bundle = buildWebsiteWidgetSettingsBundle(doc, { clientId, origin });

    res.json({ success: true, ...bundle });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:clientId/website-chat-widget', protect, verifyClientAccess, async (req, res) => {
  try {
    if (!isWebsiteChatWidgetSettingsEnabled()) {
      return res.status(503).json({
        success: false,
        code: 'WEBSITE_WIDGET_SETTINGS_DISABLED',
        message: 'Website chat widget settings are coming soon. See docs/TOPEDGE-SYSTEM-REFERENCE.md Part K.',
      });
    }

    const { clientId } = req.params;
    const incoming = req.body?.websiteChatWidgetConfig || req.body || {};
    const merged = mergeWebsiteWidgetConfig(incoming);
    const doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { websiteChatWidgetConfig: merged } },
      { new: true }
    )
      .select('websiteChatWidgetConfig visualFlows businessName brand.businessName businessLogo')
      .lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Client not found' });

    const origin = `${req.protocol}://${req.get('host')}`;
    const bundle = buildWebsiteWidgetSettingsBundle(doc, { clientId, origin });

    res.json({
      success: true,
      ...bundle,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
