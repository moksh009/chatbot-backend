/**
 * Public WhatsApp Cloud API webhook configuration (shared across all tenants).
 * Inbound routing uses metadata.phone_number_id on each event — each client stores their own ID.
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
      'Webhook URL and verify token are configured once on your Meta app. Every TopEdge workspace uses the same callback; we route each message by Phone Number ID saved in your settings.',
  };
}

module.exports = {
  inferWebhookOrigin,
  getMasterVerifyToken,
  getWhatsAppWebhookPublicConfig,
};
