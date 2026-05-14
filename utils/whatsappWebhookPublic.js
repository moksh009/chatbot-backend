/**
 * Public WhatsApp Cloud API webhook base URL (for legacy single-app installs).
 * Per-tenant webhooks use `/api/client/:clientId/webhook` + per-client verifyToken in MongoDB.
 */

function inferWebhookOrigin() {
  const raw =
    process.env.PUBLIC_WEBHOOK_BASE_URL ||
    process.env.SERVER_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    '';
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (trimmed) return trimmed;
  return 'https://chatbot-backend-lg5y.onrender.com';
}

function getMasterVerifyToken() {
  return (
    process.env.VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    'my_verify_token'
  );
}

/**
 * @returns {{
 *   origin: string,
 *   callbackUrlPrimary: string,
 *   callbackUrlAlternate: string,
 *   verifyToken: string,
 *   metaAppSecretConfigured: boolean,
 *   recommendedWebhookFields: string[],
 *   multiTenantNote: string
 * }}
 */
function getWhatsAppWebhookPublicConfig() {
  const origin = inferWebhookOrigin();
  return {
    origin,
    callbackUrlPrimary: `${origin}/`,
    callbackUrlAlternate: `${origin}/whatsapp-webhook`,
    verifyToken: getMasterVerifyToken(),
    metaAppSecretConfigured: Boolean(process.env.META_APP_SECRET),
    recommendedWebhookFields: ['messages', 'message_template_status_update'],
    multiTenantNote:
      'Prefer per-workspace URLs (/api/client/{clientId}/webhook) and tokens stored in the database. The root URLs below are optional legacy when one Meta app serves every tenant and META_APP_SECRET matches that app.',
  };
}

module.exports = {
  inferWebhookOrigin,
  getMasterVerifyToken,
  getWhatsAppWebhookPublicConfig,
};
