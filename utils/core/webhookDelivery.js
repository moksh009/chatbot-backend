"use strict";
const _ = require("lodash");

const axios              = require("axios");
const crypto             = require("crypto");
const WebhookConfig      = require("../../models/WebhookConfig");
const WebhookDeliveryLog = require("../../models/WebhookDeliveryLog");

// ─────────────────────────────────────────────────────────────────────────────
// All available webhook events
// ─────────────────────────────────────────────────────────────────────────────
const WEBHOOK_EVENTS = {
  // Lead
  "lead.created":         "A new contact messaged for the first time",
  "lead.updated":         "Lead data changed (score, tags, name, etc.)",
  "lead.score_changed":   "Lead score crossed a threshold",
  "lead.opted_out":       "Lead sent STOP or opted out",
  "lead.tag_added":       "A tag was added to a lead",
  "lead.converted":       "Lead placed their first order",
  // Order
  "order.created":        "New Shopify order from a WhatsApp lead",
  "order.cod_to_prepaid": "COD order converted to prepaid payment",
  // Conversation
  "conversation.started":   "New conversation opened",
  "conversation.escalated": "Bot escalated to human agent",
  "conversation.resolved":  "Conversation marked as resolved",
  "conversation.assigned":  "Conversation assigned to an agent",
  // Campaign
  "campaign.sent":    "A campaign was sent",
  "campaign.replied": "A recipient replied to a campaign",
  // Flow
  "flow.completed":          "A contact completed a flow end-to-end",
  "flow.capture_completed":  "A capture node collected data from a lead",
  // WA Form
  "wa_flow.submitted": "A WhatsApp Form was submitted by a contact",
  // QR
  "qr.scanned": "A QR code was scanned"
};

/**
 * Transforms an internal payload to match the client's custom Webhook mapping.
 * Supports flat mapping (order.id -> transactionId) and array mapping (items[].name -> products[].title).
 */
const transformEnterprisePayload = (sourceData, mappingConfig) => {
    if (!mappingConfig || Object.keys(mappingConfig).length === 0) return sourceData;
    
    const output = {};

    Object.entries(mappingConfig).forEach(([targetKey, sourcePath]) => {
        // Handle Array Mapping (e.g., target: "products[].title", source: "line_items[].name")
        if (sourcePath.includes('[]') && targetKey.includes('[]')) {
            const [sourceArrayPath, sourceItemPath] = sourcePath.split('[]');
            const [targetArrayPath, targetItemPath] = targetKey.split('[]');

            const sourceArray = _.get(sourceData, sourceArrayPath, []);
            
            // Ensure the target array exists
            let targetArray = _.get(output, targetArrayPath);
            if (!targetArray || !Array.isArray(targetArray)) {
                targetArray = Array.from({ length: sourceArray.length }, () => ({}));
                _.set(output, targetArrayPath, targetArray);
            }

            // Map each item in the array
            sourceArray.forEach((item, index) => {
                const extractedValue = _.get(item, sourceItemPath.replace(/^\./, '')); // Remove leading dot
                _.set(targetArray[index], targetItemPath.replace(/^\./, ''), extractedValue);
            });
        } 
        // Handle Standard Flat Mapping
        else {
            const extractedValue = _.get(sourceData, sourcePath);
            if (extractedValue !== undefined) {
                _.set(output, targetKey, extractedValue);
            }
        }
    });

    return output;
};

// ─────────────────────────────────────────────────────────────────────────────
// FILTER EVALUATION
// ─────────────────────────────────────────────────────────────────────────────
function getNestedValue(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

function evaluateCondition(value, operator, expected) {
  if (value === undefined || value === null) return false;
  switch (operator) {
    case "gt":       return Number(value) > Number(expected);
    case "lt":       return Number(value) < Number(expected);
    case "eq":       return String(value) === String(expected);
    case "neq":      return String(value) !== String(expected);
    case "contains": return String(value).toLowerCase().includes(String(expected).toLowerCase());
    case "starts":   return String(value).toLowerCase().startsWith(String(expected).toLowerCase());
    default:         return true;
  }
}

const MAX_ATTEMPTS = 6;
const RETRY_DELAYS_MS = [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000];

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY — Phase 8: up to 6 attempts (0, 30s, 2m, 10m, 30m, 2h)
// ─────────────────────────────────────────────────────────────────────────────
async function deliverWebhook(config, body, headers, attempt = 1, clientId = null) {

  try {
    const resp = await axios.post(config.url, body, {
      headers,
      timeout: 10000 // 10s timeout
    });

    await WebhookConfig.findByIdAndUpdate(config._id, {
      lastFiredAt: new Date(),
      lastStatus:  resp.status,
      lastError:   null,
      consecutiveFailures: 0,
      pausedReason: null,
      $inc: { totalFired: 1 }
    });

    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId:        clientId || config.clientId,
      event:           body.event,
      status:          resp.status,
      responseBody:    String(resp.data || "").substring(0, 500),
      deliveredAt:     new Date(),
      attempt,
      failed:          false
    });


  } catch (err) {
    const statusCode = err.response?.status || 0;

    await WebhookConfig.findByIdAndUpdate(config._id, {
      lastFiredAt: new Date(),
      lastStatus:  statusCode,
      lastError:   err.message
    });

    const isFinalAttempt = attempt >= MAX_ATTEMPTS;

    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId:        clientId || config.clientId,
      event:           body.event,
      status:          statusCode,
      error:           err.message,
      deliveredAt:     new Date(),
      attempt,
      failed:          true,
      isDead:          isFinalAttempt,
      rawPayload:      isFinalAttempt ? body : null // Only store payload if we're giving up
    });

    if (isFinalAttempt) {
      const updated = await WebhookConfig.findByIdAndUpdate(
        config._id,
        {
          $inc: { consecutiveFailures: 1 },
          $set: { lastError: err.message, lastStatus: statusCode },
        },
        { new: true }
      ).lean();
      if ((updated?.consecutiveFailures || 0) >= 6) {
        await WebhookConfig.findByIdAndUpdate(config._id, {
          isActive: false,
          pausedReason: 'auto_paused_after_failures',
          pausedAt: new Date(),
        });
        try {
          const { auditLog } = require('../../services/audit/auditWriter');
          auditLog({
            category: 'webhook',
            action: 'webhook_subscription_paused',
            severity: 'high',
            clientId: clientId || config.clientId,
            actor: { type: 'system', source: 'webhook_delivery' },
            details: { webhookId: String(config._id), url: config.url },
          });
        } catch (_) { /* noop */ }
      }
      return;
    }

    const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    setTimeout(() => deliverWebhook(config, body, headers, attempt + 1, clientId), delay);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY — fire-and-forget, ZERO latency impact on caller
// ─────────────────────────────────────────────────────────────────────────────
async function fireWebhookEvent(clientId, event, payload) {
  // Wrap in setImmediate so the calling request is NEVER blocked
  setImmediate(async () => {
    try {
      const configs = await WebhookConfig.find({
        clientId,
        events: event,
        isActive: true,
      }).lean();

      if (!configs.length) return;

      const { enqueueWebhookDelivery } = require('../messaging/queues/webhookDeliveryQueue');
      const deliveryBase = crypto.randomUUID();

      for (const config of configs) {
        const filtersPass = (config.filters || []).every((filter) => {
          const value = getNestedValue(payload, filter.field);
          return evaluateCondition(value, filter.operator, filter.value);
        });
        if (!filtersPass) continue;

        const deliveryId = `${deliveryBase}:${config._id}`;
        enqueueWebhookDelivery({
          configId: String(config._id),
          event,
          payload,
          clientId: clientId.toString(),
          deliveryId,
        }).catch((e) => {
          const log = require('./logger')('WebhookDelivery');
          log.warn(`Enqueue failed: ${e.message}`);
        });
      }
    } catch (err) {
      console.error("[WebhookDelivery] fireWebhookEvent error:", err.message);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SAMPLE PAYLOADS — for test endpoint
// ─────────────────────────────────────────────────────────────────────────────
function getSamplePayload(event) {
  const samples = {
    "lead.created":           { phone: "919876543210", name: "Rahul Sharma", source: "Meta Ad", leadScore: 10, createdAt: new Date() },
    "lead.score_changed":     { phone: "919876543210", oldScore: 10, newScore: 55, leadId: "sample_id" },
    "lead.converted":         { phone: "919876543210", name: "Rahul Sharma", orderId: "ORD-1001", orderTotal: 2999 },
    "lead.opted_out":         { phone: "919876543210", reason: "user_keyword", keyword: "STOP" },
    "order.created":          { phone: "919876543210", orderId: "ORD-1001", orderTotal: 2999, paymentMethod: "prepaid", items: [{ name: "Smart Doorbell", qty: 1, price: 2999 }] },
    "order.cod_to_prepaid":   { phone: "919876543210", orderId: "ORD-1001", convertedAt: new Date() },
    "conversation.started":   { phone: "919876543210", conversationId: "sample_id", startedAt: new Date() },
    "conversation.escalated": { phone: "919876543210", reason: "user_request", agentId: null },
    "conversation.resolved":  { phone: "919876543210", resolvedAt: new Date(), resolutionTimeMs: 300000 },
    "conversation.assigned":  { phone: "919876543210", agentId: "agent_001", agentName: "Priya", assignedAt: new Date() },
    "campaign.sent":          { campaignId: "sample_id", campaignName: "April Sale", recipientCount: 500 },
    "campaign.replied":       { phone: "919876543210", campaignId: "sample_id", repliedAt: new Date() },
    "flow.completed":         { phone: "919876543210", flowId: "flow_001", flowName: "Welcome Flow" },
    "flow.capture_completed": { phone: "919876543210", field: "email", value: "rahul@example.com" },
    "wa_flow.submitted":      { phone: "919876543210", flowName: "Order Form", formData: { size: "L", color: "Blue" } },
    "qr.scanned":             { phone: "919876543210", qrCode: "Trade Show 2026", shortCode: "QR_A1B2C3D4", isFirstScan: true }
  };
  return samples[event] || { sampleData: true, event };
}

module.exports = { fireWebhookEvent, WEBHOOK_EVENTS, getSamplePayload, deliverWebhook, transformEnterprisePayload };
