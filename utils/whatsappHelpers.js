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
async function sendWhatsAppText({ phoneNumberId, to, body, token }) {
    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body }
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
async function sendWhatsAppTemplate({ phoneNumberId, to, templateName, languageCode = 'en_US', components = [], token }) {
    const apiVersion = process.env.API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const data = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: languageCode },
            components
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

module.exports = { 
    sendWhatsAppText, 
    sendWhatsAppTemplate,
    syncWhatsAppTemplates 
};
