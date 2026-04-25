"use strict";

const WhatsApp = require('./whatsapp');
const ScheduledMessage = require('../models/ScheduledMessage');
const Client = require('../models/Client');
const log = require('./logger')('SKUTrigger');

/**
 * SKU Trigger Service
 * Handles automated WhatsApp messaging based on product-level events.
 */
const SkuTriggerService = {
  /**
   * Process SKU triggers for an order
   * @param {Object} order - Normalized order object { items: [{sku, name}], customerPhone, customerName }
   * @param {String} eventType - 'paid', 'fulfilled', 'cancelled', 'refunded'
   * @param {Object} clientConfig - Client configuration object
   */
  async processTriggers(order, eventType, clientConfig) {
    try {
      const { skuAutomations = [], clientId } = clientConfig;
      if (!skuAutomations.length) return;

      const phone = order.customerPhone || order.phone;
      if (!phone) return;

      log.info(`Processing SKU triggers for order ${order.orderId || order.orderNumber} | Event: ${eventType}`);

      for (const item of order.items || []) {
        const itemSku = (item.sku || "").trim().toLowerCase();
        if (!itemSku) continue;

        // Find matching automations
        const matches = skuAutomations.filter(auto => {
          if (!auto.isActive || auto.triggerEvent !== eventType) return false;
          
          const targetSku = (auto.sku || "").trim().toLowerCase();
          if (auto.matchType === 'contains') {
            return itemSku.includes(targetSku);
          }
          return itemSku === targetSku;
        });

        for (const automation of matches) {
          log.info(`Matched SKU Trigger: ${automation.sku} -> ${automation.templateName} for ${phone}`);

          if (automation.delayMinutes > 0) {
            // Schedule for later
            await this.scheduleMessage(order, automation, clientConfig);
          } else {
            // Send immediately
            await this.sendImmediate(order, item, automation, clientConfig);
          }

          // Increment internal stats if available in automation object
          // Note: In a real DB, we'd update the Client model's skuAutomations array
          await Client.findOneAndUpdate(
            { clientId, "skuAutomations.sku": automation.sku },
            { $inc: { "skuAutomations.$.stats.sent": 1 } }
          ).catch(err => log.error('Failed to update SKU stats:', err.message));
        }
      }
    } catch (err) {
      log.error('processTriggers error:', err.message);
    }
  },

  /**
   * Sends a trigger message immediately
   */
  async sendImmediate(order, item, automation, clientConfig) {
    try {
      const phone = order.customerPhone || order.phone;
      const variables = [
        order.customerName || 'Customer',
        item.name || automation.sku,
        order.orderNumber || order.orderId || ''
      ];

      await WhatsApp.sendSmartTemplate(
        clientConfig,
        phone,
        automation.templateName,
        variables,
        automation.imageUrl,
        automation.language || 'en'
      );
      
      log.info(`Immediate SKU trigger sent to ${phone} for SKU ${automation.sku}`);
    } catch (err) {
      log.error(`sendImmediate error for ${automation.sku}:`, err.message);
    }
  },

  /**
   * Schedules a trigger message for future delivery
   */
  async scheduleMessage(order, automation, clientConfig) {
    try {
      const scheduledTime = new Date(Date.now() + automation.delayMinutes * 60 * 1000);
      const phone = order.customerPhone || order.phone;

      await ScheduledMessage.create({
        clientId: clientConfig.clientId,
        phone,
        type: 'template',
        templateName: automation.templateName,
        variables: [
          order.customerName || 'Customer',
          automation.sku,
          order.orderNumber || order.orderId || ''
        ],
        headerImage: automation.imageUrl,
        scheduledFor: scheduledTime,
        status: 'pending',
        metadata: {
          source: 'sku_trigger',
          sku: automation.sku,
          triggerEvent: automation.triggerEvent
        }
      });

      log.info(`Scheduled SKU trigger for ${phone} at ${scheduledTime.toISOString()}`);
    } catch (err) {
      log.error(`scheduleMessage error for ${automation.sku}:`, err.message);
    }
  }
};

module.exports = SkuTriggerService;
