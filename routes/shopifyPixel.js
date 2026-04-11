const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const PixelEvent = require('../models/PixelEvent');
const FollowUpSequence = require('../models/FollowUpSequence');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const moment = require('moment');
const { protect } = require('../middleware/auth');
const { injectPixelScript } = require('../utils/shopifyHelper');

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
    const { eventName, data, customer, timestamp, sessionId } = req.body;

    try {
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Attribution Logic
        // 1. Identify customer (Email or Phone)
        const email = customer?.email || data?.checkout?.email;
        const phone = customer?.phone || data?.checkout?.phone;

        if ((email || phone) || eventName === 'contact_identified') {
            const query = {};
            if (email) query.email = email;
            if (phone) query.phoneNumber = phone.replace(/\D/g, ''); // Normalize
            if (eventName === 'contact_identified') {
                if (data.email) query.email = data.email;
                if (data.phone) query.phoneNumber = data.phone.replace(/\D/g, '');
            }

            if (!Object.keys(query).length) return res.status(200).json({ success: true });

            let lead = await AdLead.findOne({ ...query, clientId });

            if (!lead && (query.email || query.phoneNumber)) {
                // Pre-create lead from pixel identification
                lead = new AdLead({
                    clientId,
                    email: query.email || '',
                    phoneNumber: query.phoneNumber || 'unknown_' + sessionId,
                    source: 'Shopify Pixel (Identified)',
                    lastInteraction: new Date()
                });
                await lead.save();
                console.log(`[DeepPixel] New Lead Created from Identification: ${query.email || query.phoneNumber}`);
            }

            if (lead) {
                // Update Lead commerce state
                const eventEntry = {
                    event: eventName,
                    amount: data?.checkout?.totalPrice?.amount || data?.cart?.totalQuantity || 0,
                    currency: data?.checkout?.totalPrice?.currencyCode || 'INR',
                    timestamp: timestamp || new Date(),
                    metadata: { ...data, sessionId }
                };

                lead.commerceEvents = lead.commerceEvents || [];
                lead.commerceEvents.push(eventEntry);
                
                // Track identified info if it was missing 
                if (eventName === 'contact_identified') {
                    if (data.email) lead.email = data.email;
                    if (data.phone) lead.phoneNumber = data.phone.replace(/\D/g, '');
                    lead.activityLog.push({ action: 'pixel_contact_identified', details: `Source: checkout_form`, timestamp: new Date() });
                }

                await PixelEvent.create({
                    clientId,
                    leadId: lead._id,
                    eventName: eventName === 'product_added_to_cart' ? 'add_to_cart' : eventName,
                    url: data?.url || '',
                    metadata: { ...data, sessionId },
                    timestamp: timestamp || new Date()
                });

                if (eventName === 'checkout_started' || eventName === 'product_added_to_cart') {
                    lead.addToCartCount = (lead.addToCartCount || 0) + 1;
                    lead.cartStatus = 'abandoned';
                    lead.isOrderPlaced = false; 
                    lead.lastCartEventAt = new Date();

                    // --- TRACK 1: Real-time Recovery Trigger (15m Delay) ---
                    if (eventName === 'checkout_started' && lead.phoneNumber && !lead.phoneNumber.startsWith('unknown_')) {
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
                    lead.ordersCount = (lead.ordersCount || 0) + 1;
                    lead.isOrderPlaced = true;
                    lead.cartStatus = 'purchased';
                }

                await lead.save();
                console.log(`[DeepPixel] Event ${eventName} tracked for Lead ${lead._id}`);

                // Emit real-time socket for dashboard live updates
                if (global.io) {
                    // Cart intent badge
                    if (eventName === 'product_added_to_cart' || eventName === 'checkout_started') {
                        global.io.to(`client_${clientId}`).emit('lead_cart_update', {
                            leadId: lead._id,
                            phone: lead.phoneNumber,
                            cartStatus: 'abandoned',
                            event: eventName,
                            timestamp: new Date()
                        });
                    }
                    // Purchase badge
                    if (eventName === 'checkout_completed') {
                        global.io.to(`client_${clientId}`).emit('lead_purchased', {
                            leadId: lead._id,
                            phone: lead.phoneNumber,
                            cartStatus: 'purchased',
                            timestamp: new Date()
                        });
                    }
                }

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
    // PHASE 23: Enhanced with MutationObserver for real-time contact capture
    const script = `
(function() {
    const CLIENT_ID = "${clientId}";
    const BACKEND_URL = "${backendUrl}";
    const SESSION_ID = localStorage.getItem("te_pixel_sid") || "sess_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("te_pixel_sid", SESSION_ID);

    function sendEvent(name, data = {}) {
        const payload = {
            eventName: name,
            url: window.location.href,
            sessionId: SESSION_ID,
            metadata: data,
            timestamp: new Date().toISOString()
        };
        
        // Capture context
        if (window.Shopify) {
            payload.shopify = {
                shop: Shopify.shop,
                currency: Shopify.currency?.active,
                theme: Shopify.theme?.name
            };
        }

        fetch(BACKEND_URL + "/api/shopify-pixel/pixel/" + CLIENT_ID + "/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).catch(err => console.debug("[TE-Pixel] Skipped", err));
    }

    // 1. Basic Page View
    sendEvent("page_view");

    // 2. Checkout Monitoring (Liquid Context)
    if (window.Shopify && window.Shopify.checkout) {
        sendEvent("checkout_started", { checkout: window.Shopify.checkout });
    }

    // 3. Real-time Lead Capture (Checkout Form)
    // Scans for email/phone fields and sends identifying events as they type
    function setupMutationObserver() {
        const observer = new MutationObserver((mutations) => {
            const emailInput = document.querySelector('input[name="checkout[email]"], input[type="email"]');
            const phoneInput = document.querySelector('input[name="checkout[phone]"], input[name*="phone"]');

            if (emailInput && !emailInput.dataset.teTracked) {
                emailInput.addEventListener('blur', (e) => {
                    if (e.target.value.includes('@')) {
                        sendEvent("contact_identified", { email: e.target.value });
                        emailInput.dataset.teTracked = "true";
                    }
                });
            }
            if (phoneInput && !phoneInput.dataset.teTracked) {
                phoneInput.addEventListener('blur', (e) => {
                    if (e.target.value.length >= 10) {
                        sendEvent("contact_identified", { phone: e.target.value });
                        phoneInput.dataset.teTracked = "true";
                    }
                });
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 4. AJAX Cart Interceptor
    const originalFetch = window.fetch;
    window.fetch = function() {
        return originalFetch.apply(this, arguments).then(response => {
            const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0].url;
            if (url && (url.includes("/cart/add.js") || url.includes("/cart/add"))) {
                response.clone().json().then(data => {
                    sendEvent("product_added_to_cart", { product: data });
                }).catch(() => sendEvent("product_added_to_cart", { url }));
            }
            return response;
        });
    };

    // Initialize 
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupMutationObserver);
    } else {
        setupMutationObserver();
    }
})();
    `.trim();

    res.set('Content-Type', 'application/javascript');
    return res.send(script);
});

/**
 * Trigger Automatic Injection
 * POST /api/shopify/pixel/:clientId/inject
 * Requires auth
 */
router.post('/pixel/:clientId/inject', protect, async (req, res) => {
    const { clientId } = req.params;
    if (req.user.clientId !== clientId && req.user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
        const result = await injectPixelScript(clientId, backendUrl);
        res.json(result);
    } catch (err) {
        console.error('[PixelInject] Error:', err.message);
        const isForbidden = err.response?.status === 403;
        
        let errorMsg = err.message;
        if (isForbidden) {
            errorMsg = 'Permission Denied: Ensure your Shopify App has "write_themes" and "read_themes" scopes enabled in Shopify Admin -> Settings -> Develop Apps -> Configuration.';
        } else if (err.response?.data?.errors) {
            errorMsg = `Shopify API Error: ${err.response.data.errors}`;
        }

        res.status(isForbidden ? 403 : 500).json({ 
            success: false,
            error: errorMsg,
            details: err.response?.data || null
        });
    }
});

/**
 * GET /api/shopify/pixel/:clientId/status
 * Returns real-time pixel performance metrics
 */
router.get('/pixel/:clientId/status', protect, async (req, res) => {
    const { clientId } = req.params;
    
    try {
        const fiveMinutesAgo = moment().subtract(5, 'minutes').toDate();
        const fifteenMinutesAgo = moment().subtract(15, 'minutes').toDate();

        // 1. Get Event Count in last 5 mins
        const count = await PixelEvent.countDocuments({
            clientId,
            timestamp: { $gte: fiveMinutesAgo }
        });

        // 2. Get Last Event
        const lastEvent = await PixelEvent.findOne({ clientId })
            .sort({ timestamp: -1 });

        const eventsPerMinute = (count / 5).toFixed(1);
        const isActive = (lastEvent && moment(lastEvent.timestamp).isAfter(fifteenMinutesAgo)) || false;

        res.json({
            success: true,
            isActive,
            eventsPerMinute: parseFloat(eventsPerMinute),
            lastEventAt: lastEvent ? lastEvent.timestamp : null,
            totalEvents: count
        });
    } catch (err) {
        console.error('[PixelStatus] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

