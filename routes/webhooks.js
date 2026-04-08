"use strict";

const express            = require("express");
const router             = express.Router();
const crypto             = require("crypto");
const axios              = require("axios");
const WebhookConfig      = require("../models/WebhookConfig");
const WebhookDeliveryLog = require("../models/WebhookDeliveryLog");
const { protect, verifyToken } = require("../middleware/auth");
const { logAction } = require("../middleware/audit");
const { WEBHOOK_EVENTS, getSamplePayload, deliverWebhook } = require("../utils/webhookDelivery");

// ─── POST /api/webhooks/resend/inbound — receive Resend email webhooks ────────
const { handleIncomingEmail } = require('../utils/emailIntegration');
router.post('/resend/inbound', handleIncomingEmail);

// ─── GET /api/webhooks/:clientId — list all webhook configs ─────────────────
router.get("/:clientId", verifyToken, async (req, res) => {
  try {
    const Client = require("../models/Client");
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const webhooks = await WebhookConfig.find({ clientId: client._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, webhooks, availableEvents: WEBHOOK_EVENTS });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/webhooks/:clientId — create new webhook ──────────────────────
router.post("/:clientId", verifyToken, async (req, res) => {
  try {
    const Client = require("../models/Client");
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    const { name, url, events, customHeaders, filters } = req.body;
    if (!name || !url || !events?.length) {
      return res.status(400).json({ success: false, message: "name, url, and events are required" });
    }

    // Auto-generate signing secret
    const secret = crypto.randomBytes(32).toString("hex");

    const webhook = await WebhookConfig.create({
      clientId:      client._id,
      name,
      url,
      events:        Array.isArray(events) ? events : [events],
      customHeaders: customHeaders || [],
      filters:       filters || [],
      secret,
      isActive:      true
    });

    res.status(201).json({ success: true, webhook: { ...webhook.toObject(), secret } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/webhooks/:clientId/:id — update webhook ───────────────────────
router.put("/:clientId/:id", verifyToken, async (req, res) => {
  try {
    const { name, url, events, customHeaders, filters } = req.body;
    const webhook = await WebhookConfig.findByIdAndUpdate(
      req.params.id,
      { $set: { name, url, events, customHeaders, filters } },
      { new: true }
    );
    res.json({ success: true, webhook });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/webhooks/:clientId/:id ─────────────────────────────────────
router.delete("/:clientId/:id", verifyToken, async (req, res) => {
  try {
    await WebhookConfig.findByIdAndDelete(req.params.id);
    await WebhookDeliveryLog.deleteMany({ webhookConfigId: req.params.id });
    res.json({ success: true, message: "Webhook deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/webhooks/:clientId/:id/toggle — enable/disable ──────────────
router.patch("/:clientId/:id/toggle", verifyToken, async (req, res) => {
  try {
    const webhook = await WebhookConfig.findById(req.params.id);
    if (!webhook) return res.status(404).json({ success: false, message: "Not found" });
    webhook.isActive = !webhook.isActive;
    await webhook.save();
    res.json({ success: true, isActive: webhook.isActive });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/webhooks/:clientId/:id/test — send live test payload ─────────
router.post("/:clientId/:id/test", verifyToken, async (req, res) => {
  try {
    const webhook = await WebhookConfig.findById(req.params.id).lean();
    if (!webhook) return res.status(404).json({ success: false, message: "Not found" });

    const event   = webhook.events[0] || "lead.created";
    const payload = getSamplePayload(event);
    const body = {
      event,
      timestamp: new Date().toISOString(),
      clientId:  webhook.clientId.toString(),
      data:      payload,
      webhookId: webhook._id,
      isTest:    true
    };

    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(JSON.stringify(body))
      .digest("hex");

    const headers = {
      "Content-Type":        "application/json",
      "X-TopEdge-Event":     event,
      "X-TopEdge-Signature": "sha256=" + signature,
      "X-TopEdge-Delivery":  crypto.randomUUID(),
      ...(webhook.customHeaders || []).reduce((acc, h) => {
        if (h.key) acc[h.key] = h.value;
        return acc;
      }, {})
    };

    const start = Date.now();
    let testResult;
    try {
      const resp = await axios.post(webhook.url, body, { headers, timeout: 10000 });
      testResult = { status: resp.status, responseBody: String(resp.data || "").substring(0, 500), durationMs: Date.now() - start };
    } catch (err) {
      testResult = { status: err.response?.status || 0, error: err.message, durationMs: Date.now() - start };
    }

    res.json({ success: true, ...testResult, payload: body });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/webhooks/:clientId/:id/logs — delivery logs ───────────────────
router.get("/:clientId/:id/logs", verifyToken, async (req, res) => {
  try {
    const logs = await WebhookDeliveryLog.find({ webhookConfigId: req.params.id })
      .sort({ deliveredAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/webhooks/:clientId/:id/redeliver/:logId — retry failed ───────
router.post("/:clientId/:id/redeliver/:logId", verifyToken, logAction('WEBHOOK_REPLAY'), async (req, res) => {
  try {
    // Find log (not lean because we need to update it)
    const log = await WebhookDeliveryLog.findById(req.params.logId);
    const webhook = await WebhookConfig.findById(req.params.id).lean();
    if (!log || !webhook) return res.status(404).json({ success: false, message: "Not found" });

    // Use stored rawPayload if available, fallback to sample for legacy logs
    const body = log.rawPayload || {
      event: log.event,
      timestamp: new Date().toISOString(),
      clientId: webhook.clientId.toString(),
      data: getSamplePayload(log.event),
      webhookId: webhook._id
    };

    body.isRedeliver = true; // Mark as replayed attempt
    body.originalDeliveryAt = log.deliveredAt;

    // HMAC signature
    const signature = crypto
      .createHmac("sha256", webhook.secret)
      .update(JSON.stringify(body))
      .digest("hex");

    const headers = {
      "Content-Type":        "application/json",
      "X-TopEdge-Event":     log.event,
      "X-TopEdge-Signature": "sha256=" + signature,
      "X-TopEdge-Delivery":  crypto.randomUUID()
    };

    // Mark current log as replayed to distinguish from fresh failures
    log.replayed = true;
    await log.save();

    // Fire async - this will create a BRAND NEW log entry for the retry
    deliverWebhook(webhook, body, headers, 1, log.clientId);

    res.json({ 
      success: true, 
      message: "Redelivery sequence initiated with original payload." 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


module.exports = router;
