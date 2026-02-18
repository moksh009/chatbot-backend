const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :clientId
const loadClientConfig = require('../middleware/clientConfig');

// Import client controllers
const turfController = require('./clientcodes/turf');
const vedController = require('./clientcodes/ved');
const salonController = require('./clientcodes/salon');
const choiceSalonController = require('./clientcodes/choice_salon');

// Middleware to load client config
router.use(loadClientConfig);

// Webhook Verification (GET)
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Verify token should match what's in the client config or a global verify token
  // Prioritize client-specific token, fallback to global env
  const VERIFY_TOKEN = req.clientConfig.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'my_verify_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log(`WEBHOOK_VERIFIED for Client: ${req.clientConfig.clientId}`);
      res.status(200).send(challenge);
    } else {
      console.error(`Webhook Verification Failed for Client: ${req.clientConfig.clientId}. Expected: ${VERIFY_TOKEN}, Received: ${token}`);
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook Event Handling (POST)
router.post('/webhook', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    console.log(`Received webhook for Client: ${req.clientConfig.clientId} (${businessType})`);

    if (businessType === 'turf') {
      await turfController.handleWebhook(req, res);
    } else if (businessType === 'salon') {
      await salonController.handleWebhook(req, res);
    } else if (businessType === 'ecommerce') {
      await vedController.handleWebhook(req, res);
    } else if (businessType === 'choice_salon') {
      await choiceSalonController.handleWebhook(req, res);
    } else {
      console.log(`Unknown or unhandled business type: ${businessType}`);
      res.sendStatus(200); // Acknowledge to avoid retries
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/link-opened', async (req, res) => {
  try {
    const { businessType } = req.clienttype;

    if (businessType === 'ved') {
      await vedController.handleShopifyLinkOpenedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

module.exports = router;
