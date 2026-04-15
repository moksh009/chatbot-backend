"use strict";

const log = require('./logger')('EventProcessor');
const { matchEventTrigger } = require('./triggerEngine');
const { findFlowStartNode } = require('./triggerEngine');
const WhatsAppFlow = require('../models/WhatsAppFlow');

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

    await triggerFlowForEvent(eventName, eventData, client);
}

async function triggerFlowForEvent(eventName, eventData, client) {
    const { normalizePhone } = require('./helpers');
    const cleanPhone = normalizePhone(eventData.phone);
    
    // 1. Find a matching flow in WhatsAppFlow collection
    const matchingFlow = await matchEventTrigger(eventName, eventData, client);
    
    if (matchingFlow) {
        log.info(`Event ${eventName} matched flow: ${matchingFlow.name} for ${cleanPhone}`);
        
        // 2. Find start node
        const startNodeId = findFlowStartNode(matchingFlow.nodes, matchingFlow.edges);
        
        if (startNodeId) {
            // 3. Hand over to DualBrain to execute the flow
            const { runFlow } = require('./dualBrainEngine');
            await runFlow(client, cleanPhone, matchingFlow, startNodeId, {
                triggerSource: `event_${eventName.toLowerCase()}`,
                eventContext: eventData
            });
        }
    } else {
        log.debug(`No flow matched for event ${eventName} | Client: ${client.clientId}`);
    }
}

module.exports = {
    processShopifyEvent,
    triggerFlowForEvent
};
