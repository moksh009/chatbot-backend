'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const { buildTrackingHealth } = require('../commerce/trackingHealth');

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

const GOKWIK_APP_HINTS = ['gokwik', 'go-kwik', 'gokwik-checkout'];
const RAZORPAY_MAGIC_HINTS = ['razorpay', 'magic-checkout', 'razorpay-magic'];
const SHIPROCKET_HINTS = ['shiprocket', 'shiprocket-checkout', 'fastrr'];

function readCache(clientId) {
  const hit = cache.get(clientId);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(clientId);
    return null;
  }
  return hit.data;
}

function writeCache(clientId, data) {
  cache.set(clientId, { at: Date.now(), data });
}

function effectiveCheckout(ctx, client) {
  const manual = ctx?.manualOverrides?.thirdPartyCheckout;
  if (manual) return manual;
  const declared = ctx?.thirdPartyCheckout;
  if (declared && declared !== 'unknown' && declared !== 'not_sure') return declared;
  return 'unknown';
}

function effectivePlatform(ctx, client) {
  const manual = ctx?.manualOverrides?.storePlatform;
  if (manual) return manual;
  if (client.shopifyAccessToken && client.shopDomain) return 'shopify';
  if (ctx?.storePlatform === 'shopify') return 'shopify';
  return 'none';
}

async function probeShopifyCheckoutApps(client) {
  if (!client.shopifyAccessToken || !client.shopDomain) return null;
  try {
    const { withShopifyRetry } = require('../shopify/shopifyHelper');
    const appsRes = await withShopifyRetry(client.clientId, async (shop) => {
      try {
        return await shop.get('/application_charges.json');
      } catch {
        return null;
      }
    });
    if (!appsRes) return null;
  } catch {
    /* app list probe optional — merchant declaration is primary */
  }

  const domain = String(client.shopDomain || '').toLowerCase();
  const vars = client.platformVars || {};
  const hints = [
    String(vars.checkoutProvider || ''),
    String(vars.gokwikEnabled || ''),
    String(vars.razorpayMagic || ''),
  ]
    .join(' ')
    .toLowerCase();

  const blob = `${domain} ${hints}`;
  if (GOKWIK_APP_HINTS.some((h) => blob.includes(h))) return { detected: 'gokwik', signal: 'shopify_app_list' };
  if (RAZORPAY_MAGIC_HINTS.some((h) => blob.includes(h))) {
    return { detected: 'razorpay_magic', signal: 'shopify_app_list' };
  }
  if (SHIPROCKET_HINTS.some((h) => blob.includes(h))) {
    return { detected: 'shiprocket', signal: 'shopify_app_list' };
  }
  return null;
}

function webhookHistorySignal(ctx) {
  const ints = ctx?.integrations || {};
  const providers = [
    ['gokwik', ints.gokwik?.lastWebhookAt],
    ['razorpay_magic', ints.razorpay_magic?.lastWebhookAt],
    ['shiprocket', ints.shiprocket_checkout?.lastWebhookAt],
    ['other_third_party', ints.generic?.lastWebhookAt],
  ];
  for (const [id, at] of providers) {
    if (at && moment(at).isAfter(moment().subtract(30, 'days'))) {
      return { detected: id === 'shiprocket' ? 'shiprocket' : id, signal: 'webhook_history' };
    }
  }
  return null;
}

/**
 * Build Shopify-focused stack context for adaptive Sources UI.
 */
async function buildStackContext(clientId) {
  const cached = readCache(clientId);
  if (cached) return cached;

  const client = await Client.findOne({ clientId })
    .select(
      'clientId shopDomain shopifyAccessToken shopifyConnected phoneNumber wabaAccounts platformVars audienceContext growthWidgetConfig'
    )
    .lean();
  if (!client) return null;

  const ctx = client.audienceContext || {};
  const shopifyConnected = !!(client.shopifyAccessToken && client.shopDomain);

  let tracking = null;
  try {
    tracking = await buildTrackingHealth(clientId, 7);
  } catch {
    tracking = null;
  }

  const themeAccess = shopifyConnected;
  const checkoutExtensibility = !!(tracking?.webPixelInstalled || tracking?.storefrontActive);
  const appBlockSupport = shopifyConnected;

  let thirdParty = effectiveCheckout(ctx, client);
  let signal = ctx.checkoutSignal || null;

  if (thirdParty === 'unknown' || thirdParty === 'not_sure') {
    const fromWebhook = webhookHistorySignal(ctx);
    if (fromWebhook) {
      thirdParty = fromWebhook.detected;
      signal = fromWebhook.signal;
    } else if (shopifyConnected) {
      const fromApps = await probeShopifyCheckoutApps(client);
      if (fromApps) {
        thirdParty = fromApps.detected;
        signal = fromApps.signal;
      } else if (checkoutExtensibility) {
        thirdParty = 'shopify_native';
        signal = 'merchant_declared';
      }
    }
  } else {
    signal = signal || 'merchant_declared';
  }

  const waConnected =
    Boolean(client.phoneNumber) ||
    Boolean(client.wabaAccounts?.length) ||
    Boolean(client.platformVars?.adminWhatsappNumber);

  const waba = client.wabaAccounts?.[0] || {};

  const payload = {
    storePlatform: effectivePlatform(ctx, client),
    shopifyDetails: shopifyConnected
      ? {
          connected: true,
          themeAccess,
          checkoutExtensibility,
          appBlockSupport,
          shopDomain: client.shopDomain,
        }
      : null,
    thirdPartyCheckout: {
      detected: thirdParty,
      signal,
    },
    whatsapp: {
      connected: waConnected,
      wabaId: waba.wabaId || client.platformVars?.wabaId || null,
      phoneNumberId: waba.phoneNumberId || client.phoneNumberId || null,
    },
    websiteDomain: client.shopDomain || null,
    installMethod:
      shopifyConnected && themeAccess ? 'shopify_theme_auto' : shopifyConnected ? 'shopify_theme_manual' : 'none',
    manualOverrides: ctx.manualOverrides || {},
    audienceContext: ctx,
  };

  writeCache(clientId, payload);
  return payload;
}

function invalidateStackContextCache(clientId) {
  cache.delete(clientId);
}

module.exports = {
  buildStackContext,
  invalidateStackContextCache,
  effectiveCheckout,
  effectivePlatform,
};
