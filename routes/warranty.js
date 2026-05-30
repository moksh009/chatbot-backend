const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requireFeature } = require('../utils/core/featureFlags');
const featureWarranty = requireFeature('warranty');
const AdLead = require('../models/AdLead');
const Contact = require('../models/Contact');
const Order = require('../models/Order');
const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const Client = require('../models/Client');
const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');
const { normalizePhone } = require('../utils/core/helpers');

function normalizeProductRules(body = {}) {
    const { productRules, shopifyProductIds, durationMonths } = body;
    if (Array.isArray(productRules) && productRules.length) {
        return productRules
            .map((r) => ({
                shopifyProductId: String(r.shopifyProductId || '').trim(),
                durationMonths: Math.max(1, Math.min(120, Number(r.durationMonths) || 12)),
            }))
            .filter((r) => r.shopifyProductId);
    }
    const ids = Array.isArray(shopifyProductIds) ? shopifyProductIds.map((id) => String(id).trim()).filter(Boolean) : [];
    const months = Math.max(1, Math.min(120, Number(durationMonths) || 12));
    return ids.map((shopifyProductId) => ({ shopifyProductId, durationMonths: months }));
}

async function requireShopifyConnected(clientId) {
    const client = await Client.findOne({ clientId })
        .select('shopifyAccessToken shopifyConnectionStatus')
        .lean();
    const connected =
        String(client?.shopifyConnectionStatus || '').toLowerCase() === 'connected' &&
        !!String(client?.shopifyAccessToken || '').trim();
    if (!connected) {
        const err = new Error('Connect Shopify in Channels before creating warranty batches.');
        err.statusCode = 400;
        throw err;
    }
    return client;
}

function durationMonthsForProduct(batch, productId) {
    const id = String(productId);
    const rule = (batch.productRules || []).find((r) => String(r.shopifyProductId) === id);
    if (rule?.durationMonths) return Number(rule.durationMonths);
    return Number(batch.durationMonths) || 12;
}

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

function buildPhoneVariants(phone = '') {
    const normalized = normalizePhone(phone || '');
    if (!normalized) return [];
    const variants = new Set([normalized]);
    if (normalized.startsWith('91') && normalized.length === 12) variants.add(normalized.slice(2));
    if (!normalized.startsWith('91') && normalized.length === 10) variants.add(`91${normalized}`);
    return [...variants];
}

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
        const { batchName, validFrom, validUntil } = req.body;
        const clientId = req.user.clientId;
        await requireShopifyConnected(clientId);

        const productRules = normalizeProductRules(req.body);
        if (!batchName || !productRules.length) {
            return res.status(400).json({
                success: false,
                message: 'Batch name and at least one product with warranty duration are required.',
            });
        }

        const maxMonths = Math.max(...productRules.map((r) => r.durationMonths));

        const newBatch = await WarrantyBatch.create({
            clientId,
            batchName: String(batchName).trim(),
            shopifyProductIds: productRules.map((r) => r.shopifyProductId),
            productRules,
            durationMonths: maxMonths,
            validFrom: validFrom ? new Date(validFrom) : new Date(),
            validUntil: validUntil ? new Date(validUntil) : null,
            status: 'active',
        });

        res.status(201).json({ success: true, batch: newBatch });
    } catch (err) {
        const code = err.statusCode || 500;
        res.status(code).json({ success: false, message: err.message });
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
        if (Array.isArray(req.body.productRules) && req.body.productRules.length) {
            const rules = normalizeProductRules(req.body);
            batch.productRules = rules;
            batch.shopifyProductIds = rules.map((r) => r.shopifyProductId);
            batch.durationMonths = Math.max(...rules.map((r) => r.durationMonths));
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
 * @route   DELETE /api/warranty/batches/:id
 * @desc    Delete a warranty batch and all linked warranty records
 */
router.delete('/batches/:id', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const { id } = req.params;

        const batch = await WarrantyBatch.findOne({ _id: id, clientId }).select('_id');
        if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });

        await Promise.all([
            WarrantyRecord.deleteMany({ clientId, batchId: batch._id }),
            WarrantyBatch.deleteOne({ _id: batch._id, clientId }),
        ]);

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
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
            .populate('batchId', 'batchName productRules durationMonths')
            .sort({ createdAt: -1 })
            .lean();

        const orderKeys = [
            ...new Set(
                records
                    .map((r) => String(r.shopifyOrderId || '').trim())
                    .filter(Boolean)
            ),
        ];
        const phones = [
            ...new Set(
                records
                    .map((r) => normalizePhone(r.customerId?.phoneNumber || ''))
                    .filter(Boolean)
            ),
        ];

        const [orders, leads] = await Promise.all([
            orderKeys.length
                ? Order.find({
                      clientId,
                      $or: [
                          { shopifyOrderId: { $in: orderKeys } },
                          { orderId: { $in: orderKeys } },
                          { name: { $in: orderKeys } },
                      ],
                  })
                      .select(
                          'shopifyOrderId orderId name createdAt financialStatus fulfillmentStatus totalPrice currency lineItems customerName customerPhone customerEmail'
                      )
                      .lean()
                : [],
            phones.length
                ? AdLead.find({ clientId, phoneNumber: { $in: phones } })
                      .select('_id phoneNumber name')
                      .lean()
                : [],
        ]);

        const orderByKey = new Map();
        for (const o of orders) {
            for (const k of [o.shopifyOrderId, o.orderId, o.name].filter(Boolean)) {
                orderByKey.set(String(k).trim(), o);
            }
        }
        const leadByPhone = new Map(leads.map((l) => [l.phoneNumber, l]));

        const enriched = records.map((r) => {
            const phone = normalizePhone(r.customerId?.phoneNumber || '');
            const order = orderByKey.get(String(r.shopifyOrderId || '').trim()) || null;
            const lead = phone ? leadByPhone.get(phone) : null;
            const lineItems = (order?.lineItems || []).map((li) => ({
                title: li.title || li.name,
                quantity: li.quantity,
                price: li.price,
                sku: li.sku,
                productId: li.product_id || li.productId,
            }));
            return {
                ...r,
                customerName: r.customerId?.name || order?.customerName || 'Customer',
                customerPhone: r.customerId?.phoneNumber || order?.customerPhone || '',
                customerEmail: r.customerId?.email || order?.customerEmail || '',
                leadId: lead?._id || null,
                orderDetails: order
                    ? {
                          shopifyOrderId: order.shopifyOrderId || order.orderId || order.name,
                          orderName: order.name || order.shopifyOrderId,
                          placedAt: order.createdAt,
                          financialStatus: order.financialStatus,
                          fulfillmentStatus: order.fulfillmentStatus,
                          totalPrice: order.totalPrice,
                          currency: order.currency,
                          lineItemCount: lineItems.length,
                          lineItems,
                      }
                    : { shopifyOrderId: r.shopifyOrderId, lineItems: [] },
            };
        });

        res.json({ success: true, records: enriched });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   GET /api/warranty/stats
 * @desc    Snapshot all-time warranty stats for dashboard metrics
 */
router.get('/stats', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const [statusCounts, customerIds] = await Promise.all([
            WarrantyRecord.aggregate([
                { $match: { clientId } },
                { $group: { _id: '$status', count: { $sum: 1 } } },
            ]),
            WarrantyRecord.distinct('customerId', { clientId }),
        ]);

        const byStatus = statusCounts.reduce((acc, row) => {
            acc[String(row._id || '').toLowerCase()] = Number(row.count || 0);
            return acc;
        }, {});

        return res.json({
            success: true,
            stats: {
                totalCustomerRecords: customerIds.length,
                activeCoverage: byStatus.active || 0,
                expiredWarranty: byStatus.expired || 0,
                terminatedWarranty: byStatus.terminated || 0,
                voidRefunded: byStatus.void || 0,
            },
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route GET /api/warranty/customer-profile?phone=
 * @desc Full warranty customer profile with order history and per-item warranty status
 */
router.get('/customer-profile', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const phone = normalizePhone(req.query.phone || '');
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Phone is required' });
        }

        const contact = await Contact.findOne({ clientId, phoneNumber: phone }).lean();
        const lead = await AdLead.findOne({ clientId, phoneNumber: phone })
            .select('_id name email phoneNumber')
            .lean();

        const warrantyRecords = contact
            ? await WarrantyRecord.find({ clientId, customerId: contact._id })
                  .sort({ purchaseDate: -1 })
                  .lean()
            : [];

        const phoneVariants = [phone];
        if (phone.startsWith('91') && phone.length === 12) {
            phoneVariants.push(phone.slice(2));
        }

        const orders = await Order.find({
            clientId,
            $or: [
                { customerPhone: { $in: phoneVariants } },
                { phone: { $in: phoneVariants } },
            ],
        })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        const warrantyByOrderProduct = new Map();
        for (const wr of warrantyRecords) {
            const orderKey = String(wr.shopifyOrderId || '').trim();
            const productKey = String(wr.productId || wr.productName || '').trim();
            warrantyByOrderProduct.set(`${orderKey}::${productKey}`, wr);
            warrantyByOrderProduct.set(`${orderKey}::${String(wr.productName || '').trim()}`, wr);
        }

        const now = new Date();
        let totalCovered = 0;
        let activeCount = 0;
        let expiredCount = 0;

        const enrichedOrders = orders.map((order) => {
            const orderKey = String(order.shopifyOrderId || order.orderId || order.name || '').trim();
            const rawItems = order.lineItems?.length ? order.lineItems : order.items || [];
            const lineItems = rawItems.map((li) => {
                const productId = String(li.product_id || li.productId || li.sku || '').trim();
                const title = li.title || li.name || 'Item';
                const wr =
                    warrantyByOrderProduct.get(`${orderKey}::${productId}`) ||
                    warrantyByOrderProduct.get(`${orderKey}::${title}`) ||
                    null;

                let warranty = { hasWarranty: false };
                if (wr) {
                    totalCovered += 1;
                    const exp = wr.expiryDate ? new Date(wr.expiryDate) : null;
                    const isActive = wr.status === 'active' && exp && exp > now;
                    if (isActive) activeCount += 1;
                    else if (exp && exp <= now) expiredCount += 1;
                    warranty = {
                        hasWarranty: true,
                        recordId: wr._id,
                        productName: wr.productName,
                        purchaseDate: wr.purchaseDate,
                        expiryDate: wr.expiryDate,
                        status: wr.status,
                    };
                }

                return {
                    title,
                    name: title,
                    quantity: li.quantity || 1,
                    price: li.price,
                    sku: li.sku,
                    productId,
                    warranty,
                };
            });

            return {
                orderId: order.shopifyOrderId || order.orderId,
                orderName: order.name || order.orderNumber || order.shopifyOrderId,
                placedAt: order.createdAt,
                financialStatus: order.financialStatus,
                fulfillmentStatus: order.fulfillmentStatus,
                totalPrice: order.totalPrice || order.amount,
                currency: order.currency || 'INR',
                lineItems,
            };
        });

        const profileLineItems = warrantyRecords.map((wr) => ({
            _id: wr._id,
            productName: wr.productName,
            shopifyOrderId: wr.shopifyOrderId,
            purchaseDate: wr.purchaseDate,
            expiryDate: wr.expiryDate,
            status: wr.status,
        }));

        res.json({
            success: true,
            profile: {
                customerName: contact?.name || lead?.name || orders[0]?.customerName || 'Customer',
                customerPhone: contact?.phoneNumber || phone,
                customerEmail: contact?.email || lead?.email || orders[0]?.customerEmail || '',
                customerId: contact?._id || null,
                leadId: lead?._id || null,
                orders: enrichedOrders,
                lineItems: profileLineItems,
                warrantySummary: {
                    totalCovered,
                    active: activeCount,
                    expired: expiredCount,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route GET /api/warranty/resolve-lead?phone=
 * @desc Resolve CRM lead id for warranty customer profile deep-link
 */
router.get('/resolve-lead', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const phone = normalizePhone(req.query.phone || '');
        if (!phone) return res.json({ success: true, leadId: null });
        const lead = await AdLead.findOne({ clientId, phoneNumber: phone }).select('_id').lean();
        res.json({ success: true, leadId: lead?._id || null });
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
 * @route   POST /api/warranty/records/upsert
 * @desc    Create/update warranty record for a specific customer order item
 */
router.post('/records/upsert', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const {
            recordId,
            phoneNumber,
            shopifyOrderId,
            productId,
            productName,
            purchaseDate,
            expiryDate,
            status = 'active',
        } = req.body || {};

        const normalizedPhone = normalizePhone(phoneNumber || '');
        if (!normalizedPhone || !shopifyOrderId || !productName) {
            return res.status(400).json({
                success: false,
                message: 'phoneNumber, shopifyOrderId, and productName are required',
            });
        }

        let contact = await Contact.findOne({ clientId, phoneNumber: normalizedPhone });
        if (!contact) {
            contact = await Contact.create({
                clientId,
                phoneNumber: normalizedPhone,
                name: 'Customer',
            });
        }

        let batch = await WarrantyBatch.findOne({ clientId, status: 'active' }).sort({ createdAt: -1 });
        if (!batch) {
            batch = await WarrantyBatch.create({
                clientId,
                batchName: 'Manual Registrations',
                shopifyProductIds: [],
                durationMonths: 12,
                validFrom: new Date(),
                status: 'active',
            });
        }

        const safePurchase = purchaseDate ? new Date(purchaseDate) : new Date();
        const safeExpiry = expiryDate ? new Date(expiryDate) : new Date(safePurchase);
        if (!expiryDate) safeExpiry.setMonth(safeExpiry.getMonth() + 12);

        const filter = recordId
            ? { _id: recordId, clientId }
            : {
                  clientId,
                  customerId: contact._id,
                  shopifyOrderId: String(shopifyOrderId),
                  productId: String(productId || productName),
              };

        const record = await WarrantyRecord.findOneAndUpdate(
            filter,
            {
                $set: {
                    clientId,
                    customerId: contact._id,
                    shopifyOrderId: String(shopifyOrderId),
                    productId: String(productId || productName),
                    productName: String(productName),
                    purchaseDate: safePurchase,
                    expiryDate: safeExpiry,
                    status,
                    batchId: batch._id,
                },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        return res.json({ success: true, record });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * @route   DELETE /api/warranty/records/customer/:phone
 * @desc    Delete all warranty records for a customer profile (phone/contact)
 */
router.delete('/records/customer/:phone', protect, featureWarranty, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const rawPhone = decodeURIComponent(req.params.phone || '');
        const phoneVariants = buildPhoneVariants(rawPhone);
        if (!phoneVariants.length) {
            return res.status(400).json({ success: false, message: 'Valid phone is required' });
        }

        const contacts = await Contact.find({
            clientId,
            phoneNumber: { $in: phoneVariants },
        })
            .select('_id')
            .lean();
        const customerIds = contacts.map((c) => c._id);
        if (!customerIds.length) {
            return res.json({ success: true, deletedCount: 0 });
        }

        const result = await WarrantyRecord.deleteMany({
            clientId,
            customerId: { $in: customerIds },
        });

        return res.json({
            success: true,
            deletedCount: Number(result.deletedCount || 0),
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * Legacy Support / Redirects
 * We keep some old endpoint names but point them to the new logic if appropriate
 */
router.get('/unassigned-orders', protect, featureWarranty, async (req, res) => {
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
            orderId,
            duration,
            durationMonths,
            purchaseDate
        } = req.body || {};

        if (!phoneNumber || !productName) {
            return res.status(400).json({ success: false, message: 'Customer Phone and Product Name are required' });
        }

        const normalizedPhone = normalizePhone(phoneNumber);
        const months = Math.max(1, Math.min(120, Number(durationMonths) || parseDurationMonths(duration)));
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
            productId: String(req.body.shopifyProductId || productName),
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

        const { sendWhatsAppTemplate } = require('../utils/meta/whatsappHelpers');
        
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
