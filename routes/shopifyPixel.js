const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const PixelEvent = require('../models/PixelEvent');
const FollowUpSequence = require('../models/FollowUpSequence');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const moment = require('moment');

/**
 * Shopify Custom Pixel Endpoint
 * This receives events from Shopify's Web Pixel API:
 * - cart_viewed
 * - product_added_to_cart
 * - checkout_started
 * - checkout_completed
 */
router.post('/pixel/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { eventName, data, customer, timestamp } = req.body;

    try {
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Attribution Logic
        // 1. Identify customer (Email or Phone)
        const email = customer?.email || data?.checkout?.email;
        const phone = customer?.phone || data?.checkout?.phone;

        if (email || phone) {
            const query = {};
            if (email) query.email = email;
            if (phone) query.phoneNumber = phone.replace(/\D/g, ''); // Normalize

            let lead = await AdLead.findOne({ ...query, clientId });

            if (lead) {
                // Update Lead commerce state
                const eventEntry = {
                    event: eventName,
                    amount: data?.checkout?.totalPrice?.amount || data?.cart?.totalQuantity || 0,
                    currency: data?.checkout?.totalPrice?.currencyCode || 'INR',
                    timestamp: timestamp || new Date(),
                    metadata: data
                };

                lead.commerceEvents = lead.commerceEvents || [];
                lead.commerceEvents.push(eventEntry);
                
                // --- Phase 23: Track 1 & 8 - Pixel Logging & Abandonment Intelligence ---
                await PixelEvent.create({
                    clientId,
                    leadId: lead._id,
                    eventName: eventName === 'product_added_to_cart' ? 'add_to_cart' : eventName,
                    url: data?.url || '',
                    metadata: data,
                    timestamp: timestamp || new Date()
                });

                if (eventName === 'checkout_started' || eventName === 'product_added_to_cart') {
                    lead.addToCartCount = (lead.addToCartCount || 0) + 1;
                    lead.cartStatus = 'abandoned';
                    lead.isOrderPlaced = false; 
                    lead.lastCartEventAt = new Date();

                    // --- TRACK 1: Real-time Recovery Trigger (15m Delay) ---
                    if (eventName === 'checkout_started') {
                        const canAutomate = await checkLimit(client._id, 'sequences');
                        if (canAutomate.allowed) {
                            // Schedule a recovery sequence
                            const recoverySeq = new FollowUpSequence({
                                clientId,
                                leadId: lead._id,
                                phone: lead.phoneNumber,
                                name: `Recovery: ${lead.phoneNumber}`,
                                status: 'active',
                                steps: [{
                                    type: 'whatsapp',
                                    templateName: 'abandoned_cart_reminder',
                                    sendAt: moment().add(15, 'minutes').toDate(),
                                    status: 'pending'
                                }]
                            });
                            await recoverySeq.save();
                            console.log(`[DeepPixel] Scheduled 15m recovery for ${lead.phoneNumber}`);
                        }
                    }
                }

                // Track LTV 
                if (eventName === 'checkout_completed') {
                    lead.totalSpent = (lead.totalSpent || 0) + parseFloat(eventEntry.amount);
                    lead.orderCount = (lead.orderCount || 0) + 1;
                    lead.isOrderPlaced = true;
                    lead.cartStatus = 'purchased';
                }

                await lead.save();
                console.log(`[DeepPixel] Event ${eventName} tracked for Lead ${lead._id}`);
            }

        }

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[DeepPixel] Error:', err.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Public Pixel Event Endpoint (for script.js)
 * POST /api/shopify/pixel/:clientId/event
 */
router.post('/pixel/:clientId/event', async (req, res) => {
    const { clientId } = req.params;
    const { eventName, url, sessionId, metadata } = req.body;

    try {
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Log the raw event
        await PixelEvent.create({
            clientId,
            eventName,
            url,
            sessionId,
            metadata,
            userAgent: req.headers['user-agent'],
            ip: req.ip
        });

        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/**
 * GET /api/shopify/pixel/:clientId/script.js
 * Serves the Liquid Injection script
 */
router.get('/pixel/:clientId/script.js', async (req, res) => {
    const { clientId } = req.params;
    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    
    // Premium Liquid Injection Script (unrestricted DOM access)
    const script = `
(function() {
    const CLIENT_ID = "${clientId}";
    const BACKEND_URL = "${backendUrl}";
    const SESSION_ID = localStorage.getItem("te_pixel_sid") || "sess_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("te_pixel_sid", SESSION_ID);

    function sendEvent(name, data = {}) {
        fetch(BACKEND_URL + "/api/shopify/pixel/" + CLIENT_ID + "/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                eventName: name,
                url: window.location.href,
                sessionId: SESSION_ID,
                metadata: data
            })
        }).catch(err => console.debug("[TE-Pixel] Skipped", err));
    }

    sendEvent("page_view");

    if (window.Shopify && window.Shopify.checkout) {
        sendEvent("checkout_started", { checkout: window.Shopify.checkout });
    }

    // Wrap Fetch to catch AJAX Add to Cart
    const originalFetch = window.fetch;
    window.fetch = function() {
        return originalFetch.apply(this, arguments).then(response => {
            const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0].url;
            if (url && (url.includes("/cart/add.js") || url.includes("/cart/add"))) {
                sendEvent("product_added_to_cart", { url: url });
            }
            return response;
        });
    };
})();
    `.trim();

    res.set('Content-Type', 'application/javascript');
    return res.send(script);
});

module.exports = router;

