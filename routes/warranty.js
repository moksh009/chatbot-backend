const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const AdLead = require('../models/AdLead');
const Contact = require('../models/Contact');
const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const Client = require('../models/Client');
const { withShopifyRetry } = require('../utils/shopifyHelper');

/**
 * @route   GET /api/warranty/batches
 * @desc    Fetch all warranty batches for a client
 */
router.get('/batches', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const batches = await WarrantyBatch.find({ clientId }).sort({ createdAt: -1 });
        res.json({ success: true, batches });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   POST /api/warranty/batches
 * @desc    Create a new warranty batch
 */
router.post('/batches', protect, async (req, res) => {
    try {
        const { batchName, shopifyProductIds, durationMonths, validFrom, validUntil } = req.body;
        const clientId = req.user.clientId;

        const newBatch = await WarrantyBatch.create({
            clientId,
            batchName,
            shopifyProductIds,
            durationMonths,
            validFrom: validFrom || new Date(),
            validUntil,
            status: 'active'
        });

        res.status(201).json({ success: true, batch: newBatch });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   PATCH /api/warranty/batches/:id
 * @desc    Update or Terminate a warranty batch
 */
router.patch('/batches/:id', protect, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, durationMonths, applyRetroactively, voidExisting } = req.body;
        const clientId = req.user.clientId;

        const batch = await WarrantyBatch.findOne({ _id: id, clientId });
        if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

        // Update fields
        if (status) batch.status = status;
        if (durationMonths) batch.durationMonths = durationMonths;
        
        await batch.save();

        // Task 3.3: Mass Edit/Terminate logic
        if (durationMonths && applyRetroactively) {
            // Optimization: Fetch only needed fields and perform bulk update
            const records = await WarrantyRecord.find({ batchId: id, status: 'active' }).select('purchaseDate').lean();
            
            if (records.length > 0) {
                const bulkOps = records.map(record => {
                    const newExpiry = new Date(record.purchaseDate);
                    newExpiry.setMonth(newExpiry.getMonth() + durationMonths);
                    return {
                        updateOne: {
                            filter: { _id: record._id },
                            update: { $set: { expiryDate: newExpiry } }
                        }
                    };
                });
                await WarrantyRecord.bulkWrite(bulkOps);
            }
        }

        if (status === 'terminated' && voidExisting) {
            // Bulk void for performance
            await WarrantyRecord.updateMany(
                { batchId: id, status: { $in: ['active', 'expired'] } },
                { $set: { status: 'void' } }
            );
        }

        res.json({ success: true, batch });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   GET /api/warranty/records
 * @desc    Fetch all live warranty records
 */
router.get('/records', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const records = await WarrantyRecord.find({ clientId })
            .populate('customerId', 'name phoneNumber email')
            .populate('batchId', 'batchName')
            .sort({ createdAt: -1 });
        
        res.json({ success: true, records });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   PATCH /api/warranty/records/:id
 * @desc    Update individual warranty record (Task 4.2)
 */
router.patch('/records/:id', protect, async (req, res) => {
    try {
        const { id } = req.params;
        const { expiryDate, status } = req.body;
        const clientId = req.user.clientId;

        const record = await WarrantyRecord.findOne({ _id: id, clientId });
        if (!record) return res.status(404).json({ success: false, message: 'Record not found' });

        if (expiryDate) record.expiryDate = new Date(expiryDate);
        if (status) record.status = status;

        await record.save();
        res.json({ success: true, record });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * Legacy Support / Redirects
 * We keep some old endpoint names but point them to the new logic if appropriate
 */
router.get('/unassigned-orders', protect, async (req, res) => {
    // For now, return mock empty or actual pending orders from Order model
    const Order = require('../models/Order');
    try {
        const clientId = req.user.clientId;
        const orders = await Order.find({ clientId }).limit(20);
        res.json({ success: true, leads: orders }); // Keeping "leads" key for frontend compatibility during transition
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   GET /api/warranty/check
 * @desc    Check warranty status by phone (For Flow Builder)
 */
router.get('/check', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });
        
        const contact = await Contact.findOne({ phoneNumber: phone });
        if (!contact) return res.json({ success: true, hasWarranty: false });

        const record = await WarrantyRecord.findOne({ customerId: contact._id, status: 'active' })
            .populate('batchId', 'batchName durationMonths')
            .sort({ expiryDate: -1 });

        if (!record) return res.json({ success: true, hasWarranty: false });
        
        res.json({ 
            success: true, 
            hasWarranty: true, 
            warranty: {
                id: record._id,
                status: record.status,
                expiryDate: record.expiryDate,
                batchName: record.batchId?.batchName
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   POST /api/warranty/resend-notification
 * @desc    Resend warranty certificate via WhatsApp
 */
router.post('/resend-notification', protect, async (req, res) => {
    try {
        const { recordId } = req.body;
        const clientId = req.user.clientId;

        const record = await WarrantyRecord.findOne({ _id: recordId, clientId }).populate('customerId');
        if (!record || !record.customerId) {
            return res.status(404).json({ success: false, message: 'Record or customer not found' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
        
        try {
            await sendWhatsAppTemplate({
                phoneNumberId: client.phoneNumberId,
                to: record.customerId.phoneNumber,
                templateName: 'warranty_certificate',
                languageCode: 'en',
                components: [
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: record.customerId.name || "Customer" },
                            { type: "text", text: new Date(record.expiryDate).toLocaleDateString() }
                        ]
                    }
                ],
                token: client.whatsappToken,
                clientId: client.clientId
            });
            res.json({ success: true, message: 'Notification sent' });
        } catch (err) {
            console.error('[Warranty] Failed to send WhatsApp notification:', err.message);
            res.status(500).json({ success: false, message: 'Failed to send WhatsApp notification: ' + err.message });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
