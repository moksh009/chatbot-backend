'use strict';

const express = require('express');
const { handleThirdPartyWebhook } = require('../utils/audience/thirdPartyCheckoutHandler');

const router = express.Router();

async function dispatch(clientId, provider, req, res) {
  try {
    const out = await handleThirdPartyWebhook(clientId, provider, req);
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
router.post('/shiprocket-checkout/:clientId', (req, res) =>
  dispatch(req.params.clientId, 'shiprocket', req, res)
);
router.post('/third-party/:clientId', (req, res) => dispatch(req.params.clientId, 'generic', req, res));

module.exports = router;
