'use strict';

/**
 * Base channel adapter — implement pullOrders, pullInventory, pushInventory, verifyConnection.
 */
class ChannelAdapter {
  constructor(clientId, config = {}) {
    this.clientId = clientId;
    this.config = config;
  }

  async verifyConnection() {
    return { ok: false, error: 'not_implemented' };
  }

  async pullOrders() {
    return { orders: [] };
  }

  async pullInventory() {
    return { snapshots: [] };
  }

  async pushInventory() {
    return { pushed: 0 };
  }

  async handleReturn() {
    return { handled: false };
  }
}

module.exports = { ChannelAdapter };
