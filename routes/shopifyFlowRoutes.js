"use strict";

/**
 * shopifyFlowRoutes.js — Phase 26 Track 7: Shopify Flow Integration
 * Allows Shopify Flow to trigger TopEdge automations via HTTP.
 *
 * POST /api/shopify-flow/:clientId/trigger
 *   Header: X-TopEdge-Key: {client.shopifyFlowWebhookKey}
 *   Body:   { trigger, phone, data }
 *
 * Supported triggers:
 *   enroll_sequence  → data: { sequenceId }
 *   send_message     → data: { message }
 *   add_tag          → data: { tags: ["vip"] }
 *   update_score     → data: { scoreChange: +20 }
 *   trigger_flow     → data: { flowId }
 *   send_template    → data: { templateName, variables: [] }
 */

const express    = require('express');
const router     = express.Router();
const Client     = require('../models/Client');
const AdLead     = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const log        = require('../utils/logger')('ShopifyFlow');

// Helper: send a WhatsApp text message
async function sendWAText(client, phone, text) {
  const axios = require('axios');
  const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId;
  const token         = client.whatsappToken  || client.whatsapp?.accessToken;
  if (!phoneNumberId || !token || !phone) return;

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:  phone.replace(/\D/g, ''),
      type:'text',
      text:{ body: text, preview_url: false }
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
}

// ── POST /api/shopify-flow/:clientId/trigger ──────────────
router.post('/:clientId/trigger', async (req, res) => {
  // Always respond 200 immediately (Shopify Flow requires quick response)
  res.status(200).json({ received: true });

  try {
    const secret = req.headers['x-topedge-key'];
    if (!secret) {
      log.warn('Missing X-TopEdge-Key header', { clientId: req.params.clientId });
      return;
    }

    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) {
      log.warn('Client not found', { clientId: req.params.clientId });
      return;
    }

    if (!client.shopifyFlowWebhookKey || client.shopifyFlowWebhookKey !== secret) {
      log.warn('Invalid webhook secret', { clientId: req.params.clientId });
      return;
    }

    const { trigger, phone, data = {} } = req.body;
    
    if (!phone) {
      log.warn('No phone in Shopify Flow trigger', { trigger });
      return;
    }

    const normalizedPhone = phone.replace(/\D/g, '');
    const lead = await AdLead.findOne({
      phoneNumber: normalizedPhone,
      clientId: client._id
    }).lean();

    log.info('Shopify Flow trigger received', { trigger, phone: normalizedPhone, clientId: client.clientId });

    switch (trigger) {
      // ── Enroll lead in a sequence ───────────────────────
      case 'enroll_sequence': {
        if (!data.sequenceId) break;
        try {
          const { enrollLeadInSequence } = require('../utils/triggerEngine');
          if (lead) {
            await enrollLeadInSequence(lead._id, client._id, data.sequenceId);
            log.info('Lead enrolled in sequence', { sequenceId: data.sequenceId, phone: normalizedPhone });
          }
        } catch (e) {
          log.error('enroll_sequence failed', { error: e.message });
        }
        break;
      }

      // ── Send a plain text message ──────────────────────
      case 'send_message': {
        if (!data.message) break;
        try {
          // Simple variable injection
          let text = data.message;
          if (lead) {
            text = text
              .replace(/\{\{name\}\}/gi, lead.name || '')
              .replace(/\{\{phone\}\}/gi, phone)
              .replace(/\{\{email\}\}/gi, lead.email || '');
          }
          await sendWAText(client, normalizedPhone, text);
        } catch (e) {
          log.error('send_message failed', { error: e.message });
        }
        break;
      }

      // ── Add tags to lead ───────────────────────────────
      case 'add_tag': {
        const tags = Array.isArray(data.tags) ? data.tags : [data.tags].filter(Boolean);
        if (tags.length === 0) break;
        try {
          await AdLead.findOneAndUpdate(
            { phoneNumber: normalizedPhone, clientId: client._id },
            { $addToSet: { tags: { $each: tags } } },
            { upsert: true }
          );
          log.info('Tags added to lead', { tags, phone: normalizedPhone });
        } catch (e) {
          log.error('add_tag failed', { error: e.message });
        }
        break;
      }

      // ── Update lead score ──────────────────────────────
      case 'update_score': {
        const scoreChange = parseInt(data.scoreChange || 0);
        if (scoreChange === 0) break;
        try {
          await AdLead.findOneAndUpdate(
            { phoneNumber: normalizedPhone, clientId: client._id },
            { $inc: { leadScore: scoreChange } },
            { upsert: true }
          );
          log.info('Lead score updated', { scoreChange, phone: normalizedPhone });
        } catch (e) {
          log.error('update_score failed', { error: e.message });
        }
        break;
      }

      // ── Trigger a visual flow ──────────────────────────
      case 'trigger_flow': {
        if (!data.flowId) break;
        try {
          const flow = (client.visualFlows || []).find(f => f.id === data.flowId);
          if (!flow) {
            log.warn('Flow not found', { flowId: data.flowId });
            break;
          }
          const startNode = (flow.nodes || []).find(n => n.type === 'startNode' || n.type === 'start');
          if (startNode) {
            const convo = await Conversation.findOne({ phone: normalizedPhone, clientId: client.clientId });
            const { executeNode } = require('../utils/nodeActions');
            await executeNode(startNode, flow.nodes, flow.edges, client, convo, lead, normalizedPhone, global.io);
            log.info('Flow triggered via Shopify Flow', { flowId: data.flowId });
          }
        } catch (e) {
          log.error('trigger_flow failed', { error: e.message });
        }
        break;
      }

      // ── Send a WhatsApp template ───────────────────────
      case 'send_template': {
        if (!data.templateName) break;
        try {
          const axios = require('axios');
          const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId;
          const token         = client.whatsappToken  || client.whatsapp?.accessToken;
          const components = [];
          if (data.variables && data.variables.length > 0) {
            components.push({
              type: 'body',
              parameters: data.variables.map(v => ({ type: 'text', text: String(v) }))
            });
          }
          await axios.post(
            `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
            {
              messaging_product: 'whatsapp',
              to: normalizedPhone,
              type: 'template',
              template: {
                name:     data.templateName,
                language: { code: data.languageCode || 'en' },
                components
              }
            },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
          );
          log.info('Template sent via Shopify Flow', { templateName: data.templateName });
        } catch (e) {
          log.error('send_template failed', { error: e.message });
        }
        break;
      }

      default:
        log.warn('Unknown Shopify Flow trigger', { trigger });
    }

    // Emit webhook event for audit log
    try {
      const { fireWebhookEvent } = require('../utils/webhookDelivery');
      await fireWebhookEvent(client._id, 'shopify_flow.triggered', { trigger, phone: normalizedPhone, data });
    } catch { /* non-critical */ }

  } catch (err) {
    log.error('Shopify Flow trigger handler error', { error: err.message });
  }
});

// ── POST /api/shopify-flow/:clientId/regenerate-key ───────
// Regenerates the webhook secret key
router.post('/:clientId/regenerate-key', async (req, res) => {
  try {
    const { v4: uuidv4 } = require('uuid');
    const client = await Client.findOneAndUpdate(
      { clientId: req.params.clientId },
      { shopifyFlowWebhookKey: uuidv4() },
      { new: true }
    );
    if (!client) return res.status(404).json({ success: false });
    res.json({ success: true, key: client.shopifyFlowWebhookKey });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
