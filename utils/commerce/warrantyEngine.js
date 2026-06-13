const WarrantyBatch = require('../../models/WarrantyBatch');
const WarrantyRecord = require('../../models/WarrantyRecord');
const Contact = require('../../models/Contact');
const Order = require('../../models/Order');
const { normalizePhone } = require('../core/helpers');
const { sendNotifications } = require('./warrantyService');
const { isWarrantyEnabled } = require('../core/featureFlags');
const log = require('../core/logger')('WarrantyEngine');

function durationMonthsForProduct(batch, productId) {
    const id = String(productId);
    const rule = (batch.productRules || []).find((r) => String(r.shopifyProductId) === id);
    if (rule?.durationMonths) return Number(rule.durationMonths);
    return Number(batch.durationMonths) || 12;
}

function orderEligibleAfterWarrantyEnabled(client, orderDate) {
    const enabledAt = client?.wizardFeatures?.warrantyEnabledAt;
    if (!enabledAt) return true;
    const placed = new Date(orderDate);
    const since = new Date(enabledAt);
    if (Number.isNaN(placed.getTime()) || Number.isNaN(since.getTime())) return true;
    return placed >= since;
}

function orderDocToShopifyPayload(order = {}) {
    const orderName =
        order.shopifyOrderId ||
        order.orderNumber ||
        order.name ||
        order.orderId ||
        '';
    return {
        name: orderName,
        id: order.orderId || order.shopifyOrderId,
        created_at: order.createdAt || new Date(),
        phone: order.customerPhone || order.phone,
        email: order.customerEmail || order.email,
        customer: {
            phone: order.customerPhone || order.phone,
            email: order.customerEmail || order.email,
            first_name: String(order.customerName || order.name || 'Customer').split(' ')[0],
            last_name: String(order.customerName || order.name || '')
                .split(' ')
                .slice(1)
                .join(' '),
        },
        billing_address: { phone: order.customerPhone || order.phone },
        line_items: (order.items || []).map((item) => ({
            product_id: item.productId || item.product_id,
            title: item.name || item.title || 'Product',
            image_url: item.image || item.image_url || null,
            quantity: item.quantity || 1,
        })),
    };
}

function isPaidShopifyOrder(data = {}) {
    const fin = String(data.financial_status || '').toLowerCase();
    return fin === 'paid' || fin === 'partially_paid';
}

/**
 * Enterprise Warranty Auto-Assign Engine
 * Automatically processes fulfilled orders to generate warranty certificates based on active batches.
 */
async function processWarrantyAutoAssignment(client, data) {
    if (!isWarrantyEnabled(client)) {
        log.debug(
            `[Warranty] Skipping auto-assignment for ${client.clientId} — enableWarranty is off`
        );
        return;
    }

    try {
        const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
        if (!phoneRaw) {
            log.debug(`[Warranty] No phone found for order ${data.name || data.id}. Skipping.`);
            return;
        }

        const cleanPhone = normalizePhone(phoneRaw);
        const orderDate = new Date(data.created_at || Date.now());

        if (!orderEligibleAfterWarrantyEnabled(client, orderDate)) {
            log.debug(
                `[Warranty] Order ${data.name || data.id} is before warranty was enabled. Skipping.`
            );
            return;
        }

        const productIdsInOrder = data.line_items?.map(item => String(item.product_id)) || [];

        // 1. Find active batches matching products in this order
        const activeBatches = await WarrantyBatch.find({
            clientId: client.clientId,
            status: 'active',
            shopifyProductIds: { $in: productIdsInOrder },
            validFrom: { $lte: orderDate },
            $or: [
                { validUntil: { $exists: false } },
                { validUntil: null },
                { validUntil: { $gte: orderDate } }
            ]
        }).lean();

        if (activeBatches.length === 0) {
            log.debug(`[Warranty] No active batches found for products in order ${data.name}.`);
            return;
        }

        // 2. Ensure Contact exists or update it
        const contact = await Contact.findOneAndUpdate(
            { clientId: client.clientId, phoneNumber: cleanPhone },
            { 
                $set: { 
                    name: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}` : 'Shopify Guest',
                    email: data.email || data.customer?.email,
                    lastPurchaseDate: orderDate
                } 
            },
            { upsert: true, new: true }
        );

        // 3. Generate records for each matching line item
        for (const item of data.line_items) {
            const productId = String(item.product_id);
            const batch = activeBatches.find(b => b.shopifyProductIds.includes(productId));

            if (batch) {
                // Check if a record already exists for this order + product combo to prevent duplicates
                const existing = await WarrantyRecord.findOne({
                    clientId: client.clientId,
                    shopifyOrderId: data.name || `#${data.id}`,
                    productId: productId
                });

                if (existing) {
                    log.info(`[Warranty] Record already exists for order ${data.name} product ${productId}. Skipping.`);
                    continue;
                }

                const months = durationMonthsForProduct(batch, productId);
                const expiryDate = new Date(orderDate);
                expiryDate.setMonth(expiryDate.getMonth() + months);

                const record = await WarrantyRecord.create({
                    clientId: client.clientId,
                    customerId: contact._id,
                    shopifyOrderId: data.name || `#${data.id}`,
                    productId: productId,
                    productName: item.title,
                    purchaseDate: orderDate,
                    expiryDate: expiryDate,
                    batchId: batch._id,
                    status: 'active'
                });

                log.info(`[Warranty] Certificate generated for ${contact.name} (${item.title})`);

                // 4. Dispatch Notifications
                const stubRecord = {
                    productName: item.title,
                    productImage: item.image_url || null,
                    expiryDate: expiryDate
                };

                await sendNotifications(client, cleanPhone, stubRecord)
                    .catch(e => log.warn(`[Warranty] Notification dispatch failed: ${e.message}`));
            }
        }
    } catch (err) {
        log.error('[Warranty] Auto-assignment engine fault:', err.message);
        throw err;
    }
}

/**
 * Process recent synced orders that match active batches (run after warranty is turned on).
 */
async function backfillWarrantyFromRecentOrders(client, { limit = 120 } = {}) {
    if (!isWarrantyEnabled(client)) return { assigned: 0, scanned: 0 };

    const activeBatchCount = await WarrantyBatch.countDocuments({
        clientId: client.clientId,
        status: 'active',
        shopifyProductIds: { $exists: true, $ne: [] },
    });
    if (!activeBatchCount) {
        log.debug(`[Warranty] No active batches for ${client.clientId}; skip backfill`);
        return { assigned: 0, scanned: 0, reason: 'no_batches' };
    }

    const orders = await Order.find({ clientId: client.clientId })
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(limit, 200)))
        .lean();

    let assigned = 0;
    for (const order of orders) {
        try {
            const payload = orderDocToShopifyPayload(order);
            if (!payload.line_items?.length) continue;
            const orderKeys = [payload.name, String(payload.id || '')].filter(Boolean);
            const before = await WarrantyRecord.countDocuments({
                clientId: client.clientId,
                shopifyOrderId: { $in: orderKeys },
            });
            await processWarrantyAutoAssignment(client, payload);
            const after = await WarrantyRecord.countDocuments({
                clientId: client.clientId,
                shopifyOrderId: { $in: orderKeys },
            });
            if (after > before) assigned += after - before;
        } catch (err) {
            log.warn(`[Warranty] Backfill order skip: ${err.message}`);
        }
    }

    log.info(`[Warranty] Backfill for ${client.clientId}: scanned=${orders.length} newRecords=${assigned}`);
    return { assigned, scanned: orders.length };
}

module.exports = {
    processWarrantyAutoAssignment,
    backfillWarrantyFromRecentOrders,
    orderDocToShopifyPayload,
    isPaidShopifyOrder,
    orderEligibleAfterWarrantyEnabled,
};
