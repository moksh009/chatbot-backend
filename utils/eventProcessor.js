"use strict";

const log = require('./logger')('EventProcessor');
const { findEventTriggeredFlow } = require('./triggerEngine');

/**
 * EVENT PROCESSOR
 * Bridges external commerce events (Shopify, WC, etc.) to the Automation Flow Builder.
 */

async function processShopifyEvent(client, topic, data) {
    log.info(`Processing Shopify event: ${topic} for client: ${client.clientId}`);

    let eventName = "";
    const eventData = {
        orderId: data.name || data.id,
        totalPrice: data.total_price,
        currency: data.currency,
        customerName: data.customer ? `${data.customer.first_name} ${data.customer.last_name || ''}`.trim() : 'Customer',
        phone: data.phone || data.customer?.phone || data.billing_address?.phone,
        email: data.email || data.customer?.email,
        items: data.line_items || []
    };

    switch (topic) {
        case 'orders/create':
            eventName = "ORDER_PLACED";
            break;
        case 'checkouts/create':
            eventName = "CHECKOUT_STARTED";
            break;
        case 'orders/fulfilled':
            eventName = "ORDER_FULFILLED";
            break;
        case 'orders/cancelled':
            eventName = "ORDER_CANCELLED";
            break;
        default:
            log.info(`Topic ${topic} not mapped to automation events.`);
            return;
    }

    if (!eventName || !eventData.phone) return;

    const eventKey = String(eventName).toLowerCase().replace(/_/g, '_');
    const legacyMap = {
        order_placed: 'order_placed',
        checkout_started: 'abandoned_cart',
        order_fulfilled: 'order_fulfilled',
        order_cancelled: 'order_status_changed',
    };
    const normalized = legacyMap[eventKey] || eventKey;

    await triggerFlowForEvent(normalized, eventData, client);
}

async function triggerFlowForEvent(eventName, eventData, client, status = null) {
    const { normalizePhone } = require('./helpers');
    const cleanPhone = normalizePhone(eventData.phone);
    const ev = String(eventName || '').toLowerCase();

    const result = await findEventTriggeredFlow(ev, eventData, client, status);

    if (result?.flow && result.startNodeId) {
        log.info(`Event ${eventName} matched flow: ${result.flow.name} for ${cleanPhone}`);
        const { runFlow } = require('./dualBrainEngine');
        await runFlow(client, cleanPhone, result.flow, result.startNodeId, {
            triggerSource: `event_${ev}`,
            eventContext: eventData
        });
    } else {
        log.debug(`No flow matched for event ${eventName} | Client: ${client.clientId}`);
    }
}

module.exports = {
    processShopifyEvent,
    triggerFlowForEvent
};
