const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const PixelEvent = require('../models/PixelEvent');
const FollowUpSequence = require('../models/FollowUpSequence');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const moment = require('moment');

/**
 * WooCommerce Custom Pixel Endpoint
 * POST /api/woocommerce-pixel/pixel/:clientId/event
 */
router.post('/pixel/:clientId/event', async (req, res) => {
    const { clientId } = req.params;
    const { eventName, url, sessionId, metadata, timestamp } = req.body;

    try {
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Identification Logic
        const email = metadata?.email || metadata?.billing_email;
        const phone = (metadata?.phone || metadata?.billing_phone)?.replace(/\D/g, '');

        let lead = null;
        if (email || phone) {
            const query = { clientId };
            if (email) query.email = email.toLowerCase();
            if (phone) query.phoneNumber = phone;
            lead = await AdLead.findOne(query);

            if (!lead && (email || phone)) {
                lead = new AdLead({
                    clientId,
                    email: email || '',
                    phoneNumber: phone || 'unknown_' + sessionId,
                    source: 'WooCommerce Pixel',
                    lastInteraction: new Date()
                });
                await lead.save();
            }
        }

        // Log Pixel Event
        await PixelEvent.create({
            clientId,
            leadId: lead?._id,
            eventName,
            url,
            sessionId,
            metadata,
            timestamp: timestamp || new Date()
        });

        if (lead) {
            // Track Commerce Actions
            if (eventName === 'product_added_to_cart' || eventName === 'checkout_started') {
                lead.addToCartCount = (lead.addToCartCount || 0) + 1;
                lead.cartStatus = 'abandoned';
                lead.isOrderPlaced = false;
                lead.lastCartEventAt = new Date();

                // Recovery Trigger
                if (eventName === 'checkout_started' && lead.phoneNumber && !lead.phoneNumber.startsWith('unknown_')) {
                    const canAutomate = await checkLimit(client._id, 'sequences');
                    if (canAutomate.allowed) {
                        const exists = await FollowUpSequence.findOne({ 
                            leadId: lead._id, 
                            status: 'active',
                            name: { $regex: /Recovery/ }
                        });
                        if (!exists) {
                            const recoverySeq = new FollowUpSequence({
                                clientId,
                                leadId: lead._id,
                                phone: lead.phoneNumber,
                                name: `Woo Recovery: ${lead.phoneNumber}`,
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
            }

            if (eventName === 'checkout_completed') {
                lead.ordersCount = (lead.ordersCount || 0) + 1;
                lead.totalSpent = (lead.totalSpent || 0) + parseFloat(metadata?.total || 0);
                lead.isOrderPlaced = true;
                lead.cartStatus = 'purchased';
            }

            await lead.save();
        }

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('[WooPixel] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/woocommerce-pixel/pixel/:clientId/script.js
 * Serves the WooCommerce tracking script
 */
router.get('/pixel/:clientId/script.js', async (req, res) => {
    const { clientId } = req.params;
    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

    const script = `
(function() {
    const CLIENT_ID = "${clientId}";
    const BACKEND_URL = "${backendUrl}";
    const SESSION_ID = localStorage.getItem("te_woo_sid") || "sess_woo_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("te_woo_sid", SESSION_ID);

    function sendEvent(name, data = {}) {
        fetch(BACKEND_URL + "/api/woocommerce-pixel/pixel/" + CLIENT_ID + "/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                eventName: name,
                url: window.location.href,
                sessionId: SESSION_ID,
                metadata: data,
                timestamp: new Date().toISOString()
            })
        }).catch(err => console.debug("[TE-Woo-Pixel] Error", err));
    }

    sendEvent("page_view");

    // WooCommerce AJAX Add to Cart
    jQuery(document.body).on('added_to_cart', function(e, fragments, hash, button) {
        sendEvent("product_added_to_cart", { 
            product_id: button.data('product_id'),
            quantity: button.data('quantity')
        });
    });

    // Checkout Form Monitoring
    jQuery(document).on('blur', 'input#billing_email, input#billing_phone', function() {
        const email = jQuery('#billing_email').val();
        const phone = jQuery('#billing_phone').val();
        if (email || phone) {
            sendEvent("checkout_started", { 
                email: email, 
                phone: phone,
                billing_email: email,
                billing_phone: phone
            });
        }
    });

    // Checkout Completed (Order Received Page)
    if (window.location.href.includes('order-received')) {
        sendEvent("checkout_completed", { 
            url: window.location.href
        });
    }

})();
    `.trim();

    res.set('Content-Type', 'application/javascript');
    return res.send(script);
});

module.exports = router;
