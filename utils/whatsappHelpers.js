const axios = require('axios');

/**
 * Sends a plain text WhatsApp message via the Cloud API.
 * Standalone helper (no socket.io dependencies) suitable for cron/background jobs.
 * 
 * @param {Object} params
 * @param {string} params.phoneNumberId - WhatsApp Phone Number ID
 * @param {string} params.to - Recipient phone number (with country code, no '+')
 * @param {string} params.body - Text message body
 * @param {string} params.token - WhatsApp Cloud API Bearer token
 */
async function sendWhatsAppText({ phoneNumberId, to, body, token, clientId }) {
    let finalBody = body;
    if (clientId) {
        const { resolveFlowVariables } = require('./variableInjector');
        finalBody = await resolveFlowVariables(body, clientId, to);
    }

    const { GRAPH_API_VERSION } = require('./metaConfig');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: finalBody }
    };
    try {
        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
        return { success: true, data: response.data };
    } catch (err) {
        console.error('Error sending WhatsApp text:', err.response?.data || err.message);
        return { success: false, error: err.response?.data || err.message };
    }
}

/**
 * Sends a WhatsApp template message via the Cloud API.
 * 
 * @param {Object} params
 * @param {string} params.phoneNumberId
 * @param {string} params.to
 * @param {string} params.templateName
 * @param {string} params.languageCode
 * @param {Array} params.components
 * @param {string} params.token
 */
async function sendWhatsAppTemplate({ phoneNumberId, to, templateName, languageCode = 'en_US', components = [], token, clientId }) {
    let finalComponents = components;
    if (clientId) {
        const { resolveFlowVariables } = require('./variableInjector');
        finalComponents = await resolveFlowVariables(components, clientId, to);
    }

    const { GRAPH_API_VERSION } = require('./metaConfig');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: languageCode },
            components: finalComponents
        }
    };
    try {
        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
        return { success: true, data: response.data };
    } catch (err) {
        console.error('Error sending WhatsApp template:', err.response?.data || err.message);
        return { success: false, error: err.response?.data || err.message };
    }
}

/**
 * Sends a WhatsApp interactive message (list or buttons) via the Cloud API.
 * Used by CSAT cron and other scheduled interactive payloads.
 */
async function sendWhatsAppInteractive({ phoneNumberId, to, content, token, clientId }) {
    const { GRAPH_API_VERSION } = require('./metaConfig');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

    let bodyText = content?.body?.text || '';
    if (clientId && bodyText) {
        const { resolveFlowVariables } = require('./variableInjector');
        bodyText = await resolveFlowVariables(bodyText, clientId, to);
    }

    const interactive = {
        type: content?.type || 'list',
        action: content?.action,
    };
    if (content?.header) interactive.header = content.header;
    if (content?.footer) interactive.footer = content.footer;

    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            ...interactive,
            body: { text: String(bodyText).substring(0, 1024) },
        },
    };

    try {
        const response = await axios.post(url, data, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
        });
        return { success: true, data: response.data };
    } catch (err) {
        console.error('Error sending WhatsApp interactive:', err.response?.data || err.message);
        return { success: false, error: err.response?.data || err.message };
    }
}

/**
 * Fetches approved templates from Meta WABA.
 * 
 * @param {Object} params
 * @param {string} params.wabaId
 * @param {string} params.token
 */
async function syncWhatsAppTemplates({ wabaId, token }) {
    if (!wabaId || !token) return { success: false, error: 'Missing WABA ID or Token' };
    const { GRAPH_API_VERSION } = require('./metaConfig');
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?limit=500`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return { success: true, templates: response.data.data };
    } catch (err) {
        console.error('Error syncing WhatsApp templates:', err.response?.data || err.message);
        return { success: false, error: err.response?.data || err.message };
    }
}

module.exports = {
    sendWhatsAppText,
    sendWhatsAppTemplate,
    sendWhatsAppInteractive,
    syncWhatsAppTemplates,
};
