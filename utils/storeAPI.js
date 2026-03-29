"use strict";

const axios = require('axios');
const log = require('./logger')('StoreAPI');

/**
 * Unified Store API Abstraction
 * Supports Shopify (REST Admin) and WooCommerce (REST API)
 */
class StoreAPI {
  constructor(clientData) {
    if (!clientData) throw new Error("[StoreAPI] clientData is required");
    this.client = clientData;
    this.type = clientData.storeType || 'shopify';
    
    // Validate credentials
    if (this.type === 'shopify') {
      if (!this.client.shopDomain || !this.client.shopifyAccessToken) {
        throw new Error(`[StoreAPI] Shopify credentials missing for ${this.client.clientId}`);
      }
    } else if (this.type === 'woocommerce') {
      if (!this.client.woocommerceUrl || !this.client.woocommerceKey || !this.client.woocommerceSecret) {
        throw new Error(`[StoreAPI] WooCommerce credentials missing for ${this.client.clientId}`);
      }
    }
  }

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
   * Fetch Multiple Orders
   */
  async getOrders(limit = 10) {
    if (this.type === 'manual') return [];
    const url = this.type === 'shopify' 
      ? `${this.getBaseUrl()}/orders.json?limit=${limit}&status=any`
      : `${this.getBaseUrl()}/orders?per_page=${limit}`;
    
    try {
      const res = await axios.get(url, { headers: this.getHeaders() });
      const orders = this.type === 'shopify' ? res.data.orders : res.data;
      return orders.map(o => this.normalizeOrder(o));
    } catch (err) {
      this.handleError(err, url, "getOrders");
    }
  }

  /**
   * Fetch Products
   */
  async getProducts(limit = 20) {
    if (this.type === 'manual') return [];
    const url = this.type === 'shopify' 
      ? `${this.getBaseUrl()}/products.json?limit=${limit}`
      : `${this.getBaseUrl()}/products?per_page=${limit}`;
    
    try {
      const res = await axios.get(url, { headers: this.getHeaders() });
      const products = this.type === 'shopify' ? res.data.products : res.data;
      return products.map(p => ({
        id: p.id,
        title: p.title || p.name,
        price: this.type === 'shopify' ? p.variants?.[0]?.price : p.price,
        image: this.type === 'shopify' ? p.image?.src : p.images?.[0]?.src,
        url: this.type === 'shopify' ? `https://${this.client.shopDomain}/products/${p.handle}` : p.permalink
      }));
    } catch (err) {
      this.handleError(err, url, "getProducts");
    }
  }

  /**
   * Create Discount Code
   */
  async createDiscountCode(amount, type = 'fixed_amount') {
    if (this.type === 'manual') return { code: 'MANUAL' + amount, value: amount };
    
    if (this.type === 'shopify') {
      // Logic for Shopify Price Rule + Discount Code would go here
      // For now, return a placeholder as Shopify requires a 2-step process
      return { code: 'SAVE' + amount, value: amount };
    } else if (this.type === 'woocommerce') {
      const url = `${this.getBaseUrl()}/coupons`;
      const payload = {
        code: 'NUDGE' + Math.floor(Math.random()*10000),
        amount: amount.toString(),
        discount_type: type === 'percentage' ? 'percent' : 'fixed_cart'
      };
      try {
        const res = await axios.post(url, payload, { headers: this.getHeaders() });
        return { code: res.data.code, value: amount };
      } catch (err) {
        this.handleError(err, url, "createDiscountCode");
      }
    }
  }

  normalizeOrder(raw) {
    return {
      id: raw.id,
      order_number: raw.order_number || raw.number,
      total_price: raw.total_price || raw.total,
      status: raw.financial_status || raw.status,
      customer: {
        first_name: raw.customer?.first_name || raw.billing?.first_name || "Customer",
        phone: raw.customer?.phone || raw.billing?.phone || ""
      }
    };
  }

  handleError(err, url, op) {
    const msg = err.response?.data?.errors || err.response?.data?.message || err.message;
    log.error(`[StoreAPI] ${op} failed for ${this.type}`, { url, error: msg });
    throw new Error(`[StoreAPI] ${op} failed: ${JSON.stringify(msg)}`);
  }
}

module.exports = StoreAPI;
