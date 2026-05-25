const express = require('express');
const rateLimit = require('express-rate-limit');
const AdLead = require('../models/AdLead');
const SuppressionList = require('../models/SuppressionList');
const { cancelAllAutomationsFor } = require('../utils/messaging/cancelAllAutomationsFor');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/unsubscribe/:token', limiter, async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).send('<h3>Invalid unsubscribe token</h3>');
  const lead = await AdLead.findOne({ 'channelConsent.email.unsubscribeToken': token })
    .select('_id email')
    .lean();
  if (!lead) return res.status(404).send('<h3>This unsubscribe link is invalid or expired.</h3>');
  return res.send(
    `<html><body><h3>Confirm unsubscribe</h3><form method="POST"><button type="submit">Unsubscribe ${lead.email || ''}</button></form></body></html>`
  );
});

router.post('/unsubscribe/:token', limiter, async (req, res) => {
  const token = String(req.params.token || '').trim();
  const lead = await AdLead.findOne({ 'channelConsent.email.unsubscribeToken': token });
  if (!lead) return res.status(404).json({ success: false, message: 'Invalid token' });

  lead.channelConsent = lead.channelConsent || {};
  lead.channelConsent.email = lead.channelConsent.email || {};
  lead.channelConsent.email.status = 'opted_out';
  lead.channelConsent.email.unsubscribeAt = new Date();
  lead.channelConsent.email.lastUpdated = new Date();
  lead.optStatus = 'opted_out';
  await lead.save();

  await SuppressionList.findOneAndUpdate(
    { clientId: lead.clientId, phone: (lead.email || '').toLowerCase(), channel: 'email' },
    { $set: { reason: 'opted_out', source: 'unsubscribe_link', addedAt: new Date() } },
    { upsert: true }
  );
  await cancelAllAutomationsFor({
    clientId: lead.clientId,
    leadId: lead._id,
    phone: lead.phoneNumber,
    reason: 'unsubscribe_link',
    channels: 'all',
    actor: {
      type: 'lead',
      leadId: lead._id,
      source: 'unsubscribe_link',
      ip: req.ip || req.headers['x-forwarded-for'] || '',
      userAgent: req.headers['user-agent'] || '',
    },
  });

  const io = req.app.get('socketio');
  if (io) io.to(`client_${lead.clientId}`).emit('lead_email_opted_out', { leadId: String(lead._id) });
  return res.json({ success: true, message: 'You have been unsubscribed.' });
});

module.exports = router;
