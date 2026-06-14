'use strict';

const express = require('express');
const axios = require('axios');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { normalizeInboundPayload } = require('../utils/commerce/logisticsWebhookNormalizer');
const { recordDirectWebhookSeen } = require('../services/logisticsEligibilityService');
const { processShipmentStatusAutomations, SHIPMENT_VALUES } = require('../utils/commerce/orderStatusAutomationHandler');
const shopifyAdminApiVersion = require('../utils/shopify/shopifyAdminApiVersion');
const { replayGuard } = require('../middleware/webhookReplayGuard');

const router = express.Router();
const inboundReplay = replayGuard({
  header: 'x-logistics-event-id',
  keyPrefix: 'logistics_inbound',
  ttlSec: 3600,
  fallbackKeyFn: (req) => {
    const raw = JSON.stringify(req.body || {}).slice(0, 200);
    return `${req.params.clientId}:${raw}`;
  },
});

router.post('/inbound/:clientId', inboundReplay, async (req, res) => {
  res.status(200).send('OK');

  const clientId = String(req.params.clientId || '').trim();
  const provider = String(req.query.provider || 'sr').trim();
  const body = req.body || {};

  try {
    const client = await Client.findOne({ clientId }).lean();
    if (!client) return;

    const secret = client.logisticsIntegration?.webhookSecret || '';
    const headerKey = String(req.headers['x-api-key'] || req.headers['x-logistics-secret'] || '').trim();
    const mode = client.logisticsMode || 'shopify_only';
    const requiresSecret = mode === 'direct' || mode === 'hybrid';
    if (requiresSecret) {
      if (!secret || headerKey !== secret) {
        console.warn(`[LogisticsInbound] auth failed client=${clientId} mode=${mode}`);
        return;
      }
    } else if (secret && headerKey !== secret) {
      console.warn(`[LogisticsInbound] auth failed client=${clientId}`);
      return;
    }

    const normalized = normalizeInboundPayload(provider, body);
    if (!normalized.shipmentStatus || !SHIPMENT_VALUES.has(normalized.shipmentStatus)) {
      await recordDirectWebhookSeen(clientId);
      return;
    }

    await recordDirectWebhookSeen(clientId);

    const orderUpdate = {
      lastShipmentStatus: normalized.shipmentStatus,
      lastShipmentStatusAt: new Date(),
    };
    if (normalized.trackingNumber) orderUpdate.trackingNumber = normalized.trackingNumber;
    if (normalized.trackingUrl) orderUpdate.trackingUrl = normalized.trackingUrl;
    const srOrderId = body.order_id || body.shipment?.order_id || body.order?.order_id;
    if (srOrderId) orderUpdate.shiprocketOrderId = String(srOrderId);

    let shopifyOrderId = normalized.orderId;
    if (!shopifyOrderId && normalized.trackingNumber) {
      const hit = await Order.findOne({
        clientId,
        trackingNumber: normalized.trackingNumber,
      })
        .select('shopifyOrderId')
        .lean();
      shopifyOrderId = hit?.shopifyOrderId || '';
    }
    if (!shopifyOrderId) {
      console.warn(`[LogisticsInbound] no order match client=${clientId} awb=${normalized.trackingNumber}`);
      return;
    }

    await Order.findOneAndUpdate(
      { clientId, shopifyOrderId: String(shopifyOrderId) },
      { $set: orderUpdate }
    ).catch(() => {});

    let fullOrder = null;
    if (client.shopDomain && client.shopifyAccessToken) {
      try {
        const orderRes = await axios.get(
          `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/orders/${shopifyOrderId}.json`,
          { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken }, timeout: 15000 }
        );
        fullOrder = orderRes.data?.order;
      } catch (fetchErr) {
        console.warn(`[LogisticsInbound] Shopify order fetch failed: ${fetchErr.message}`);
      }
    }

    if (!fullOrder) {
      const local = await Order.findOne({ clientId, shopifyOrderId: String(shopifyOrderId) }).lean();
      if (!local) return;
      fullOrder = {
        id: shopifyOrderId,
        name: local.orderNumber || local.orderId,
        phone: local.customerPhone || local.phone,
        customer: { phone: local.customerPhone, first_name: local.customerName },
        line_items: [],
      };
    }

    const fulfillment = {
      order_id: shopifyOrderId,
      shipment_status: normalized.shipmentStatus,
      tracking_number: normalized.trackingNumber,
      tracking_urls: normalized.trackingUrl ? [normalized.trackingUrl] : [],
      tracking_url: normalized.trackingUrl,
    };

    const {
      maybeSendNdrRescueFromFulfillment,
      shouldSkipSacForNdr,
      rtoCfg,
    } = require('../utils/commerce/rtoProtectionService');

    let ndrResult = null;
    if (rtoCfg(client).enableNdrRescue) {
      ndrResult = await maybeSendNdrRescueFromFulfillment(client, fulfillment, null).catch((e) => {
        console.warn(`[LogisticsInbound] NDR rescue failed: ${e.message}`);
        return { ok: false, error: e.message };
      });
    }

    if (!shouldSkipSacForNdr(client, normalized.shipmentStatus, ndrResult)) {
      await processShipmentStatusAutomations({
        client,
        fulfillment,
        orderPayload: fullOrder,
        source: `logistics_webhook:${provider}:${normalized.shipmentStatus}`,
      }).catch((e) => console.error(`[LogisticsInbound] automation failed: ${e.message}`));
    }
  } catch (err) {
    console.error('[LogisticsInbound] handler error:', err.message);
  }
});

module.exports = router;
