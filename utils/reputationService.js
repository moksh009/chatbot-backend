const ReviewRequest = require('../models/ReviewRequest');
const log = require('./logger')('ReputationService');
const WhatsApp = require('./whatsapp');
const EmailService = require('./emailService');
const AdLead = require('../models/AdLead');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

/**
 * Schedules a review request for a specific order.
 * Typically called on order fulfillment or delivery.
 */
async function scheduleReviewRequest(client, orderData) {
    try {
        const phone = orderData.phone || orderData.customer?.phone || orderData.billing_address?.phone;
        if (!phone) return;

        const { normalizePhone } = require('./helpers');
        const cleanPhone = normalizePhone(phone);

        // Check if already scheduled for this order to avoid duplicates
        const existing = await ReviewRequest.findOne({ 
            clientId: client.clientId, 
            orderId: String(orderData.id) 
        });

        if (existing) {
            log.info(`Review request already exists for order ${orderData.id}`);
            return;
        }

        // Schedule for 3 days from now (customizable via client settings later)
        const scheduledFor = new Date();
        scheduledFor.setDate(scheduledFor.getDate() + 3);

        const reviewUrl = client.brand?.googleReviewUrl || '';

        const newRequest = await ReviewRequest.create({
            clientId: client.clientId,
            phone: cleanPhone,
            orderId: String(orderData.id),
            orderNumber: orderData.name || `#${orderData.id}`,
            productName: orderData.line_items?.[0]?.title || 'Your Purchase',
            reviewUrl: reviewUrl,
            status: 'scheduled',
            scheduledFor
        });

        log.info(`Scheduled review request for order ${orderData.id} at ${scheduledFor}`);
        return newRequest;
    } catch (err) {
        log.error('Failed to schedule review request:', err.message);
    }
}

/**
 * Process all pending review requests and dispatch messages.
 */
async function processPendingReviewRequests() {
    try {
        const now = new Date();
        const pending = await ReviewRequest.find({ 
            status: 'scheduled', 
            scheduledFor: { $lte: now } 
        });

        if (pending.length === 0) return;

        log.info(`Processing ${pending.length} pending review requests`);

        const Client = require('../models/Client');
        for (const req of pending) {
            try {
                const client = await Client.findOne({ clientId: req.clientId });
                if (!client) continue;

                // 1. Fetch Lead for Name and Email
                const lead = await AdLead.findOne({ phoneNumber: req.phone, clientId: req.clientId }).lean();
                const customerName = lead?.firstName || "Customer";
                const customerEmail = lead?.email;

                // 2. Determine Product Image
                let productImage = null;
                try {
                    const res = await require('axios').get(
                        `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${req.productId}.json`,
                        { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } }
                    );
                    productImage = res.data.product?.images?.[0]?.src || client.logoUrl || null;
                } catch { productImage = client.logoUrl || null; }

                // 3. Dispatch via WhatsApp (Smart Template)
                // Template: review_request
                // Parameters: {{1}}=Name, {{2}}=Product
                try {
                    await WhatsApp.sendSmartTemplate(
                        client, 
                        req.phone, 
                        'review_request', 
                        [customerName, req.productName], 
                        productImage
                    );
                } catch (waErr) {
                    log.warn(`Meta template review_request failed for ${req.phone}, falling back to text`);
                    const message = `Hi ${customerName}! 👋 \n\nHow was your experience with *${req.productName}*? \n\nReply with a number:\n5 - Perfect! ⭐\n4 - Great\n3 - Okay\n2 - Poor\n1 - Terrible 😡`;
                    await WhatsApp.sendText(client, req.phone, message);
                }

                // 4. Dispatch via Email (Multi-channel coverage)
                if (customerEmail) {
                    await EmailService.sendReviewRequestEmail(client, {
                        customerEmail,
                        customerName,
                        productName: req.productName,
                        reviewUrl: req.reviewUrl
                    });
                }
                
                req.status = 'sent';
                req.sentAt = new Date();
                await req.save();

                log.info(`Review request sent to ${req.phone} (${customerEmail || 'no email'}) for order ${req.orderId}`);
            } catch (itemErr) {
                log.error(`Failed to send review request ${req._id}:`, itemErr.message);
            }
        }
    } catch (err) {
        log.error('Global process review requests error:', err.message);
    }
}

module.exports = {
    scheduleReviewRequest,
    processPendingReviewRequests
};
