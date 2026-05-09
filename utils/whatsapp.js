"use strict";

const axios = require('axios');
const log = require('./logger')('WhatsApp');
const { getBreaker } = require('./circuitBreaker');
const { translateWhatsAppError } = require('./whatsappErrors');

/** Shared breaker for WhatsApp Cloud API (Graph) — avoids hammering Meta during outages */
const waGraphBreaker = getBreaker('whatsapp_graph', { failureThreshold: 5, resetTimeoutMs: 45000 });
const { decrypt } = require('./encryption');
const AdLead = require('../models/AdLead');
const SuppressionList = require('../models/SuppressionList');

/**
 * Validates a phone number is a valid string of digits.
 */
function validatePhone(phone) {
  if (!phone) throw new Error(`[WhatsApp] Missing phone number`);
  // Clean phone: remove everything except digits
  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.length < 10) {
    throw new Error(`[WhatsApp] Invalid phone length: ${cleanPhone}`);
  }
  return cleanPhone;
}

/**
 * Unified WhatsApp Cloud API helper
 */
const WhatsApp = {
  async markBlockedOptOut(client, phone, errorData) {
      await SuppressionList.findOneAndUpdate(
        { clientId: client.clientId, phone: normalized },
        {
          $set: {
            reason: 'spam_report',
            source: 'whatsapp_block',
            addedAt: new Date(),
          },
        },
        { upsert: true }
      );
    try {
      const code = Number(errorData?.code || errorData?.error_subcode || 0);
      const msg = String(errorData?.message || '').toLowerCase();
      const blocked = code === 131026 || msg.includes('blocked');
      if (!blocked || !client?.clientId || !phone) return;
      const normalized = String(phone).replace(/\D/g, '');
      await AdLead.findOneAndUpdate(
        { clientId: client.clientId, phoneNumber: normalized },
        {
          $set: {
            optStatus: 'opted_out',
            optOutDate: new Date(),
            optOutSource: 'whatsapp_block',
            whatsappMarketingEligible: false,
          },
          $push: {
            optInHistory: {
              event: 'opted_out',
              action: 'opted_out',
              source: 'whatsapp_block',
              timestamp: new Date(),
              note: 'Meta indicated recipient blocked business number',
            },
          },
        }
      );
    } catch (e) {
      log.warn(`[WhatsApp] failed to mark blocked opt-out: ${e.message}`);
    }
  },

  async ensureNotSuppressed(client, phone) {
    if (!client?.clientId || !phone) return;
    const normalized = String(phone).replace(/\D/g, '');
    const found = await SuppressionList.exists({ clientId: client.clientId, phone: normalized });
    if (found) {
      const err = new Error('Suppressed contact');
      err.friendlyMessage = 'Contact is suppressed';
      err.code = 'SUPPRESSED_CONTACT';
      throw err;
    }
  },
  async sendInteractiveMessage(phoneNumberId, to, node, token) {
    const { interactiveType, body, buttonsList, sections,
            headerText, footerText } = node.data;
    
    // Validate phone format
    const phone = String(to).replace(/\D/g, "");
    if (!phone || phone.length < 10) throw new Error("Invalid phone number");
    
    // Validate body
    if (!body || body.trim().length === 0) {
      throw new Error("Interactive message body cannot be empty");
    }
    
    let interactivePayload;
    
    if (interactiveType === "button") {
      // Validate buttons
      const buttons = (buttonsList || []).slice(0, 3); // Max 3
      if (buttons.length === 0) throw new Error("Button message needs at least 1 button");
      
      // Ensure unique IDs and valid titles
      const uniqueButtons = [];
      const seenIds = new Set();
      for (const btn of buttons) {
        // CRITICAL: Button IDs must match edge sourceHandle IDs verbatim.
        // If btn.id is missing, the interactive node was not authored correctly.
        if (!btn.id) {
          console.warn(`[WA] ⚠️ Button "${btn.title}" has no ID. Generating fallback — edge routing will FAIL. Fix InteractiveNode authoring.`);
        }
        const id = String(btn.id || `btn_fallback_${uniqueButtons.length + 1}`);
        const title = String(btn.title || "Option").slice(0, 20); // Max 20 chars
        if (!seenIds.has(id)) {
          seenIds.add(id);
          uniqueButtons.push({ type: "reply", reply: { id, title } });
        }
      }
      
      interactivePayload = {
        type: "button",
        body: { text: String(body).slice(0, 1024) }, // Max 1024 chars
        action: { buttons: uniqueButtons }
      };
      
      // Optional header
      if (headerText && headerText.trim()) {
        interactivePayload.header = {
          type: "text",
          text: String(headerText).slice(0, 60)
        };
      }
      
      // Optional footer
      if (footerText && footerText.trim()) {
        interactivePayload.footer = {
          text: String(footerText).slice(0, 60)
        };
      }
      
    } else if (interactiveType === "list") {
      // Build sections
      const listSections = (sections || []).map(section => ({
        title: String(section.title || "Options").slice(0, 24),
        rows: (section.rows || []).slice(0, 10).map(row => ({
          id: String(row.id || `row_${Math.random().toString(36).slice(2, 6)}`),
          title: String(row.title || "Option").slice(0, 24),
          description: row.description
            ? String(row.description).slice(0, 72)
            : undefined
        }))
      }));
      
      if (listSections.length === 0 || listSections[0].rows.length === 0) {
        throw new Error("List message needs at least 1 section with 1 row");
      }
      
      interactivePayload = {
        type: "list",
        body: { text: String(body).slice(0, 1024) },
        action: {
          button: String(node.data.listButtonText || "View Options").slice(0, 20),
          sections: listSections
        }
      };
      
      if (headerText && headerText.trim()) {
        interactivePayload.header = {
          type: "text",
          text: String(headerText).slice(0, 60)
        };
      }
      
      if (footerText && footerText.trim()) {
        interactivePayload.footer = {
          text: String(footerText).slice(0, 60)
        };
      }
    }
    
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "interactive",
      interactive: interactivePayload
    };
    
    console.log("[WA] Sending interactive:", JSON.stringify(payload, null, 2));
    
    const response = await waGraphBreaker.exec(() =>
      axios.post(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      )
    );

    return response.data;
  },

  /**
   * Sends a plain text message
   */
  async sendText(client, phone, body) {
    const validPhone = validatePhone(phone);
    if (!body) throw new Error("[WhatsApp] Empty message body");
    await this.ensureNotSuppressed(client, validPhone);

    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await waGraphBreaker.exec(() =>
        axios.post(
          url,
          {
            messaging_product: 'whatsapp',
            to: validPhone,
            type: 'text',
            text: { body: String(body).substring(0, 4096) }
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        )
      );
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendText", { client, phone: validPhone });
    }
  },

  /**
   * Sends an image message
   */
  async sendImage(client, phone, imageUrl, caption = "") {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'image',
        image: { link: imageUrl, caption: String(caption).substring(0, 1024) }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendImage", { client, phone: validPhone });
    }
  },

  /**
   * Sends a video message
   */
  async sendVideo(client, phone, videoUrl, caption = "") {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'video',
        video: { link: videoUrl, caption: String(caption).substring(0, 1024) }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendVideo", { client, phone: validPhone });
    }
  },

  /**
   * Sends a document message
   */
  async sendDocument(client, phone, documentUrl, filename = "") {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'document',
        document: { link: documentUrl, filename: String(filename || "document.pdf").substring(0, 240) }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendDocument", { client, phone: validPhone });
    }
  },

  /**
   * Sends an audio message (Voice Note)
   */
  async sendAudio(client, phone, audioUrl) {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await axios.post(url, {
        messaging_product: 'whatsapp',
        to: validPhone,
        type: 'audio',
        audio: { link: audioUrl }
      }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendAudio", { client, phone: validPhone });
    }
  },

  /**
   * Sends an interactive message (buttons or list)
   */
  async sendInteractive(client, phone, interactive, bodyText) {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to: validPhone,
      type: 'interactive',
      interactive: {
        ...interactive,
        body: { text: (bodyText || "").substring(0, 1024) }
      }
    };

    // Strict Meta Validation Engine
    if (interactive.type === 'button') {
      if (!interactive.action?.buttons || interactive.action.buttons.length === 0) {
        log.error(`[WhatsApp] Interactive button message has no buttons. Dropping.`);
        return;
      }
      // Enforce max 3 buttons
      if (interactive.action.buttons.length > 3) {
        log.warn(`[WhatsApp] Truncating buttons to 3 for ${phone}`);
        interactive.action.buttons = interactive.action.buttons.slice(0, 3);
      }
      // Enforce 20 char limit on button titles and ensure unique IDs
      const seenIds = new Set();
      interactive.action.buttons.forEach((btn, index) => {
        if (!btn.reply.id) btn.reply.id = `btn_${index}`;
        if (seenIds.has(btn.reply.id)) btn.reply.id = `${btn.reply.id}_${index}`;
        seenIds.add(btn.reply.id);
        
        if (btn.reply.title.length > 20) {
          btn.reply.title = btn.reply.title.substring(0, 17) + '...';
        }
      });
    } else if (interactive.type === 'list') {
      if (!interactive.action?.sections || interactive.action.sections.length === 0) {
        log.error(`[WhatsApp] Interactive list message has no sections. Dropping.`);
        return;
      }
      // Enforce max 10 rows across all sections
      let totalRows = 0;
      const seenIds = new Set();
      for (const section of interactive.action.sections) {
        section.title = String(section.title || "Options").substring(0, 24);
        if (section.rows) {
          if (totalRows + section.rows.length > 10) {
            section.rows = section.rows.slice(0, 10 - totalRows);
          }
          totalRows += section.rows.length;
          
          section.rows.forEach((row, index) => {
             if (!row.id) row.id = `row_${index}`;
             if (seenIds.has(row.id)) row.id = `${row.id}_${index}`;
             seenIds.add(row.id);

             if (row.title.length > 24) row.title = row.title.substring(0, 24);
             if (row.description && row.description.length > 72) row.description = row.description.substring(0, 72);
          });
        }
      }
    }

    try {
      const res = await axios.post(url, payload, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      // --- INTERACTIVE FALLBACK (Phase 30 Resilience) ---
      // Log the FULL Meta error response for production debugging
      const metaStatus = err.response?.status || 'UNKNOWN';
      const metaBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      log.error(`[sendInteractive] META_ERROR: ${metaStatus} | ${metaBody} | phone=${phone}`);
      log.warn(`[WhatsApp] sendInteractive failed for ${phone}. Falling back to plain text.`);
      
      let fallbackText = bodyText || "";
      if (interactive.header?.text) fallbackText = `*${interactive.header.text}*\n\n` + fallbackText;
      
      // Convert buttons/rows to a numbered list
      const options = [];
      if (interactive.action?.buttons) {
        interactive.action.buttons.forEach(b => options.push(b.reply?.title));
      } else if (interactive.action?.sections) {
        interactive.action.sections.forEach(s => {
            s.rows?.forEach(r => options.push(r.title));
        });
      }

      if (options.length > 0) {
        fallbackText += "\n\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
        fallbackText += "\n\n_Reply with the option name or number._";
      }

      try {
        return await this.sendText(client, phone, fallbackText);
      } catch (innerErr) {
        this.handleError(err, url, "sendInteractive", { client, phone: validPhone });
      }
    }
  },

  /**
   * Sends a Catalog message (single product or full catalog)
   */
  async sendCatalog(client, phone, bodyText, footerText, productId = null) {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

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
      this.handleError(err, url, "sendCatalog", { client, phone: validPhone });
    }
  },

  /**
   * Sends a Multi-Product message (MPM)
   */
  async sendMultiProduct(client, phone, headerText, bodyText, sections) {
    const validPhone = validatePhone(phone);
    await this.ensureNotSuppressed(client, validPhone);
    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    const catalogId = client.waCatalogId || client.metaCatalogId || process.env.META_CATALOG_ID;
    if (!catalogId) {
      throw new Error(`[WhatsApp] Missing catalog ID for ${client.clientId}`);
    }

    // sections format: [{ title: '...', product_items: [{ product_retailer_id: '...' }] }]
    const interactive = {
      type: 'product_list',
      header: { type: 'text', text: headerText.substring(0, 60) },
      body: { text: bodyText.substring(0, 1024) },
      action: {
        catalog_id: catalogId,
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
      this.handleError(err, url, "sendMultiProduct", { client, phone: validPhone });
    }
  },

  /**
   * Sends a Meta Template
   */
  async sendTemplate(client, phone, templateName, languageCode = 'en', components = []) {
    const validPhone = validatePhone(phone);
    if (!templateName) throw new Error("[WhatsApp] templateName is required");
    await this.ensureNotSuppressed(client, validPhone);

    const rawComponents = Array.isArray(components) ? components : [];

    // Pre-flight validation: ensure component structure is valid
    const validatedComponents = rawComponents.filter(c => {
      if (!c || !c.type) {
        log.warn(`[WhatsApp] Dropping invalid component (missing type) for template ${templateName}`);
        return false;
      }
      if (c.parameters && !Array.isArray(c.parameters)) {
        log.warn(`[WhatsApp] Dropping component with non-array parameters for template ${templateName}`);
        return false;
      }
      return true;
    });

    const { token, phoneNumberId } = this.getCredentials(client);
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to: validPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: validatedComponents
      }
    };

    // Debug logging for campaign troubleshooting
    log.info(`[WhatsApp] sendTemplate -> ${templateName} to ${validPhone} | ${validatedComponents.length} components`);

    try {
      const res = await axios.post(url, payload, { headers: { Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (err) {
      this.handleError(err, url, "sendTemplate", { client, phone: validPhone });
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
      log.warn(`[WhatsApp] Template ${templateName} not synced for ${client.clientId}. Using sequential fallback. Variables: [${variables.join(', ')}]`);
      if (variables.length > 0) {
        components.push({
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: String(v).substring(0, 1024) }))
        });
      } else {
        // If no variables provided but template is not synced,
        // use empty components array. If Meta still rejects, the main catch block
        // will trigger the TEXT fallback.
        components = [];
      }
      if (headerImage) {
        components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImage } }] });
      }
    }

    // Structured diagnostics: log exact parameter counts for troubleshooting
    const bodyComp   = Array.isArray(components) ? components.find(c => c.type === 'body')   : null;
    const headerComp = Array.isArray(components) ? components.find(c => c.type === 'header') : null;
    log.info(`[WhatsApp] sendSmartTemplate -> ${templateName} | body_params=${bodyComp?.parameters?.length || 0} | has_header=${!!headerComp} | raw_vars=${variables.length}`);

    try {
      return await this.sendTemplate(client, phone, templateName, languageCode, components || []);
    } catch (err) {
      if (err.status === 404 || (err.data?.error_data?.details || "").includes("template name") || (err.message || "").includes("132001")) {
        log.warn(`[WhatsApp] Template ${templateName} failed (Missing). Falling back to TEXT for ${phone}`);
        
        // REHES (Resilient High-Entropy Sending): attempt to extract buttons/options from the flow graph if available
        let textFallback = "";
        const syncedTemplates = client.syncedMetaTemplates || [];
        const template = syncedTemplates.find(t => t.name === templateName);
        
        if (template) {
            const body = template.components?.find(c => c.type === 'BODY');
            if (body) {
                textFallback = body.text;
                variables.forEach((v, i) => {
                    textFallback = textFallback.replace(`{{${i+1}}}`, v || '-');
                });
            }
        }

        if (!textFallback) {
            textFallback = variables.length > 0 ? variables.join('\n') : "Hello! We are here to help. Pick an option below:";
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
    let token = client.whatsappToken || client.premiumAccessToken || process.env.WHATSAPP_TOKEN;
    const phoneNumberId = client.phoneNumberId || client.premiumPhoneId || process.env.WHATSAPP_PHONENUMBER_ID;

    // --- DECRYPTION FIX: Always decrypt if exists (supports plain-text fallback) ---
    if (token) {
        try {
            const decrypted = decrypt(token);
            if (decrypted) token = decrypted;  // Only replace if decryption succeeded
        } catch (err) {
            // Token is plain-text — use as-is, this is expected for legacy clients
            log.info(`[WhatsApp] Token is plain-text for ${client.clientId} (not encrypted)`);
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
  handleError(err, url, operation, context = {}) {
    const status = err.response?.status;
    const errorData = err.response?.data?.error || err.message;
    const message = errorData.message || errorData;
    const friendlyMessage = translateWhatsAppError(errorData);
    
    // Silence 404/132001 if it's a template error - it's handled by fallback
    const isTemplateMissing = status === 404 || 
                            (errorData.error_data?.details || "").includes("template name") ||
                            (message || "").includes("132001");

    if (isTemplateMissing && operation === "sendTemplate") {
       log.warn(`[WhatsApp] ${operation} failed (Expected for Fallback): ${message}`);
    } else {
       log.error(`[WhatsApp] ${operation} failed: ${message}`, {
         url,
         status,
         error: errorData
       });
    }

    this.markBlockedOptOut(context.client, context.phone, errorData).catch(() => {});

    // Re-throw standardized error
    const error = new Error(`WhatsApp API Error: ${message}`);
    error.status = status;
    error.data = errorData;
    error.friendlyMessage = friendlyMessage;
    
    // Flag token expiration for auto-healing mechanisms
    if (status === 401 || errorData.code === 190 || errorData.code === 100) {
        error.isTokenExpired = true;
    }
    
    throw error;
  },

  /**
   * Fetches the WhatsApp Business Account status
   */
  async getAccountStatus(client) {
    const { token } = this.getCredentials(client);
    const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;
    if (!wabaId) return { status: 'UNKNOWN', reason: 'Missing WABA ID' };

    const url = `https://graph.facebook.com/v21.0/${wabaId}`;
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
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}`;
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

      // --- PAYLOAD SCRUBBING (Phase 30 track 2) ---
      // Meta rejects keys starting with '_' which are used internally for dashboard previews
      // It also forbids emojis, variables, and formatting in BUTTONS titles.
      const scrubMetaRules = (text) => {
          if (!text || typeof text !== 'string') return text;
          return text
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{1F300}-\u{1F5FF}\u{1F400}-\u{1F4FF}\u{1F1E6}-\u{1F1FF}]/gu, '') // Emojis
            .replace(/[*_~`]/g, '') // Formatting
            .replace(/\{\{\d+\}\}/g, '') // Variables (forbidden in buttons)
            .replace(/\s+/g, ' ') // Extra spaces/newlines
            .trim();
      };

      const scrub = (obj, isButton = false) => {
          if (Array.isArray(obj)) return obj.map((item, idx) => scrub(item, isButton));
          if (obj !== null && typeof obj === 'object') {
              const newObj = {};
              for (const key in obj) {
                  if (key.startsWith('_')) continue;
                  
                  // Special handling for button titles
                  if (key === 'text' && obj.type === 'BUTTONS') {
                      newObj[key] = scrubMetaRules(obj[key]);
                  } else if (key === 'buttons' && obj.type === 'BUTTONS') {
                      newObj[key] = obj[key].map(btn => ({
                         ...btn,
                         text: scrubMetaRules(btn.text)
                      }));
                  } else {
                      newObj[key] = scrub(obj[key], key === 'buttons' || obj.type === 'BUTTONS');
                  }
              }
              return newObj;
          }
          return obj;
      };

      const cleanPayload = {
          name: templatePayload.name,
          category: templatePayload.category,
          language: templatePayload.language,
          components: scrub(templatePayload.components)
      };

      const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates`;
      
      log.info(`[WhatsApp] Submitting template ${cleanPayload.name} to Meta...`);
      const res = await axios.post(url, cleanPayload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      return { 
        success: true, 
        id: res.data.id, 
        status: res.data.status || 'PENDING' 
      };
      
    } catch (err) {
      const errorData = err.response?.data?.error || {};
      const subcode = errorData.error_subcode;
      
      // Error Subcode 2388024: Content already exists in this language.
      // This is a "Soft Success" — the template is already there, we just need to acknowledge it.
      if (subcode === 2388024) {
          log.info(`[WhatsApp] Template ${templatePayload.name} already exists. Considering synced.`);
          return { success: true, status: 'APPROVED', message: 'Template already exists' };
      }

      // Catch & Mock: Fail gracefully for onboarding flow UX
      log.error(`[WhatsApp] submitMetaTemplate API error (Mocking success):`, err.response?.data || err.message);
      return { 
        success: true, // we mock success to prevent flow generation crash
        status: 'PENDING_MANUAL_AUTH',
        errorBlocked: errorData.message || err.message
      };
    }
  }
};

module.exports = WhatsApp;
