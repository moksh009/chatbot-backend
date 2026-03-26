const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :clientId
const loadClientConfig = require('../middleware/clientConfig');

// Import client controllers
const turfController = require('./clientcodes/turf');
const salonController = require('./clientcodes/salon');
const choiceSalonController = require('./clientcodes/choice_salon_holi');
const topedgeController = require('./clientcodes/topedgeai');
const genericAppointmentEngine = require('./engines/genericAppointment');
const genericEcommerceEngine = require('./engines/genericEcommerce');

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
      console.log(`[Webhook Verification] SUCCESS for Client: ${req.clientConfig.clientId}`);
      res.status(200).send(challenge);
    } else {
      console.warn(`[Webhook Verification] FAILED for Client: ${req.clientConfig.clientId} | Expected: ${VERIFY_TOKEN} | Received: ${token}`);
      res.sendStatus(403);
    }
  } else {
    console.warn(`[Webhook Verification] MISSING PARAMS for Client: ${req.clientConfig.clientId}`);
    res.sendStatus(400);
  }
});

// Webhook Event Handling (POST)
router.post('/webhook', async (req, res) => {
  try {
    const { businessType, clientId, isGenericBot } = req.clientConfig;
    console.log(`[Webhook Router] INCOMING POST -> Client: ${clientId} | Type: ${businessType} | Flow: ${isGenericBot ? 'GenericEngine' : 'CustomCode'}`);
    if (businessType === 'turf') {
      await turfController.handleWebhook(req, res);
    } else if (businessType === 'salon') {
      // Use the new generic engine for standard salon niches
      await genericAppointmentEngine.handleWebhook(req, res);
    } else if (businessType === 'clinic') {
      // Clinics always use the generic engine
      await genericAppointmentEngine.handleWebhook(req, res);
    } else if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleWebhook(req, res);
    } else if (businessType === 'choice_salon') {
      await choiceSalonController.handleWebhook(req, res);
    } else if (businessType === 'choice_salon_new') {
      // Falls back to the same choice_salon controller — see notes
      await choiceSalonController.handleWebhook(req, res);
    } else if (businessType === 'agency') {
      await topedgeController.handleWebhook(req, res);
    } else {
      console.warn(`[Webhook Router] UNHANDLED BUSINESS TYPE: ${businessType} for Client: ${clientId}`);
      res.sendStatus(200); // Acknowledge to avoid retries
    }
  } catch (error) {
    console.error(`[Webhook Router] FATAL ERROR for Client: ${req.clientConfig?.clientId || 'Unknown'}:`, error.message);
    res.sendStatus(500);
  }
});

router.post('/webhook/flow-endpoint', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'choice_salon') {
      await choiceSalonController.handleFlowWebhook(req, res);
    } else if (businessType === 'choice_salon_new') {
      await choiceSalonController.handleFlowWebhook(req, res);
    } else if (businessType === 'agency') {
      await topedgeController.handleFlowWebhook(req, res);
    } else {
      res.status(404).send('Flow endpoint not supported for this client');
    }
  } catch (error) {
    console.error('Error in flow webhook handler:', error);
    res.status(500).send('Internal Server Error');
  }
});
router.post('/webhook/shopify/link-opened', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyLinkOpenedWebhook(req, res);
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
      await genericEcommerceEngine.handleShopifyCartUpdatedWebhook(req, res);
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
      await genericEcommerceEngine.handleShopifyCheckoutInitiatedWebhook(req, res);
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
      await genericEcommerceEngine.handleShopifyOrderCompleteWebhook(req, res);
    }
  } catch (error) {
    console.error('Error in dynamic webhook handler:', error);
    res.sendStatus(500);
  }
});

router.post('/webhook/shopify/order-fulfilled', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.handleShopifyOrderFulfilledWebhook(req, res);
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
      await genericEcommerceEngine.logRestoreEvent(req, res);
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
      await genericEcommerceEngine.getClientOrders(req, res);
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
      await genericEcommerceEngine.getCartSnapshot(req, res);
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
      await genericEcommerceEngine.restoreCart(req, res);
    } else {
      res.status(400).send('Not supported for this business type');
    }
  } catch (error) {
    console.error('Error restoring cart:', error);
    res.status(500).send('Failed');
  }
});

module.exports = router;
