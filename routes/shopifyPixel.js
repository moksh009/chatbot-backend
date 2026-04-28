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
 * Helper: Process any Shopify or Script-based Pixel Event
 * Handles Lead Identification, commerceEvents tracking, and real-time ROI stats
 */
async function processPixelEvent(clientId, eventData) {
    const { eventName, data, customer, timestamp, sessionId, url, userAgent, ip } = eventData;
    
    const client = await Client.findOne({ clientId });
    if (!client) return { error: 'Client not found' };

    // 1. Identify Customer
    const email = customer?.email || data?.checkout?.email || data?.email;
    const rawPhone = customer?.phone || data?.checkout?.phone || data?.phone;
    const phone = rawPhone ? rawPhone.toString().replace(/\D/g, '') : null;

    if ((email || phone) || eventName === 'contact_identified') {
        const query = {};
        if (email) query.email = email;
        if (phone) query.phoneNumber = phone;
        
        if (eventName === 'contact_identified') {
            if (data.email) query.email = data.email;
            if (data.phone) query.phoneNumber = data.phone.toString().replace(/\D/g, '');
        }

        if (!Object.keys(query).length) return { success: true, status: 'no_id' };

        let lead = await AdLead.findOne({ ...query, clientId });

        if (!lead && (query.email || query.phoneNumber)) {
            lead = new AdLead({
                clientId,
                email: query.email || '',
                phoneNumber: query.phoneNumber || 'unknown_' + sessionId,
                source: 'DeepPixel (Identified)',
                lastInteraction: new Date()
            });
            await lead.save();
            console.log(`[DeepPixel] New Lead Created: ${query.email || query.phoneNumber}`);
        }

        if (lead) {
            // --- Phase 23: UTM Attribution Capture ---
            const currentUrl = url || data?.url || '';
            if (currentUrl && currentUrl.includes('?')) {
                try {
                    const params = new URLSearchParams(currentUrl.split('?')[1]);
                    const utmSource = params.get('utm_source');
                    const utmMedium = params.get('utm_medium');
                    const utmCampaign = params.get('utm_campaign');
                    
                    if (utmSource || utmMedium) {
                        lead.adAttribution = lead.adAttribution || {};
                        // Only update if it was organic/direct or missing
                        if (!lead.adAttribution.source || ['organic', 'direct', 'Organic/Direct'].includes(lead.adAttribution.source)) {
                            lead.adAttribution.source = utmSource || utmMedium;
                            lead.adAttribution.adSourceUrl = currentUrl;
                            if (utmCampaign) lead.adAttribution.adHeadline = utmCampaign;
                            console.log(`[DeepPixel] Attribution Updated: ${lead.adAttribution.source}`);
                        }
                    }
                } catch (e) {
                    console.error('[DeepPixel] UTM Parse Error:', e.message);
                }
            }

            // Update Lead commerce state
            const amount = data?.checkout?.totalPrice?.amount || data?.total_price || data?.cart?.totalQuantity || 0;
            const eventEntry = {
                event: eventName,
                amount: parseFloat(amount) || 0,
                currency: data?.checkout?.totalPrice?.currencyCode || data?.currency || 'INR',
                timestamp: timestamp || new Date(),
                metadata: { ...data, sessionId, url }
            };

            lead.commerceEvents = lead.commerceEvents || [];
            lead.commerceEvents.push(eventEntry);
            
            if (eventName === 'contact_identified') {
                if (data.email) lead.email = data.email;
                if (data.phone) lead.phoneNumber = data.phone.toString().replace(/\D/g, '');
                lead.activityLog.push({ action: 'pixel_contact_identified', details: `Source: pixel_capture`, timestamp: new Date() });
            }

            // Consistent event naming for analytics
            const mappedEvent = eventName === 'product_added_to_cart' ? 'add_to_cart' : eventName;

            try {
                await PixelEvent.create({
                    clientId,
                    leadId: lead._id,
                    eventName: mappedEvent,
                    url: url || data?.url || '',
                    metadata: { ...data, sessionId },
                    timestamp: timestamp || new Date(),
                    userAgent,
                    ip
                });
            } catch (err) {
                console.error('[DeepPixel] Failed to write PixelEvent:', err.message);
            }

            if (eventName === 'checkout_started' || eventName === 'product_added_to_cart') {
                lead.addToCartCount = (lead.addToCartCount || 0) + 1;
                lead.cartStatus = 'abandoned';
                lead.isOrderPlaced = false; 
                lead.lastCartEventAt = new Date();

                // Recovery Automation
                if (eventName === 'checkout_started' && lead.phoneNumber && !lead.phoneNumber.startsWith('unknown_')) {
                    const canAutomate = await checkLimit(client._id, 'sequences');
                    if (canAutomate.allowed) {
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
                    }
                }
            }

            if (eventName === 'checkout_completed') {
                lead.totalSpent = (lead.totalSpent || 0) + (parseFloat(amount) || 0);
                lead.ordersCount = (lead.ordersCount || 0) + 1;
                lead.isOrderPlaced = true;
                lead.cartStatus = 'purchased';
            }

            await lead.save();

            // Real-time Dashboard Sync
            if (global.io) {
                const room = `client_${clientId}`;
                if (eventName === 'product_added_to_cart' || eventName === 'checkout_started') {
                    global.io.to(room).emit('lead_cart_update', { leadId: lead._id, phone: lead.phoneNumber, cartStatus: 'abandoned', event: mappedEvent });
                }
                if (eventName === 'checkout_completed') {
                    global.io.to(room).emit('lead_purchased', { leadId: lead._id, phone: lead.phoneNumber, cartStatus: 'purchased' });
                }
            }
            return { success: true, leadId: lead._id };
        }
    } else {
        // Fallback: Just log raw event if no identification possible
        await PixelEvent.create({
            clientId,
            eventName,
            url,
            sessionId,
            metadata: data,
            timestamp: timestamp || new Date(),
            userAgent,
            ip
        });
    }
    return { success: true };
}

/**
 * Shopify Custom Pixel Endpoint (Official)
 */
router.post('/pixel/:clientId', async (req, res) => {
    try {
        const result = await processPixelEvent(req.params.clientId, {
            ...req.body,
            userAgent: req.headers['user-agent'],
            ip: req.ip
        });
        if (result.error) return res.status(404).json(result);
        res.status(200).json(result);
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
    try {
        const { eventName, url, sessionId, metadata } = req.body;
        const result = await processPixelEvent(req.params.clientId, {
            eventName,
            data: metadata, // metadata is the data payload for script events
            url,
            sessionId,
            userAgent: req.headers['user-agent'],
            ip: req.ip
        });
        if (result.error) return res.status(404).json(result);
        res.status(200).json(result);
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
    // PHASE 23: Enhanced with MutationObserver for GoKwik/Razorpay/Third-party capture
    const script = `
(function() {
    const CLIENT_ID = "${clientId}";
    const BACKEND_URL = "${backendUrl}";
    const SESSION_ID = localStorage.getItem("te_pixel_sid") || "sess_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("te_pixel_sid", SESSION_ID);

    let debounceTimer;

    function sendEvent(name, data = {}) {
        const payload = {
            eventName: name,
            url: window.location.href,
            sessionId: SESSION_ID,
            metadata: data,
            timestamp: new Date().toISOString()
        };
        
        const persistedEmail = localStorage.getItem("te_pixel_email");
        const persistedPhone = localStorage.getItem("te_pixel_phone");
        if (persistedEmail) payload.email = persistedEmail;
        if (persistedPhone) payload.phone = persistedPhone;

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
        }).catch(err => console.debug("[TE-Pixel] Service Unavailable", err));
    }

    // 1. Basic Tracking
    sendEvent("page_view");

    // 2. Official Shopify Checkout detection (Native)
    if (window.Shopify && window.Shopify.checkout) {
        const eventName = window.location.pathname.includes("thank_you") ? "checkout_completed" : "checkout_started";
        sendEvent(eventName, { 
            checkout: window.Shopify.checkout,
            total_price: window.Shopify.checkout.total_price || window.Shopify.checkout.totalPrice,
            currency: window.Shopify.checkout.currency
        });
    }

    // 3. Third-party Checkout Interceptor (GoKwik, Razorpay, Simpl, COD)
    function setupInterceptors() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('button, a, input[type="submit"]');
            if (!el) return;

            const text = (el.innerText || el.value || "").toLowerCase();
            const classes = el.className || "";
            const id = el.id || "";

            // GoKwik Detection
            if (classes.includes('gokwik') || id.includes('gokwik') || text.includes('gokwik')) {
                sendEvent("checkout_started", { gateway: "gokwik", element: "button_click" });
            }
            // Razorpay Detection
            if (classes.includes('razorpay') || text.includes('razorpay')) {
                sendEvent("checkout_started", { gateway: "razorpay", element: "button_click" });
            }
            // Generic Buy Now / Checkout
            if (text === 'buy it now' || text === 'checkout') {
                sendEvent("checkout_started", { gateway: "native_or_generic", element: "button_click" });
            }
        }, true);
    }

    // 4. Aggressive Lead Identification (Any form)
    function setupMutationObserver() {
        const observer = new MutationObserver((mutations) => {
            const inputs = document.querySelectorAll('input:not([data-te-tracked])');
            
            inputs.forEach(input => {
                const type = input.type;
                const name = (input.name || "").toLowerCase();
                const placeholder = (input.placeholder || "").toLowerCase();

                const isEmail = type === 'email' || name.includes('email') || placeholder.includes('email');
                const isPhone = type === 'tel' || name.includes('phone') || name.includes('mobile') || placeholder.includes('phone') || placeholder.includes('mobile') || name.includes('contact');

                if (isEmail || isPhone) {
                    input.addEventListener('input', (e) => {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            const val = e.target.value.trim();
                            if (isEmail && val.includes('@') && val.length > 5) {
                                localStorage.setItem("te_pixel_email", val);
                                sendEvent("contact_identified", { email: val, field: name || 'email' });
                            } else if (isPhone) {
                                const clean = val.replace(/\\D/g, '');
                                if (clean.length >= 10) {
                                    localStorage.setItem("te_pixel_phone", clean);
                                    sendEvent("contact_identified", { phone: clean, field: name || 'phone' });
                                }
                            }
                        }, 1000);
                    });
                    input.dataset.teTracked = "true";
                }
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 5. AJAX Cart Sync
    const originalFetch = window.fetch;
    window.fetch = function() {
        return originalFetch.apply(this, arguments).then(response => {
            const url = typeof arguments[0] === 'string' ? arguments[0] : arguments[0].url;
            if (url && (url.includes("/cart/add.js") || url.includes("/cart/add") || url.includes("/cart/update"))) {
                response.clone().json().then(data => {
                    sendEvent("product_added_to_cart", { product: data });
                }).catch(() => {});
            }
            return response;
        });
    };

    // Bootstrap
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setupInterceptors();
            setupMutationObserver();
        });
    } else {
        setupInterceptors();
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

