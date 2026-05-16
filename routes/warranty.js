const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireFeature } = require('../utils/featureFlags');
const featureWarranty = requireFeature('warranty');
const AdLead = require('../models/AdLead');
const Contact = require('../models/Contact');
const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const Client = require('../models/Client');
const { withShopifyRetry } = require('../utils/shopifyHelper');

const { normalizePhone } = require('../utils/helpers');
const parseDurationMonths = (raw) => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const text = String(raw || '').toLowerCase();
    if (text.includes('3 year')) return 36;
    if (text.includes('2 year')) return 24;
    if (text.includes('1 year')) return 12;
    if (text.includes('6 month')) return 6;
    const match = text.match(/(\d+)/);
    return match ? Number(match[1]) : 12;
};

/**
 * @route   GET /api/warranty/batches
 * @desc    Fetch all warranty batches for a client
 */
router.get('/batches', protect, featureWarranty, async (req, res) => {
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
router.post('/batches', protect, featureWarranty, async (req, res) => {
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
router.patch('/batches/:id', protect, featureWarranty, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            status,
            durationMonths,
            applyRetroactively,
            voidExisting,
            batchName,
            shopifyProductIds,
            validFrom,
            validUntil
        } = req.body;
        const clientId = req.user.clientId;

        const batch = await WarrantyBatch.findOne({ _id: id, clientId });
        if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

        // Update fields
        if (status) batch.status = status;
        if (durationMonths) batch.durationMonths = Number(durationMonths);
        if (batchName) batch.batchName = String(batchName).trim();
        if (Array.isArray(shopifyProductIds)) {
            batch.shopifyProductIds = shopifyProductIds.map((v) => String(v));
        }
        if (validFrom) batch.validFrom = new Date(validFrom);
        if (typeof validUntil !== 'undefined') {
            batch.validUntil = validUntil ? new Date(validUntil) : null;
        }
        
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
router.get('/records', protect, featureWarranty, async (req, res) => {
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
router.patch('/records/:id', protect, featureWarranty, async (req, res) => {
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
router.get('/unassigned-orders', protect, featureWarranty, async (req, res) => {
    // For now, return mock empty or actual pending orders from Order model
    const Order = require('../models/Order');
    try {
        const clientId = req.user.clientId;
        const records = await WarrantyRecord.find({ clientId }).select('shopifyOrderId').lean();
        const assignedOrderIds = new Set(
            records
                .map((r) => String(r.shopifyOrderId || '').trim())
                .filter(Boolean)
        );

        const orders = await Order.find({ clientId }).sort({ createdAt: -1 }).limit(60).lean();
        const leads = orders
            .filter((o) => {
                const oid = String(o.shopifyOrderId || o.orderId || '').trim();
                return oid && !assignedOrderIds.has(oid);
            })
            .slice(0, 20)
            .map((o) => ({
                _id: o._id,
                name: o.customerName || o.name || 'Customer',
                phoneNumber: o.customerPhone || o.phone || '',
                lastInteraction: o.createdAt || new Date(),
                lastOrderId: o.shopifyOrderId || o.orderId || '',
                activityLog: [{ action: 'order_placed', at: o.createdAt || new Date() }]
            }));

        res.json({ success: true, leads }); // Keeping "leads" key for frontend compatibility during transition
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   POST /api/warranty/manual-register
 * @desc    Create warranty record manually from dashboard form
 */
router.post('/manual-register', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const {
            phoneNumber,
            productName,
            serialNumber,
            orderId,
            duration,
            purchaseDate
        } = req.body || {};

        if (!phoneNumber || !productName) {
            return res.status(400).json({ success: false, message: 'Customer Phone and Product Name are required' });
        }

        const normalizedPhone = normalizePhone(phoneNumber);
        const months = parseDurationMonths(duration);
        const purchase = purchaseDate ? new Date(purchaseDate) : new Date();
        const expiry = new Date(purchase);
        expiry.setMonth(expiry.getMonth() + months);

        let contact = await Contact.findOne({ clientId, phoneNumber: normalizedPhone });
        if (!contact) {
            contact = await Contact.create({
                clientId,
                phoneNumber: normalizedPhone,
                name: 'Manual Customer'
            });
        }

        let batch = await WarrantyBatch.findOne({ clientId, status: 'active' }).sort({ createdAt: -1 });
        if (!batch) {
            batch = await WarrantyBatch.create({
                clientId,
                batchName: 'Manual Registrations',
                shopifyProductIds: [],
                durationMonths: months,
                validFrom: new Date(),
                status: 'active'
            });
        }

        const record = await WarrantyRecord.create({
            clientId,
            customerId: contact._id,
            shopifyOrderId: String(orderId || `manual-${Date.now()}`),
            productId: String(serialNumber || productName),
            productName: String(productName),
            purchaseDate: purchase,
            expiryDate: expiry,
            batchId: batch._id,
            status: 'active'
        });

        return res.status(201).json({ success: true, record });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
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
        
        const scopedClientId = String(req.query.clientId || '').trim();
        if (!scopedClientId) {
            return res.status(400).json({ success: false, message: 'clientId is required' });
        }
        const cleanPhone = normalizePhone(phone);
        const scopedContact = await Contact.findOne({ clientId: scopedClientId, phoneNumber: cleanPhone }).lean();
        if (!scopedContact) return res.json({ success: true, hasWarranty: false });

        const record = await WarrantyRecord.findOne({ clientId: scopedClientId, customerId: scopedContact._id, status: 'active' })
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
router.post('/resend-notification', protect, featureWarranty, async (req, res) => {
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
