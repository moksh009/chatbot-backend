"use strict";

const axios = require('axios');
const log = require('./logger')('WhatsApp');

/**
 * Validates a phone number is a valid string of digits.
 */
function validatePhone(phone) {
  if (typeof phone !== 'string' || !phone.trim() || !/^\d+$/.test(phone.trim())) {
    throw new Error(`[WhatsApp] Invalid phone number: ${phone}`);
  }
  return phone.trim();
}

/**
 * Unified WhatsApp Cloud API helper
 */
const WhatsApp = {
  /**
   * Sends a plain text message
   */
  async sendText(client, phone, body) {
    const validPhone = validatePhone(phone);
    if (!body) throw new Error("[WhatsApp] Empty message body");

    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'text',
        text: { body }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendText");
    }
  },

  /**
   * Sends an image message
   */
  async sendImage(client, phone, imageUrl, caption = "") {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'image',
        image: { link: imageUrl, caption }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendImage");
    }
  },

  /**
   * Sends an interactive message (buttons or list)
   */
  async sendInteractive(client, phone, interactive, bodyText) {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to: validPhone,
      type: 'interactive',
      interactive: {
        ...interactive,
        body: { text: (bodyText || "").substring(0, 1024) }
      }
    };

    // Sanitize buttons (Max 3)
    if (interactive.type === 'button' && interactive.action?.buttons?.length > 3) {
      log.warn(`[WhatsApp] Truncating buttons to 3 for ${phone}`);
      payload.interactive.action.buttons = interactive.action.buttons.slice(0, 3);
    }

    try {
      const res = await axios.post(url, payload, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendInteractive");
    }
  },

  /**
   * Sends a Meta Template
   */
  async sendTemplate(client, phone, templateName, languageCode = 'en', components = []) {
    const validPhone = validatePhone(phone);
    if (!templateName) throw new Error("[WhatsApp] templateName is required");

    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components
        }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendTemplate");
    }
  },

  /**
   * Internal helper to extract credentials with validation
   */
  getCredentials(client) {
    const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneNumberId = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    if (!token || !phoneNumberId) {
      throw new Error(`[WhatsApp] Missing credentials for client ${client.clientId}`);
    }
    return { token, phoneNumberId };
  },

  /**
   * Common error handler
   */
  handleError(err, url, operation) {
    const status = err.response?.status;
    const errorData = err.response?.data?.error || err.message;
    const message = errorData.message || errorData;
    
    log.error(`[WhatsApp] ${operation} failed: ${message}`, {
      url,
      status,
      error: errorData
    });

    // Re-throw standardized error
    const error = new Error(`WhatsApp API Error: ${message}`);
    error.status = status;
    error.data = errorData;
    throw error;
  }
};

module.exports = WhatsApp;
