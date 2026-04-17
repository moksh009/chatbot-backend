const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :clientId
const loadClientConfig = require('../middleware/clientConfig');
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const InboundDeduplication = require('../models/InboundDeduplication');

// Import client controllers
const turfController = require('./clientcodes/turf');
const salonController = require('./clientcodes/salon');
const choiceSalonController = require('./clientcodes/choice_salon_holi');
const topedgeController = require('./clientcodes/topedgeai');
const genericAppointmentEngine = require('./engines/genericAppointment');
const genericEcommerceEngine = require('./engines/genericEcommerce');

// Middleware to load client config
router.use(loadClientConfig);

// Integration Setup Endpoint (PUT)
router.put('/integrations', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Auth validation - ensuring the logged-in user belongs to this client or is SuperAdmin
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
       return res.status(403).json({ error: 'Unauthorized to update integrations for this client.' });
    }

    const updates = {};
    const allowedFields = [
      'shopDomain', 'shopifyAccessToken', 'shopifyWebhookSecret',
      'emailUser', 'emailAppPassword', 'wabaId'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    await Client.findOneAndUpdate({ clientId }, { $set: updates }, { new: true });
    
    res.status(200).json({ success: true, message: 'Integrations updated successfully.', updates });
  } catch (err) {
    console.error(`[Integrations] Error updating integrations for ${req.params.clientId}:`, err);
    res.status(500).json({ error: 'Server error updating integrations.' });
  }
});

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
    
    // --- 1. Top-Level Deduplication ---
    // Dropping duplicates here prevents buffer-reset loops and eliminates the 20-30s delay.
    try {
      const entry = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];
      const messageId = message?.id;

      if (messageId) {
        const phone = message?.from; // Extract sender phone for deduplication
        const existing = await InboundDeduplication.findOne({ messageId, clientId });
        if (existing) {
          console.log(`[Webhook Router] Ignoring duplicate event for ${messageId}`);
          return res.sendStatus(200);
        }
        // Save ID with 2-minute TTL and mandatory phone field
        if (phone) {
            await InboundDeduplication.create({ messageId, clientId, phone });
        } else {
            // If phone is missing (unlikely for messages), we log it but don't crash
            log.warn(`[Webhook Router] Deduplication: missing phone for messageId ${messageId}`);
            await InboundDeduplication.create({ messageId, clientId, phone: 'unknown' });
        }
      }
    } catch (dedupErr) {
      console.error(`[Webhook Router] Deduplication check failed:`, dedupErr.message);
      // Continue anyway to ensure delivery
    }

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
      if (req.clientConfig.isGenericBot) {
        await genericAppointmentEngine.handleWebhook(req, res);
      } else {
        await choiceSalonController.handleWebhook(req, res);
      }
    } else if (businessType === 'choice_salon_new') {
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

// Configuration Sync Endpoints (GET/PATCH)
// Used for Order Trigger Mappings & Niche Data
router.get('/config', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' || 
                        req.user.clientId === clientId || 
                        (req.user.linkedClients && req.user.linkedClients.includes(clientId));

    if (!isAuthorized) {
       return res.status(403).json({ error: 'Unauthorized configuration access.' });
    }
    const client = await Client.findOne({ clientId }).select('-shopifyAccessToken -emailAppPassword');
    if (!client) return res.status(404).json({ error: 'Client configuration not found.' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error fetching config.' });
  }
});

// Get Client Configuration (Used for Dashboard initialization)
router.get('/config', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

router.patch('/config', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const isAuthorized = req.user.role === 'SUPER_ADMIN' || 
                        req.user.clientId === clientId || 
                        (req.user.linkedClients && req.user.linkedClients.includes(clientId));

    if (!isAuthorized) {
       return res.status(403).json({ error: 'Unauthorized configuration update.' });
    }
    
    // Whitelist allowable fields for dynamic patching
    const { nicheData, instagramConnected, isGenericBot } = req.body;
    const updates = {};
    
    // Surgical update for nicheData to prevent overwriting other keys
    if (nicheData && typeof nicheData === 'object') {
      Object.keys(nicheData).forEach(key => {
        updates[`nicheData.${key}`] = nicheData[key];
      });
    }

    if (instagramConnected !== undefined) updates.instagramConnected = instagramConnected;
    if (isGenericBot !== undefined) updates.isGenericBot = isGenericBot;

    const updated = await Client.findOneAndUpdate({ clientId }, { $set: updates }, { new: true });
    res.json({ success: true, client: updated });
  } catch (err) {
    console.error(`[Config Patch] Error for ${clientId}:`, err);
    res.status(500).json({ error: 'Failed to update configuration.' });
  }
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Instagram Webhooks (Dynamic)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require("crypto");
const { runDualBrainEngine } = require("../utils/dualBrainEngine");

// Verification handshake for Instagram Messenger API
router.get("/webhook/instagram", async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  try {
    const client = req.clientConfig;
    // Reuse the same verify token as WhatsApp for simplicity (or let it be defined in Client)
    const clientVerifyToken = client.verifyToken || "topedge_ai_handshake";

    if (mode === "subscribe" && token === clientVerifyToken) {
      console.log(`[Instagram Webhook] Verified for client: ${client.clientId}`);
      return res.status(200).send(challenge);
    }
    console.warn(`[Instagram Webhook] Verification FAILED for ${client.clientId}. Expected: ${clientVerifyToken}, Got: ${token}`);
    res.sendStatus(403);
  } catch (err) {
    console.error("[Instagram Webhook] GET Error:", err.message);
    res.sendStatus(500);
  }
});

// Handle incoming Instagram DM events
router.post("/webhook/instagram", async (req, res) => {
  try {
    const client = req.clientConfig;
    if (!client?.instagramConnected) return res.sendStatus(200);
    
    // Verify Signature if appSecret is present
    if (client.instagramAppSecret) {
      const signature = req.get("x-hub-signature-256");
      if (signature && req.rawBody) {
        const elements = signature.split("=");
        const signatureHash = elements[1];
        const expectedHash = crypto.createHmac("sha256", client.instagramAppSecret).update(req.rawBody).digest("hex");
        if (signatureHash !== expectedHash) {
          console.error(`[Instagram Webhook] Invalid signature for ${client.clientId}`);
          return res.sendStatus(403);
        }
      }
    }

    res.sendStatus(200); // Meta requirement
    
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (event.message && !event.message.is_echo) {
            const parsedMessage = {
                from:      event.sender.id,
                profileName: "",
                type:      "text",
                text:      { body: event.message.text || "" },
                messageId: event.message.mid,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        } else if (event.postback) {
            const parsedMessage = {
                from:      event.sender.id,
                type:      "interactive",
                interactive: {
                    type: "button_reply",
                    button_reply: { id: event.postback.payload, title: event.postback.title || "" }
                },
                messageId: event.postback.mid || `pb_${event.timestamp}`,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        }
      }
    }
  } catch (err) {
    console.error("[Instagram Webhook] POST Error:", err.message);
    if (!res.headersSent) res.sendStatus(500);
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

router.patch('/orders/:orderId/status', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.updateOrderStatus(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed' });
  }
});

router.patch('/orders/:orderId/address', async (req, res) => {
  try {
    const { businessType } = req.clientConfig;
    if (businessType === 'ecommerce') {
      await genericEcommerceEngine.updateOrderAddress(req, res);
    } else {
      res.status(400).json({ error: 'Orders not supported for this business type' });
    }
  } catch (error) {
    console.error('Error updating order address:', error);
    res.status(500).json({ error: 'Failed to update address' });
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

// POST /orders/:orderId/send-review-request — Manual review trigger (Block 13)
router.post('/orders/:orderId/send-review-request', protect, async (req, res) => {
  try {
    const { clientId, orderId } = req.params;
    const Order = require('../models/Order');
    const ReviewRequest = require('../models/ReviewRequest');

    const order = await Order.findOne({ _id: orderId, clientId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const phone = order.customerPhone || order.phone;
    if (!phone) return res.status(400).json({ success: false, message: 'No customer phone on order' });

    const client = req.clientConfig;

    await ReviewRequest.findOneAndUpdate(
      { clientId: client._id, phone, orderNumber: order.orderNumber || order.orderId },
      {
        clientId: client._id,
        phone,
        orderNumber: order.orderNumber || order.orderId,
        productName: order.items?.[0]?.name || 'your order',
        reviewUrl: client.googleReviewUrl || '',
        scheduledFor: new Date(), // Immediate dispatch
        status: 'scheduled'
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Review request scheduled for dispatch via WhatsApp' });
  } catch (error) {
    console.error('[ReviewRequest] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
