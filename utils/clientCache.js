/**
 * Short-TTL in-process cache for Client documents.
 * Reduces duplicate Client.findOne under dashboard + webhook burst load.
 * Invalidate on any Client mutation (tokens, settings, integrations).
 */
const NodeCache = require('node-cache');
const Client = require('../models/Client');
const { dedupeAsync } = require('./requestDedupe');

const DEFAULT_SELECT = '-visualFlows -flowNodes -flowEdges';
/** Webhook / inbound engine — skip multi-MB knowledge blobs; graphs load via flowGraphCache. */
const WHATSAPP_INBOUND_SELECT =
  '-visualFlows -flowNodes -flowEdges -knowledgeBase -pendingKnowledge';
/** Minimal fields for agent send + translation (avoids loading multi-MB client docs). */
const WHATSAPP_SEND_SELECT =
  'clientId phoneNumberId whatsappToken premiumAccessToken premiumPhoneId whatsapp translationConfig geminiApiKey config';
/** Connection flags for workspace + ConnectionContext */
const CONNECTION_STATUS_SELECT =
  'shopDomain shopifyAccessToken commerce phoneNumberId wabaId whatsappToken whatsapp instagramAccessToken instagramPageId social metaAdsConnected metaAdsToken metaAdAccountId';
/** Settings validation / automation health */
const VALIDATION_SELECT =
  'automationFlows syncedMetaTemplates shopDomain shopifyAccessToken whatsappToken phoneNumberId wabaId commerce';
/** Instagram connection chip */
const IG_CONNECTION_SELECT =
  'igAccessToken instagramAccessToken social igUserId igPageId instagramPageId igUsername instagramUsername';
/** Dynamic client router — commerce automation rules (avoid multi-MB Client doc). */
const COMMERCE_AUTOMATION_SELECT =
  'clientId commerceAutomations commerceAutomationVersion commerceAutomationLegacySnapshot skuAutomations nicheData syncedMetaTemplates';
/** Dynamic client router — order list only needs tenant id. */
const ORDERS_ROUTE_SELECT = 'clientId businessType';
/** Shopify hub — bot product IDs only (not full nicheData blob) */
const SHOPIFY_BOT_PRODUCTS_SELECT = 'nicheData.products shopDomain shopifyConnectionStatus lastShopifyError';
/** Pulse footer metadata */
const SHOPIFY_PULSE_META_SELECT = 'shopDomain shopifyConnectionStatus lastShopifyError';
const TTL_SEC = parseInt(process.env.CLIENT_CACHE_TTL_SEC || '30', 10) || 30;
const FIND_MAX_MS = parseInt(process.env.CLIENT_FIND_MAX_MS || '8000', 10) || 8000;

const clientCache = new NodeCache({
  stdTTL: Math.max(5, TTL_SEC),
  checkperiod: Math.max(5, Math.floor(TTL_SEC / 3)),
  useClones: false,
});

function cacheKey(clientId, selectFields) {
  return `client:${clientId}:${selectFields || DEFAULT_SELECT}`;
}

/**
 * @param {string} clientId
 * @param {string} [selectFields] Mongoose .select() string
 * @returns {Promise<object|null>}
 */
async function getCachedClient(clientId, selectFields) {
  if (!clientId) return null;
  const select = selectFields || DEFAULT_SELECT;
  const key = cacheKey(clientId, select);
  const hit = clientCache.get(key);
  if (hit !== undefined) return hit;

  return dedupeAsync(key, async () => {
    const again = clientCache.get(key);
    if (again !== undefined) return again;
    const client = await Client.findOne({ clientId })
      .select(select)
      .maxTimeMS(FIND_MAX_MS)
      .lean();
    if (client) clientCache.set(key, client);
    return client;
  });
}

/** Lean client load for outbound WhatsApp from Live Chat (POST /messages). */
function getCachedClientForWhatsAppSend(clientId) {
  return getCachedClient(clientId, WHATSAPP_SEND_SELECT);
}

/** Lean client load for WhatsApp webhooks (dualBrain inbound path). */
function getCachedClientForWhatsAppInbound(clientId) {
  return getCachedClient(clientId, WHATSAPP_INBOUND_SELECT);
}

function invalidateClientCache(clientId) {
  if (!clientId) return;
  const prefix = `client:${clientId}:`;
  const keys = clientCache.keys().filter((k) => k.startsWith(prefix));
  if (keys.length) clientCache.del(keys);
}

module.exports = {
  getCachedClient,
  getCachedClientForWhatsAppSend,
  getCachedClientForWhatsAppInbound,
  invalidateClientCache,
  DEFAULT_CLIENT_SELECT: DEFAULT_SELECT,
  WHATSAPP_INBOUND_SELECT,
  WHATSAPP_SEND_SELECT,
  CONNECTION_STATUS_SELECT,
  VALIDATION_SELECT,
  IG_CONNECTION_SELECT,
  COMMERCE_AUTOMATION_SELECT,
  ORDERS_ROUTE_SELECT,
  SHOPIFY_BOT_PRODUCTS_SELECT,
  SHOPIFY_PULSE_META_SELECT,
};
