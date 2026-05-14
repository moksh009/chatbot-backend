"use strict";

const WhatsApp = require('./whatsapp');
const { normalizePhone } = require('./helpers');
const { sendEmail, buildAdminEscalationEmailHtml, isWorkspaceEmailReady } = require('./emailService');
const log = require('./logger')('NotificationService');

function resolveAdminAlertChannel(client, explicitChannel) {
  if (explicitChannel === 'whatsapp' || explicitChannel === 'email' || explicitChannel === 'both') {
    return explicitChannel;
  }
  const pref = client.adminAlertPreferences;
  if (pref === 'whatsapp' || pref === 'email' || pref === 'both') return pref;
  return 'both';
}

/**
 * NotificationService
 * Handles high-priority admin alerts triggered by flows or system events.
 */
const NotificationService = {
  /**
   * Dispatches an alert to the configured admin channels.
   *
   * @param {Object} client - The Client document
   * @param {Object} params - { customerPhone, topic, triggerSource, channel?, adminPhoneOverride?, customerQuery? }
   * @returns {Promise<Object>} - Per-channel dispatch results
   */
  async sendAdminAlert(client, {
    customerPhone,
    topic,
    triggerSource,
    channel: channelParam,
    adminPhoneOverride,
    customerQuery = '',
  }) {
    const channel = resolveAdminAlertChannel(client, channelParam);

    const rawEmails = (client.adminAlertEmail || '').split(',').map((s) => s.trim()).filter(Boolean);
    const fallbackBiz = (client.adminEmail || '').split(',').map((s) => s.trim()).filter(Boolean);
    const adminEmails = [...new Set([...rawEmails, ...fallbackBiz])].slice(0, 5);

    let adminWhatsapps = (client.adminAlertWhatsapp || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (client.config?.adminPhones && Array.isArray(client.config.adminPhones)) {
      adminWhatsapps = [...new Set([...adminWhatsapps, ...client.config.adminPhones.map(String)])];
    }
    const primary = (adminPhoneOverride || client.adminPhone || '').trim();
    if (primary) {
      adminWhatsapps = [...new Set([primary, ...adminWhatsapps])];
    }
    adminWhatsapps = [...new Set(adminWhatsapps)].slice(0, 5);
    
    // Construct the Deep Link for Takeover
    const baseUrl = process.env.DASHBOARD_URL || 'https://whatsappchatbot-6u7a.onrender.com';
    const takeoverLink = `${baseUrl}/conversations/${customerPhone}`;
    
    const results = { whatsapp: [], email: [] };

    // 1. Parallel WhatsApp Alerts
    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length === 0) {
      log.warn('[sendAdminAlert] WhatsApp channel selected but no admin numbers on file');
      try {
        await NotificationService.createNotification(client, {
          type: 'system',
          title: 'Admin WhatsApp alert not delivered',
          message:
            'A customer triggered a human escalation, but no admin WhatsApp number is configured. Add Admin Phone or Admin WhatsApp Alert(s) under Settings → Alerts.',
          customerPhone,
          metadata: { topic, triggerSource },
        });
      } catch (_) { /* non-blocking */ }
    }

    if ((channel === 'whatsapp' || channel === 'both') && adminWhatsapps.length > 0) {
      const customerNorm = normalizePhone(customerPhone);
      await Promise.all(adminWhatsapps.map(async (number) => {
        const adminNorm = normalizePhone(number);
        if (customerNorm && adminNorm && adminNorm === customerNorm) {
          log.warn(
            `[sendAdminAlert] Skipping WhatsApp to ${number} — same number as customer; admin alert would appear in the customer's chat. Fix Admin Phone / Admin Alert WhatsApp in Settings.`
          );
          return;
        }
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

    const brandName =
      client.businessName || client.name || client.brand?.businessName || client.clientId || 'Your brand';

    // 2. Parallel Email Alerts (merchant SMTP or Gmail OAuth on client; sendEmail handles transport)
    if ((channel === 'email' || channel === 'both') && adminEmails.length > 0) {
      if (!isWorkspaceEmailReady(client)) {
        log.warn('Admin email alert skipped — workspace outbound email not configured');
        results.email.push({
          email: adminEmails[0],
          status: 'skipped',
          error:
            'Email not configured — connect Gmail (OAuth) or add SMTP (email + app password) under Settings → Integrations, or switch alerts to WhatsApp only.',
        });
        try {
          await NotificationService.createNotification(client, {
            type: 'system',
            title: 'Admin email alert could not send',
            message:
              'Human escalation requested email delivery but this workspace has no outbound email. Connect Gmail OAuth or configure SMTP in Settings → Integrations, or switch alerts to WhatsApp only.',
            customerPhone,
            metadata: { topic, triggerSource },
          });
        } catch (_) { /* non-blocking */ }
      } else {
        await Promise.all(adminEmails.map(async (email) => {
          try {
            log.info(`Sending Email Admin Alert to ${email}`);
            const html = buildAdminEscalationEmailHtml({
              brandName,
              topic: topic || 'Priority support',
              triggerSource: triggerSource || 'Automation flow',
              customerPhone: customerPhone || '—',
              customerQuery,
              takeoverLink,
            });
            const ok = await sendEmail(client, {
              to: email,
              subject: `🚨 ${brandName}: human help needed — ${customerPhone || 'customer'}`,
              html,
            });
            results.email.push({
              email,
              status: ok ? 'success' : 'failed',
              error: ok ? undefined : 'sendEmail returned false (check Gmail OAuth or SMTP)',
            });
            if (!ok) {
              try {
                await NotificationService.createNotification(client, {
                  type: 'system',
                  title: 'Admin alert email failed',
                  message: `Could not deliver escalation email to ${email}. Check Gmail connection or SMTP credentials and inbox limits.`,
                  customerPhone,
                  metadata: { topic, triggerSource },
                });
              } catch (_) { /* non-blocking */ }
            }
          } catch (err) {
            log.error(`Email Admin Alert failed for ${email}`, { error: err.message });
            results.email.push({ email, status: 'failed', error: err.message });
          }
        }));
      }
    } else if (channel === 'email' || channel === 'both') {
      log.warn('[sendAdminAlert] Email channel selected but no adminAlertEmail / adminEmail on file');
    }

    log.info(`Dispatching alert for ${client.clientId}`, {
      channels: channel,
      emailCount: adminEmails.length,
      whatsappCount: adminWhatsapps.length,
    });

    return results;
  },

  /**
   * Centralized Notification Creation
   * Persists a notification to the DB and emits it to the frontend via Socket.io.
   */
  async createNotification(client, { type, title, message, customerPhone, metadata = {} }) {
    try {
      const Notification = require('../models/Notification');
      const Client = require('../models/Client');
      
      const clientId = typeof client === 'string' ? client : (client.clientId || client._id);
      
      const notif = await Notification.create({
        clientId: clientId.toString(),
        type: type || 'system',
        title: title || 'New Alert',
        message: message || '',
        metadata: {
          customerPhone,
          ...metadata
        }
      });

      if (global.io) {
        global.io.to(`client_${clientId}`).emit('new_notification', notif);
      }

      return notif;
    } catch (err) {
      log.error('Failed to create internal notification', { error: err.message });
      return null;
    }
  }
};

module.exports = NotificationService;
