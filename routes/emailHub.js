'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const {
  getEmailHubSummary,
  getEmailHubLogs,
  getEmailHubSequenceMails,
  getEmailHubAudience,
  exportEmailHubAudienceCsv,
  getEmailHubTemplateStats,
  getEmailHubAnalytics,
  sendEmailHubOne,
  sendEmailHubBulk,
} = require('../services/emailHubService');
const {
  listEmailTemplates,
  getEmailTemplate,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  migrateLocalTemplates,
} = require('../services/emailTemplateService');

router.get('/:clientId/summary', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubSummary(req.params.clientId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load email summary' });
  }
});

router.get('/:clientId/logs', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubLogs(req.params.clientId, {
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      source: req.query.source,
      days: req.query.days,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load email logs' });
  }
});

router.get('/:clientId/sequence-mails', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubSequenceMails(req.params.clientId, {
      limit: req.query.limit,
      status: req.query.status,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load sequence emails' });
  }
});

router.get('/:clientId/audience', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubAudience(req.params.clientId, {
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      filter: req.query.filter,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load email audience' });
  }
});

router.get('/:clientId/audience/export', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await exportEmailHubAudienceCsv(req.params.clientId, {
      filter: req.query.filter,
      search: req.query.search,
    });
    const filename = `email-audience-${data.filter}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data.csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to export audience' });
  }
});

router.patch('/:clientId/audience/:leadId/email-consent', protect, verifyTenantScope(), async (req, res) => {
  try {
    const { setLeadEmailConsent } = require('../utils/core/emailConsentService');
    const data = await setLeadEmailConsent({
      clientId: req.params.clientId,
      leadId: req.params.leadId,
      status: req.body?.status,
      source: 'dashboard:email_hub',
      actorUserId: req.user?.id || req.user?._id,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to update email consent',
    });
  }
});

router.get('/:clientId/consent-events', protect, verifyTenantScope(), async (req, res) => {
  try {
    const { getEmailConsentEvents } = require('../utils/core/emailConsentService');
    const data = await getEmailConsentEvents(req.params.clientId, {
      limit: req.query.limit,
      days: req.query.days,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load consent events' });
  }
});

router.get('/:clientId/template-stats', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubTemplateStats(req.params.clientId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load template stats' });
  }
});

router.post('/:clientId/send', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await sendEmailHubOne(req.params.clientId, req.body || {}, req.user?._id);
    res.json({ success: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      success: false,
      message:
        status === 404
          ? 'Workspace not found. Refresh the page or sign in again.'
          : err.message || 'Failed to send email',
      code: err.code,
      unknownTokens: err.unknownTokens,
      supportedTokens: err.supportedTokens,
    });
  }
});

router.post('/:clientId/bulk-send', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await sendEmailHubBulk(req.params.clientId, req.body || {}, req.user?._id);
    res.status(data.success ? 200 : 422).json({ success: data.success, data });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.message || 'Failed to send bulk email',
      code: err.code,
      unknownTokens: err.unknownTokens,
      supportedTokens: err.supportedTokens,
    });
  }
});

router.get('/:clientId/analytics', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubAnalytics(req.params.clientId, { period: req.query.period });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load analytics' });
  }
});

router.get('/:clientId/templates', protect, verifyTenantScope(), async (req, res) => {
  try {
    const rows = await listEmailTemplates(req.params.clientId, {
      category: req.query.category,
      search: req.query.search,
    });
    res.json({ success: true, data: { templates: rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load templates' });
  }
});

router.post('/:clientId/templates/migrate', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await migrateLocalTemplates(
      req.params.clientId,
      req.body?.templates || [],
      req.user?._id
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Migration failed' });
  }
});

router.post('/:clientId/templates', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await createEmailTemplate(req.params.clientId, req.body || {}, req.user?._id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to create template' });
  }
});

router.get('/:clientId/templates/:id', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailTemplate(req.params.clientId, req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load template' });
  }
});

router.put('/:clientId/templates/:id', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await updateEmailTemplate(req.params.clientId, req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to update template' });
  }
});

router.delete('/:clientId/templates/:id', protect, verifyTenantScope(), async (req, res) => {
  try {
    await deleteEmailTemplate(req.params.clientId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to delete template' });
  }
});

router.post('/:clientId/templates/:id/duplicate', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await duplicateEmailTemplate(req.params.clientId, req.params.id, req.user?._id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to duplicate template' });
  }
});

module.exports = router;
