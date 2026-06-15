'use strict';

const express = require('express');
const { handleThirdPartyWebhook } = require('../utils/audience/thirdPartyCheckoutHandler');
const { thirdPartyWebhookLimiter } = require('../middleware/thirdPartyWebhookLimiter');

const router = express.Router();
router.use(thirdPartyWebhookLimiter);

async function dispatch(clientId, provider, req, res) {
  try {
    const out = await handleThirdPartyWebhook(clientId, provider, req, { source: 'partner_inbound' });
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error(`[Webhook ${provider}]`, err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

router.post('/gokwik/:clientId', (req, res) => dispatch(req.params.clientId, 'gokwik', req, res));
router.post('/razorpay-magic/:clientId', (req, res) =>
  dispatch(req.params.clientId, 'razorpay_magic', req, res)
);
router.post('/razorpay/:clientId', (req, res) =>
  dispatch(req.params.clientId, 'razorpay_magic', req, res)
);
router.post('/shiprocket-checkout/:clientId', (req, res) =>
  dispatch(req.params.clientId, 'shiprocket', req, res)
);
router.post('/cashfree-checkout/:clientId', (req, res) =>
  dispatch(req.params.clientId, 'cashfree', req, res)
);
router.post('/third-party/:clientId', (req, res) => dispatch(req.params.clientId, 'generic', req, res));

module.exports = router;
