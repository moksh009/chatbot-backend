"use strict";

const axios = require('axios');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const NotificationService = require('./notificationService');
const RTOPredictor = require('./rtoPredictor');
const { createCODPaymentLink } = require('./razorpay');
const { createCashfreePaymentLink } = require('./cashfree');
const { withShopifyRetry } = require('./shopifyHelper');
const log = require('./logger')('OrderCreator');

/**
 * Order Creator — Phase 28 Track 5
 * 
 * High-level coordinator for creating orders from Chat intents.
 * Handles store sync, payment links, and CRM updates.
 */

async function executeNativeOrder(client, phone, items, addressData, paymentMethod = 'cod') {
  try {
    const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const orderNumber = `NT-${Math.floor(1000 + Math.random() * 9000)}`;

    const lead = await AdLead.findOne({ clientId: client.clientId, phoneNumber: phone });
    
    // 1. External Store Sync (Shopify)
    let shopifyOrderId = null;
    if (client.storeType === 'shopify' && (client.shopifyAccessToken || client.commerce?.shopify?.accessToken)) {
      try {
        const shopifyOrderPayload = {
          order: {
            line_items: items.map(i => ({ 
              title: i.name, 
              quantity: i.quantity, 
              price: i.price,
              sku: i.sku 
            })),
            customer: {
              first_name: lead?.name || "WhatsApp Customer",
              phone: phone
            },
            shipping_address: {
              address1: addressData || lead?.address || "Pending Address",
              phone: phone
            },
            financial_status: paymentMethod === 'cod' ? 'pending' : 'authorized',
            tags: "AI-Chat-Order"
          }
        };

        const res = await withShopifyRetry(client.clientId, async (shop) => {
          return await shop.post('/orders.json', shopifyOrderPayload);
        });
        shopifyOrderId = res.data.order?.id;
        log.info(`[OrderCreator] Shopify Sync Success: ${shopifyOrderId}`);
      } catch (err) {
        log.warn(`[OrderCreator] Shopify Sync Failed, proceeding with local only: ${err.message}`);
      }
    }

    // 2. Risk Assessment (RTO)
    const risk = await RTOPredictor.calculateRisk(
      { gateway: paymentMethod, total_price: totalAmount, shipping_address: { address1: addressData } },
      { first_name: lead?.name, phone },
      lead
    );

    // 3. Persistence: Local MongoDB Order
    const localOrder = await Order.create({
      clientId: client.clientId,
      orderId: orderNumber,
      orderNumber: orderNumber,
      shopifyOrderId: shopifyOrderId ? String(shopifyOrderId) : undefined,
      customerName: lead?.name || "Customer",
      customerPhone: phone,
      totalPrice: totalAmount,
      status: 'pending',
      paymentMethod: paymentMethod === 'cod' ? 'COD' : 'Online',
      isCOD: paymentMethod === 'cod',
      address: addressData || lead?.address,
      items: items,
      rtoRiskScore: risk.score,
      rtoRiskLevel: risk.riskLevel,
      source: 'AI Native Order'
    });

    // 4. Payment Link Generation (Conditional)
    let paymentLink = null;
    if (paymentMethod === 'online' || (paymentMethod === 'unspecified' && client.waOrderTaking?.acceptOnline)) {
      try {
        if (client.activePaymentGateway === 'razorpay') {
          const linkData = await createCODPaymentLink(localOrder, client);
          paymentLink = linkData.short_url;
        } else if (client.activePaymentGateway === 'cashfree') {
          const linkData = await createCashfreePaymentLink(localOrder, client);
          paymentLink = linkData.short_url;
        }
        
        if (paymentLink) {
          await Order.updateOne({ _id: localOrder._id }, { $set: { razorpayUrl: paymentLink } });
        }
      } catch (err) {
        log.error(`[OrderCreator] Payment Link Generation Failed: ${err.message}`);
      }
    }

    // 5. CRM Updates (AdLead)
    if (lead) {
      await AdLead.updateOne(
        { _id: lead._id },
        { 
          $inc: { ordersCount: 1, totalSpent: totalAmount },
          $set: { isOrderPlaced: true, lastInteraction: new Date() },
          $push: { 
            activityLog: { 
              action: 'order_placed', 
              details: `Native Order ${orderNumber} created for ₹${totalAmount}. Status: ${paymentMethod}` 
            } 
          }
        }
      );
    }

    // 6. Notifications
    await NotificationService.sendAdminAlert(client, {
      customerPhone: phone,
      topic: `New Native Order: ${orderNumber} (₹${totalAmount})`,
      triggerSource: `AI Order Taker - Risk: ${risk.riskLevel}`
    });

    return {
      success: true,
      order: localOrder,
      paymentLink: paymentLink,
      risk: risk
    };

  } catch (error) {
    log.error(`[OrderCreator] Critical Failure: ${error.message}`);
    throw error;
  }
}

module.exports = { executeNativeOrder };
