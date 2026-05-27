'use strict';

const express = require('express');
const crypto = require('crypto');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { buildAbandonedCartWorkspace } = require('../utils/commerce/abandonedCartWorkspace');
const {
  buildAbandonedCartReadiness,
  enableAbandonedCartRecovery,
  saveThirdPartyWebhookSecret,
  sendTestRecoveryMessage,
  generateWebhookSecret,
} = require('../utils/commerce/abandonedCartReadiness');
const { handleThirdPartyWebhook } = require('../utils/audience/thirdPartyCheckoutHandler');
const { logAction } = require('../middleware/audit');
const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

const router = express.Router();

/**
 * GET /api/abandoned-carts/workspace
 * Metrics + table rows for Audience → Abandoned carts (date range / preset).
 */
router.get('/workspace', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const data = await buildAbandonedCartWorkspace(clientId, req.query);
    res.json(data);
  } catch (err) {
    console.error('[AbandonedCarts] workspace error:', err);
    res.status(500).json({ success: false, message: 'Failed to load abandoned cart workspace' });
  }
});

/**
 * GET /api/abandoned-carts/readiness/:clientId
 * Go-live checklist for abandoned cart recovery.
 */
router.get('/readiness/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const readiness = await buildAbandonedCartReadiness(clientId);
    if (!readiness) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }
    res.json({ success: true, readiness });
  } catch (err) {
    console.error('[AbandonedCarts] readiness error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to load readiness' });
  }
});

/**
 * POST /api/abandoned-carts/enable/:clientId
 * Turn on wizardFeatures + activate cart rules when templates are approved.
 */
router.post('/enable/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await enableAbandonedCartRecovery(clientId);
    res.json(result);
  } catch (err) {
    console.error('[AbandonedCarts] enable error:', err);
    res.status(400).json({ success: false, message: err.message || 'Failed to enable recovery' });
  }
});

/**
 * POST /api/abandoned-carts/test-recovery/:clientId
 * Send cart_recovery_1 (or body.templateName) to merchant test phone.
 */
router.post('/test-recovery/:clientId', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { phone, templateName } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    const result = await sendTestRecoveryMessage(
      clientId,
      phone,
      templateName || 'cart_recovery_1'
    );
    res.json(result);
  } catch (err) {
    console.error('[AbandonedCarts] test-recovery error:', err);
    res.status(400).json({ success: false, message: err.message || 'Test send failed' });
  }
});

/**
 * PUT /api/abandoned-carts/third-party/:clientId/:provider
 * Save webhook secret for GoKwik / Razorpay / Shiprocket.
 */
router.put('/third-party/:clientId/:provider', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId, provider } = req.params;
    let { webhookSecret } = req.body || {};
    if (!webhookSecret) {
      webhookSecret = generateWebhookSecret();
    }
    const saved = await saveThirdPartyWebhookSecret(clientId, provider, webhookSecret);
    res.json({ success: true, ...saved, webhookSecret });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Failed to save secret' });
  }
});

/**
 * POST /api/abandoned-carts/third-party/:clientId/:provider/test
 * Fire a sample abandoned-cart webhook (updates lastWebhookAt on success).
 */
router.post(
  '/third-party/:clientId/:provider/test',
  protect,
  verifyClientAccess,
  async (req, res) => {
    try {
      const { clientId, provider } = req.params;
      const providerMap = {
        gokwik: 'gokwik',
        razorpay: 'razorpay_magic',
        'razorpay-magic': 'razorpay_magic',
        shiprocket: 'shiprocket',
        'shiprocket-checkout': 'shiprocket',
      };
      const key = providerMap[provider];
      if (!key) {
        return res.status(400).json({ success: false, message: 'Unknown provider' });
      }

      const Client = require('../models/Client');
      const client = await Client.findOne({ clientId }).select('audienceContext').lean();
      const secret =
        client?.audienceContext?.integrations?.[
          key === 'shiprocket' ? 'shiprocket_checkout' : key
        ]?.webhookSecret || '';

      let body;
      let headers = { 'content-type': 'application/json' };
      if (key === 'gokwik') {
        body = {
          cartId: `test_${Date.now()}`,
          custPhone: '9876543210',
          custName: 'Test Customer',
          custEmail: 'test@example.com',
          line_items: [
            {
              productName: 'Test Product',
              productQuantity: 1,
              productPrice: 999,
            },
          ],
          cartTotal: 999,
          abandonLink: 'https://example.com/cart/recover/test',
          recoverStatus: 'NOT_RECOVERED',
          checkoutStage: 'ORDER_SCREEN',
        };
        if (secret) headers['x-webhook-secret'] = secret;
      } else if (key === 'razorpay_magic') {
        body = {
          event: 'cart.abandoned',
          payload: {
            contact: '9876543210',
            email: 'test@example.com',
            customer_name: 'Test Customer',
            cart_value: 999,
            checkout_url: 'https://example.com/checkout/test',
            cart_items: [{ name: 'Test Product', quantity: 1, price: 999 }],
            timestamp: new Date().toISOString(),
          },
        };
        const raw = JSON.stringify(body);
        if (secret) {
          headers['x-razorpay-signature'] = crypto
            .createHmac('sha256', secret)
            .update(raw)
            .digest('hex');
        }
        req.rawBody = raw;
      } else {
        body = {
          customer_phone: '9876543210',
          customer_email: 'test@example.com',
          customer_name: 'Test Customer',
          cart_total: 999,
          checkout_link: 'https://example.com/checkout/test',
          cart_items: [{ name: 'Test Product', quantity: 1, price: 999 }],
        };
        if (secret) headers['x-webhook-secret'] = secret;
      }

      const mockReq = {
        body,
        headers,
        rawBody: req.rawBody || JSON.stringify(body),
      };

      const out = await handleThirdPartyWebhook(clientId, key, mockReq);
      await Client.updateOne(
        { clientId },
        {
          $set: {
            [`audienceContext.integrations.${key === 'shiprocket' ? 'shiprocket_checkout' : key}.lastTestAt`]:
              new Date(),
          },
        }
      );

      if (out.status >= 400) {
        return res.status(out.status).json(out.body || { success: false, message: 'Test failed' });
      }
      res.json({
        success: true,
        message: 'Test webhook received successfully',
        ...out.body,
      });
    } catch (err) {
      console.error('[AbandonedCarts] third-party test error:', err);
      res.status(500).json({ success: false, message: err.message || 'Test webhook failed' });
    }
  }
);

module.exports = router;
