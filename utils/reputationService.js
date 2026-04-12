const ReviewRequest = require('../models/ReviewRequest');
const log = require('./logger')('ReputationService');
const WhatsApp = require('./whatsapp');

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
        const { getProductImageForOrder } = require('../routes/shopifyWebhook'); // Reusing helper if possible, else fetch separately

        for (const req of pending) {
            try {
                const client = await Client.findOne({ clientId: req.clientId });
                if (!client) continue;

                // Template: review_request
                // {{1}}=Name, {{2}}=Product
                // We'll use a smart sender that asks for sentiment 1-5
                const customerName = "Customer"; // Could fetch from AdLead if needed
                
                const message = `Hi ${customerName}! 👋 \n\nHow was your experience with *${req.productName}*? \n\nReply with a number:\n5 - Perfect! ⭐\n4 - Great\n3 - Okay\n2 - Poor\n1 - Terrible 😡`;

                await WhatsApp.sendText(client, req.phone, message);
                
                req.status = 'sent';
                req.sentAt = new Date();
                await req.save();

                log.info(`Review request sent to ${req.phone} for order ${req.orderId}`);
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
