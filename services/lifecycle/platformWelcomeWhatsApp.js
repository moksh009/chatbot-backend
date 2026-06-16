const WhatsApp = require('../../utils/meta/whatsapp');

const DEFAULT_TEMPLATE = 'topedge_platform_welcome_utility_v1';

function getPlatformWabaConfig() {
  const phoneNumberId = String(process.env.TOPEDGE_SYSTEM_WABA_PHONE_NUMBER_ID || '').trim();
  const accessToken = String(process.env.TOPEDGE_SYSTEM_WABA_ACCESS_TOKEN || '').trim();
  const wabaId = String(process.env.TOPEDGE_SYSTEM_WABA_ID || '').trim();
  const clientId = String(process.env.TOPEDGE_SYSTEM_CLIENT_ID || 'topedge_platform').trim();
  const templateName = String(process.env.TOPEDGE_WELCOME_TEMPLATE_NAME || DEFAULT_TEMPLATE).trim();
  const supportNumber = String(process.env.TOPEDGE_SUPPORT_WHATSAPP || '').trim();
  const dashboardUrl = String(
    process.env.TOPEDGE_DASHBOARD_URL || process.env.FRONTEND_URL || 'https://dash.topedgeai.com'
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    wabaId,
    clientId,
    templateName,
    supportNumber,
    dashboardUrl,
    configured: Boolean(phoneNumberId && accessToken),
  };
}

function buildWelcomeTemplateComponents({
  merchantName,
  dashboardUrl,
  supportNumber,
}) {
  return [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(merchantName || 'there') },
        { type: 'text', text: String(dashboardUrl || 'https://dash.topedgeai.com') },
        { type: 'text', text: String(supportNumber || 'TopEdge support') },
      ],
    },
  ];
}

async function sendPlatformWelcomeWhatsApp({
  toPhone,
  merchantName,
}) {
  const cfg = getPlatformWabaConfig();
  const components = buildWelcomeTemplateComponents({
    merchantName,
    dashboardUrl: cfg.dashboardUrl,
    supportNumber: cfg.supportNumber || '+91 support',
  });
  return sendPlatformWhatsAppTemplate({
    toPhone,
    templateName: cfg.templateName,
    languageCode: 'en',
    components,
  });
}

async function sendPlatformWhatsAppTemplate({
  toPhone,
  templateName,
  languageCode = 'en',
  components = [],
}) {
  const cfg = getPlatformWabaConfig();
  if (!cfg.configured) {
    return { sent: false, skipped: true, reason: 'platform_waba_not_configured' };
  }

  const clientStub = {
    clientId: cfg.clientId,
    phoneNumberId: cfg.phoneNumberId,
    whatsappToken: cfg.accessToken,
    wabaId: cfg.wabaId || undefined,
  };

  const resp = await WhatsApp.sendTemplate(
    clientStub,
    toPhone,
    templateName,
    languageCode,
    components
  );
  return { sent: true, response: resp, templateName };
}

module.exports = {
  DEFAULT_TEMPLATE,
  getPlatformWabaConfig,
  buildWelcomeTemplateComponents,
  sendPlatformWhatsAppTemplate,
  sendPlatformWelcomeWhatsApp,
};
