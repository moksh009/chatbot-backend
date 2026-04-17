"use strict";

const axios = require('axios');
const log = require('./logger')('WhatsApp');
const { translateWhatsAppError } = require('./whatsappErrors');
const { decrypt } = require('./encryption');

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
   * Sends a video message
   */
  async sendVideo(client, phone, videoUrl, caption = "") {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'video',
        video: { link: videoUrl, caption }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendVideo");
    }
  },

  /**
   * Sends a document message
   */
  async sendDocument(client, phone, documentUrl, filename = "") {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'document',
        document: { link: documentUrl, filename: filename || "document.pdf" }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendDocument");
    }
  },

  /**
   * Sends an audio message (Voice Note)
   */
  async sendAudio(client, phone, audioUrl) {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'audio',
        audio: { link: audioUrl }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendAudio");
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
   * Sends a Catalog message (single product or full catalog)
   */
  async sendCatalog(client, phone, bodyText, footerText, productId = null) {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    const interactive = {
      type: 'catalog_message',
      body: { text: bodyText.substring(0, 1024) },
      action: {
        name: 'catalog_message',
        parameters: productId ? { thumbnail_product_retailer_id: productId } : undefined
      }
    };

    if (footerText) interactive.footer = { text: footerText.substring(0, 60) };

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'interactive',
        interactive
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendCatalog");
    }
  },

  /**
   * Sends a Multi-Product message (MPM)
   */
  async sendMultiProduct(client, phone, headerText, bodyText, sections) {
    const validPhone = validatePhone(phone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    // sections format: [{ title: '...', product_items: [{ product_retailer_id: '...' }] }]
    const interactive = {
      type: 'product_list',
      header: { type: 'text', text: headerText.substring(0, 60) },
      body: { text: bodyText.substring(0, 1024) },
      action: {
        catalog_id: client.metaCatalogId || process.env.META_CATALOG_ID,
        sections
      }
    };

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'interactive',
        interactive
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendMultiProduct");
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
   * Smartly builds components and sends a Meta Template based on its synced structure.
   * Prevents parameter mismatch errors and handles image headers.
   */
  async sendSmartTemplate(client, phone, templateName, rawVariables = [], headerImage = null, languageCode = 'en') {
    const syncedTemplates = client.syncedMetaTemplates || [];
    const template = syncedTemplates.find(t => t.name === templateName);
    
    // Robustly handle variables: convert comma-string to array if needed
    let variables = Array.isArray(rawVariables) 
      ? rawVariables 
      : (typeof rawVariables === 'string' ? rawVariables.split(',').map(v => v.trim()).filter(Boolean) : []);

    let components = [];

    if (template) {
      // 1. Process Header (Support for IMAGE)
      const header = template.components?.find(c => c.type === 'HEADER');
      if (header && header.format === 'IMAGE' && headerImage) {
        components.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerImage } }]
        });
      }

      // 2. Process Body (Match variable count exactly)
      const body = template.components?.find(c => c.type === 'BODY');
      if (body) {
        const paramMatches = body.text.match(/{{(\d+)}}/g) || [];
        const paramCount = paramMatches.length > 0 
          ? Math.max(...paramMatches.map(m => parseInt(m.match(/\d+/)[0]))) 
          : 0;

        const parameters = [];
        for (let i = 1; i <= paramCount; i++) {
          let val = variables[i - 1];
          if (val === undefined || val === null || String(val).trim() === "") {
             val = "-";
          }
          parameters.push({ type: 'text', text: String(val).substring(0, 1024) });
        }
        
        if (parameters.length > 0) {
          components.push({ type: 'body', parameters });
        }
      }
    } else {
      // Fallback: If template not synced, send variables sequentially
      log.warn(`[WhatsApp] Template ${templateName} not synced for ${client.clientId}. Using sequential fallback.`);
      if (variables.length > 0) {
        components.push({
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: String(v).substring(0, 1024) }))
        });
      }
      if (headerImage) {
        components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImage } }] });
      }
    }

    try {
      return await this.sendTemplate(client, phone, templateName, languageCode, components);
    } catch (err) {
      if (err.status === 404 || (err.data?.error_data?.details || "").includes("template name") || (err.message || "").includes("132001")) {
        log.warn(`[WhatsApp] Template ${templateName} failed (Missing). Falling back to TEXT for ${phone}`);
        
        let textFallback = `[Template: ${templateName}]`;
        if (variables.length > 0) {
            textFallback += `\n\n${variables.join('\n')}`;
        }
        
        return await this.sendText(client, phone, textFallback);
      }
      throw err; // Re-throw if it's a different error
    }
  },

  /**
   * Internal helper to extract credentials with validation
   */
  getCredentials(client) {
    let token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
    const phoneNumberId = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;

    // --- DECRYPTION FIX: Always decrypt if exists (supports plain-text fallback) ---
    if (token) {
        try {
            token = decrypt(token);
        } catch (err) {
            log.error(`[WhatsApp] Decryption failed for client ${client.clientId}`, err.message);
        }
    }

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
    const friendlyMessage = translateWhatsAppError(errorData);
    
    log.error(`[WhatsApp] ${operation} failed: ${message}`, {
      url,
      status,
      error: errorData
    });

    // Re-throw standardized error
    const error = new Error(`WhatsApp API Error: ${message}`);
    error.status = status;
    error.data = errorData;
    error.friendlyMessage = friendlyMessage;
    throw error;
  },

  /**
   * Fetches the WhatsApp Business Account status
   */
  async getAccountStatus(client) {
    const { token } = this.getCredentials(client);
    const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;
    if (!wabaId) return { status: 'UNKNOWN', reason: 'Missing WABA ID' };

    const url = `https://graph.facebook.com/v18.0/${wabaId}`;
    try {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      return {
        status: res.data.account_review_status || 'APPROVED',
        id: res.data.id,
        name: res.data.name
      };
    } catch (err) {
      log.error(`[WhatsApp] getAccountStatus failed: ${err.message}`);
      return { status: 'UNAVAILABLE', error: err.message };
    }
  },

  /**
   * Fetches Phone Number Quality and Tiering
   */
  async getPhoneNumberQuality(client) {
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}`;
    try {
      const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      return {
        qualityRating: res.data.quality_rating || 'GREEN',
        tier: res.data.messaging_limit_tier || 'Tier 1 (1k/day)',
        status: res.data.status || 'CONNECTED'
      };
    } catch (err) {
      log.error(`[WhatsApp] getPhoneNumberQuality failed: ${err.message}`);
      return { qualityRating: 'UNKNOWN', tier: 'N/A' };
    }
  },

  /**
   * Submits a WhatsApp template to Meta for approval via Graph API.
   * Employs a Hybrid "Try/Catch" pipeline: if Meta fails due to API auth/permissions,
   * it silently catches the error and degrades to PENDING_MANUAL_AUTH.
   */
  async submitMetaTemplate(client, templatePayload) {
    try {
      const { token } = this.getCredentials(client);
      const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;
      
      if (!wabaId || !token) throw new Error("Missing Meta WABA ID or Token");

      const url = `https://graph.facebook.com/v18.0/${wabaId}/message_templates`;
      
      log.info(`[WhatsApp] Submitting template ${templatePayload.name} to Meta...`);
      const res = await axios.post(url, templatePayload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      return { 
        success: true, 
        id: res.data.id, 
        status: res.data.status || 'PENDING' 
      };
      
    } catch (err) {
      // Catch & Mock: Fail gracefully for onboarding flow UX
      log.error(`[WhatsApp] submitMetaTemplate API error (Mocking success):`, err.response?.data || err.message);
      return { 
        success: true, // we mock success to prevent flow generation crash
        status: 'PENDING_MANUAL_AUTH',
        errorBlocked: err.response?.data?.error?.message || err.message
      };
    }
  }
};

module.exports = WhatsApp;
