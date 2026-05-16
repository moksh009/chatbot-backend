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
        const wf = client.wizardFeatures || {};
        const reviewsOn =
            wf.enableReviewCollection === true ||
            client.onboardingData?.features?.enableReviewCollection === true;
        if (!reviewsOn) {
            log.debug(`[Reputation] Review collection disabled for ${client.clientId} — skip schedule`);
            return;
        }

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

        const reviewUrl =
            client.brand?.googleReviewUrl ||
            client.googleReviewUrl ||
            client.platformVars?.googleReviewUrl ||
            '';
        if (!reviewUrl.trim()) {
            log.warn(`[Reputation] No Google review URL for ${client.clientId} — skip schedule`);
            return;
        }
        const firstItem = Array.isArray(orderData?.line_items) && orderData.line_items.length
            ? orderData.line_items[0]
            : null;
        const productId = firstItem?.product_id ? String(firstItem.product_id) : '';
        const productImage = firstItem?.image_url || firstItem?.image || '';

        const newRequest = await ReviewRequest.create({
            clientId: client.clientId,
            phone: cleanPhone,
            orderId: String(orderData.id),
            orderNumber: orderData.name || `#${orderData.id}`,
            productId,
            productName: firstItem?.title || 'Your Purchase',
            productImage: productImage || '',
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
 * Dispatch one review request document (used by cron + dry-run scripts).
 */
async function dispatchReviewRequest(req) {
    const Client = require('../models/Client');
    const client = await Client.findOne({ clientId: req.clientId });
    if (!client) return;

    const lead = await AdLead.findOne({ phoneNumber: req.phone, clientId: req.clientId }).lean();
    const customerName = lead?.firstName || "Customer";
    const customerEmail = lead?.email;

    const shopHost = (client.shopDomain || client.commerce?.shopify?.domain || "").replace(/^https?:\/\//, "").split("/")[0];
    const rawTok = client.shopifyAccessToken || client.commerce?.shopify?.accessToken;
    const { decrypt } = require("./encryption");
    const shopifyTok = rawTok ? decrypt(rawTok) : "";

    let productImage = req.productImage || null;
    try {
        if (!productImage && req.productId && shopHost && shopifyTok) {
            const res = await require('axios').get(
                `https://${shopHost}/admin/api/${shopifyAdminApiVersion}/products/${req.productId}.json`,
                { headers: { "X-Shopify-Access-Token": shopifyTok } }
            );
            productImage = res.data.product?.images?.[0]?.src || client.logoUrl || null;
        }
    } catch { productImage = client.logoUrl || null; }

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

    if (customerEmail) {
        await EmailService.sendReviewRequestEmail(client, {
            customerEmail,
            customerName,
            productName: req.productName,
            productImage,
            reviewUrl: req.reviewUrl
        });
    }

    req.status = 'sent';
    req.sentAt = new Date();
    await req.save();

    log.info(`Review request sent to ${req.phone} (${customerEmail || 'no email'}) for order ${req.orderId}`);
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

        for (const req of pending) {
            try {
                await dispatchReviewRequest(req);
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
    processPendingReviewRequests,
    dispatchReviewRequest
};
