"use strict";

const WhatsApp = require('./whatsapp');
const { sendEmail } = require('./emailService');
const log = require('./logger')('NotificationService');

/**
 * NotificationService
 * Handles high-priority admin alerts triggered by flows or system events.
 */
const NotificationService = {
  /**
   * Dispatches an alert to the configured admin channels.
   * 
   * @param {Object} client - The Client document
   * @param {Object} params - { customerPhone, topic, triggerSource, channel }
   * @returns {Promise<Object>} - Status of dispatch
   */
  async sendAdminAlert(client, { customerPhone, topic, triggerSource, channel = 'both' }) {
    const adminEmails = (client.adminAlertEmail || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
    const adminWhatsapps = (client.adminAlertWhatsapp || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
    
    // Construct the Deep Link for Takeover
    const baseUrl = process.env.DASHBOARD_URL || 'https://whatsappchatbot-6u7a.onrender.com';
    const takeoverLink = `${baseUrl}/conversations/${customerPhone}`;
    
    const results = { whatsapp: [], email: [] };

    // 1. Parallel WhatsApp Alerts
    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length > 0) {
      await Promise.all(adminWhatsapps.map(async (number) => {
        try {
          log.info(`Sending WhatsApp Admin Alert to ${number}`);
          const res = await WhatsApp.sendTemplate(
            client, 
            number, 
            'admin_notification_v1', 
            'en',
            [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: topic || 'New Request' },
                  { type: 'text', text: triggerSource || 'Manual Trigger' }
                ]
              },
              {
                type: 'button', sub_type: 'url', index: '0',
                parameters: [{ type: 'text', text: customerPhone }]
              }
            ]
          );
          results.whatsapp.push({ number, status: 'success', res });
        } catch (err) {
          log.error(`WhatsApp Admin Alert failed for ${number}, falling back to text`, { error: err.message });
          try {
             const textBody = `🚨 *Admin Alert*\n\n*Topic:* ${topic}\n*Triggered by:* ${triggerSource}\n*Customer:* ${customerPhone}\n\n👉 *Takeover Chat:* ${takeoverLink}`;
             const res = await WhatsApp.sendText(client, number, textBody);
             results.whatsapp.push({ number, status: 'success_fallback', res });
          } catch (fallbackErr) {
             log.error(`WhatsApp Fallback failed for ${number}`, { error: fallbackErr.message });
             results.whatsapp.push({ number, status: 'failed', error: fallbackErr.message });
          }
        }
      }));
    }

    // 2. Parallel Email Alerts
    if ((channel === 'email' || channel === 'both') && adminEmails.length > 0) {
      await Promise.all(adminEmails.map(async (email) => {
        try {
          log.info(`Sending Email Admin Alert to ${email}`);
          
          const html = `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 32px; border: 1px solid #e2e8f0; border-radius: 24px; background: #ffffff;">
              <div style="margin-bottom: 24px;">
                <span style="background: #fee2e2; color: #dc2626; padding: 6px 12px; border-radius: 8px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">Direct Intervention Required</span>
              </div>
              
              <h2 style="color: #0f172a; font-size: 24px; font-weight: 800; margin-bottom: 8px;">System Alert: ${topic || 'Priority Support'}</h2>
              <p style="color: #64748b; font-size: 14px; margin-bottom: 32px;">An automation flow has triggered an admin notification for a customer interaction.</p>
              
              <div style="background: #f8fafc; padding: 24px; border-radius: 16px; margin-bottom: 32px; border: 1px solid #f1f5f9;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Topic</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600; text-align: right;">${topic || 'System Signal'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Source</td>
                    <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600; text-align: right;">${triggerSource || 'Node Trigger'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Customer</td>
                    <td style="padding: 8px 0; color: #6366f1; font-size: 14px; font-weight: 700; text-align: right;">${customerPhone}</td>
                  </tr>
                </table>
              </div>
              
              <a href="${takeoverLink}" style="display: block; text-align: center; padding: 16px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 16px; font-weight: 700; font-size: 14px;">
                Takeover Conversation →
              </a>
            </div>
          `;
          
          const res = await sendEmail(client, {
            to: email,
            subject: `🚨 Admin Alert: ${topic || 'Attention Required'} — ${customerPhone}`,
            html
          });
          results.email.push({ email, status: 'success', res });
        } catch (err) {
          log.error(`Email Admin Alert failed for ${email}`, { error: err.message });
          results.email.push({ email, status: 'failed', error: err.message });
        }
      }));
    }

    return results;
  }

    return results;
  }
};

module.exports = NotificationService;
