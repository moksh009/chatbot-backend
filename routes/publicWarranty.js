const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { assignWarranty } = require('../utils/warrantyService');
const log = require('../utils/logger')('PublicWarranty');

/**
 * @route   POST /api/public/warranty/register
 * @desc    Public endpoint for customers to register their product warranty
 * @access  Public
 */
router.post('/register', async (req, res) => {
    try {
        const { orderId, phone, invoiceImage, productName } = req.body;
        const { clientId } = req.query; // Passed in URL from QR/Link

        if (!orderId || !phone || !clientId) {
            return res.status(400).json({ success: false, message: 'Order ID, Phone, and Client ID are required.' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) {
            return res.status(404).json({ success: false, message: 'Invalid registration link.' });
        }

        // Logic check: Link registration to AdLead
        // We use assignWarranty which handles the logic of finding lead and calculating expiry
        // We mock the order data structure since assignWarranty expects a Shopify-like order object
        const mockOrder = {
            id: orderId.replace('#', ''),
            name: orderId,
            line_items: [{
                title: productName || 'Registered Product',
                variant_id: 'REG',
                quantity: 1,
                id: Date.now()
            }]
        };

        const records = await assignWarranty(client, phone, mockOrder);

        if (!records) {
            return res.status(500).json({ success: false, message: 'Failed to process registration.' });
        }

        res.json({ 
            success: true, 
            message: 'Warranty registered successfully!',
            records 
        });
    } catch (err) {
        log.error('Public registration error:', err.message);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

/**
 * @route   GET /api/public/warranty/config
 * @desc    Get whitelabel config for the public registration page
 */
router.get('/config', async (req, res) => {
    try {
        const { clientId } = req.query;
        const client = await Client.findOne({ clientId }).select('businessName brand logoUrl');
        if (!client) return res.status(404).json({ message: 'Client not found' });

        res.json({
            businessName: client.brand?.businessName || client.businessName,
            logo: client.brand?.businessLogo || client.logoUrl,
            themeColor: client.brand?.themeColor || '#6366f1'
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
