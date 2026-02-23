const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :clientId
const loadClientConfig = require('../middleware/clientConfig');

// Import client controllers
const turfController = require('./clientcodes/turf');
const vedController = require('./clientcodes/ved');
const salonController = require('./clientcodes/salon');
const choiceSalonController = require('./clientcodes/choice_salon_holi');

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
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.handleShopifyLinkOpenedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/cart-update', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.handleShopifyCartUpdatedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/checkout-initiated', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.handleShopifyCheckoutInitiatedWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/order-complete', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.handleShopifyOrderCompleteWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/log-restore-event', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.logRestoreEvent(req, res);
    } else {
      res.status(400).send('Not supported for this business type');
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.getClientOrders(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error fetching client orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/cart-snapshot', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.getCartSnapshot(req, res);
    } else {
      res.status(400).json({ error: 'Not supported for this business type' });
    }
  } catch (error) {
    console.error('Error fetching cart snapshot:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/restore-cart', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await vedController.restoreCart(req, res);
    } else {
      res.status(400).send('Not supported for this business type');
    }
  } catch (error) {
    console.error('Error restoring cart:', error);
    res.status(500).send('Failed');
  }
});

module.exports = router;
