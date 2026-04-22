const WarrantyBatch = require('../models/WarrantyBatch');
const WarrantyRecord = require('../models/WarrantyRecord');
const Contact = require('../models/Contact');
const { normalizePhone } = require('./helpers');
const { sendNotifications } = require('./warrantyService');
const log = require('./logger')('WarrantyEngine');

/**
 * Enterprise Warranty Auto-Assign Engine
 * Automatically processes fulfilled orders to generate warranty certificates based on active batches.
 */
async function processWarrantyAutoAssignment(client, data) {
    try {
        const phoneRaw = data.phone || data.customer?.phone || data.billing_address?.phone;
        if (!phoneRaw) {
            log.debug(`[Warranty] No phone found for order ${data.name || data.id}. Skipping.`);
            return;
        }

        const cleanPhone = normalizePhone(phoneRaw);
        const orderDate = new Date(data.created_at || Date.now());
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

                const expiryDate = new Date(orderDate);
                expiryDate.setMonth(expiryDate.getMonth() + batch.durationMonths);

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

module.exports = {
    processWarrantyAutoAssignment
};
