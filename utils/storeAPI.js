const axios = require('axios');
const log = require('./logger')('StoreAPI');

/**
 * Unified Store API Abstraction
 * Supports Shopify (REST Admin) and WooCommerce (REST API)
 */
class StoreAPI {
  constructor(clientData) {
    this.client = clientData;
    this.type = clientData.storeType || 'shopify';
  }

  /**
   * Get Header for Auth
   */
  getHeaders() {
    if (this.type === 'shopify') {
      return {
        'X-Shopify-Access-Token': this.client.shopifyAccessToken,
        'Content-Type': 'application/json'
      };
    } else if (this.type === 'woocommerce') {
      const auth = Buffer.from(`${this.client.woocommerceKey}:${this.client.woocommerceSecret}`).toString('base64');
      return {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      };
    }
    return {};
  }

  getBaseUrl() {
    if (this.type === 'shopify') {
      return `https://${this.client.shopDomain}/admin/api/2024-01`;
    } else if (this.type === 'woocommerce') {
        const url = this.client.woocommerceUrl.replace(/\/$/, '');
        return `${url}/wp-json/wc/v3`;
    }
    return '';
  }

  /**
   * Fetch Order Details
   */
  async getOrder(orderId) {
    const url = this.type === 'shopify' 
      ? `${this.getBaseUrl()}/orders/${orderId}.json`
      : `${this.getBaseUrl()}/orders/${orderId}`;
    
    try {
      const res = await axios.get(url, { headers: this.getHeaders() });
      const raw = this.type === 'shopify' ? res.data.order : res.data;
      
      // Normalize to common format
      return {
        id: raw.id,
        order_number: raw.order_number || raw.number,
        total_price: raw.total_price || raw.total,
        currency: raw.currency || raw.currency,
        customer: {
          first_name: raw.customer?.first_name || raw.billing?.first_name,
          last_name: raw.customer?.last_name || raw.billing?.last_name,
          phone: raw.customer?.phone || raw.billing?.phone
        },
        line_items: (raw.line_items || []).map(li => ({
          title: li.title || li.name,
          quantity: li.quantity,
          price: li.price
        })),
        checkout_url: raw.order_status_url || ''
      };
    } catch (err) {
      log.error(`Failed to fetch ${this.type} order ${orderId}`, { error: err.message });
      throw err;
    }
  }

  /**
   * Create Discount Code / Coupon
   */
  async createDiscount(amount, type = 'fixed_amount') {
    if (this.type === 'shopify') {
      // Shopify requires Price Rules + Discount Codes (simplified here)
      return { code: 'PREPAID' + Math.floor(Math.random()*1000), value: amount };
    } else if (this.type === 'woocommerce') {
      const url = `${this.getBaseUrl()}/coupons`;
      const payload = {
        code: 'NUDGE' + Math.floor(Math.random()*1000),
        amount: amount.toString(),
        discount_type: type === 'percentage' ? 'percent' : 'fixed_cart'
      };
      try {
        const res = await axios.post(url, payload, { headers: this.getHeaders() });
        return { code: res.data.code, value: amount };
      } catch (err) {
        log.error('WooCommerce Coupon Creation Failed', { error: err.message });
        return { code: 'SAVE' + amount, value: amount }; // Fallback
      }
    }
  }
}

module.exports = StoreAPI;
