"use strict";

const log = require('./logger')('RTOPredictor');
const AdLead = require('../models/AdLead');

const RTOPredictor = {
  /**
   * Calculates an RTO (Return to Origin) Risk Score for a new order.
   * Higher score = Higher risk of RTO (cancelling/refusing package).
   * Range: 0 to 100
   * 
   * @param {Object} order Shopify/WooCommerce Order Payload
   * @param {Object} customer Customer Metadata
   * @param {Object} lead AdLead document
   * @returns {Object} { score, riskLevel, indicators }
   */
  async calculateRisk(order, customer, lead) {
    let score = 0;
    const indicators = [];

    try {
      // 1. Payment Method Risk
      // COD has incredibly high RTO risk compared to prepaid
      const isCOD = order.gateway === 'manual' || order.gateway?.toLowerCase().includes('cod') || order.gateway?.toLowerCase().includes('cash');
      if (isCOD) {
        score += 50;
        indicators.push('Cash on Delivery');
      }

      // 2. Behavioral Flags (from AdLead)
      // If they abandoned multiple carts before buying, might be impulsive
      if (lead) {
        if (lead.checkoutInitiatedCount > 2) {
          score += 15;
          indicators.push('Multiple pre-purchase hesitations');
        }

        // Previous RTO history
        // (Assuming we have a tag or count for previous fake orders)
        if (lead.tags?.includes('High RTO Risk') || lead.tags?.includes('Fake Order')) {
          score += 40;
          indicators.push('Previous high-risk activity');
        }
      }

      // 3. Demographic/Address Flags
      const address = order.shipping_address || order.billing_address;
      if (address) {
        if (!address.address2 && (!address.company || address.company.length === 0)) {
           // Basic heuristic: Very simple addresses with no appt/suite or company might be harder to deliver
           score += 10;
        }

        if (address.phone && address.phone.replace(/\D/g, '').length < 10) {
           score += 25;
           indicators.push('Invalid phone length in shipping');
        }
      }

      // 4. Order Value Anomaly
      // unusually large COD orders are a huge red flag
      const totalAmount = parseFloat(order.total_price || 0);
      if (isCOD && totalAmount > 5000) { // Assuming INR > 5000
        score += 20;
        indicators.push('Unusually high order value for COD');
      }

      // Cap at 100
      score = Math.min(score, 100);

      // Determine Level
      let riskLevel = 'Low';
      if (score >= 40) riskLevel = 'Medium';
      if (score >= 70) riskLevel = 'High';

      return { score, riskLevel, indicators };
    } catch (err) {
      log.error('CalculateRisk failed', { error: err.message });
      return { score: 0, riskLevel: 'Low', indicators: [] };
    }
  }
};

module.exports = RTOPredictor;
