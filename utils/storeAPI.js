"use strict";

const axios = require('axios');
const log = require('./logger')('StoreAPI');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

/**
 * Store API — Shopify (and optional manual mode). WooCommerce support removed.
 */
class StoreAPI {
  constructor(clientData) {
    if (!clientData) throw new Error("[StoreAPI] clientData is required");
    this.client = clientData;
    this.type = clientData.storeType || 'shopify';

    if (this.type === 'shopify') {
      if (!this.client.shopDomain || !this.client.shopifyAccessToken) {
        throw new Error(`[StoreAPI] Shopify credentials missing for ${this.client.clientId}`);
      }
    }
  }

  getHeaders() {
    if (this.type === 'shopify') {
      return {
        'X-Shopify-Access-Token': this.client.shopifyAccessToken,
        'Content-Type': 'application/json'
      };
    }
    return {};
  }

  getBaseUrl() {
    if (this.type === 'shopify') {
      return `https://${this.client.shopDomain}/admin/api/${shopifyAdminApiVersion}`;
    }
    return '';
  }

  async getOrders(limit = 10) {
    if (this.type === 'manual') return [];
    const url = `${this.getBaseUrl()}/orders.json?limit=${limit}&status=any`;
    try {
      const res = await axios.get(url, { headers: this.getHeaders() });
      const orders = res.data.orders;
      return orders.map(o => this.normalizeOrder(o));
    } catch (err) {
      this.handleError(err, url, "getOrders");
    }
  }

  async getProducts(limit = 20) {
    if (this.type === 'manual') return [];
    const url = `${this.getBaseUrl()}/products.json?limit=${limit}`;
    try {
      const res = await axios.get(url, { headers: this.getHeaders() });
      const products = res.data.products;
      return products.map(p => ({
        id: p.id,
        title: p.title,
        price: p.variants?.[0]?.price,
        image: p.image?.src,
        url: `https://${this.client.shopDomain}/products/${p.handle}`
      }));
    } catch (err) {
      this.handleError(err, url, "getProducts");
    }
  }

  async createDiscountCode(amount, type = 'fixed_amount') {
    if (this.type === 'manual') return { code: 'MANUAL' + amount, value: amount };
    if (this.type === 'shopify') {
      return { code: 'SAVE' + amount, value: amount };
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
