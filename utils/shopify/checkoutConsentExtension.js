'use strict';

const Client = require('../../models/Client');
const { executeGraphQL } = require('./shopifyGraphQL');
const log = require('../core/logger')('CheckoutConsentExtension');
const { buildScopeSummary } = require('./shopifyScopeUtils');

const CHECKOUT_CONFIG_METAFIELD = {
  namespace: 'topedge',
  key: 'checkout_consent',
  type: 'json',
};

/**
 * Push consent copy + API endpoints to the shop (app-owned metafield when possible).
 */
async function syncCheckoutConsentConfig(clientId, apiBaseUrl) {
  const client = await Client.findOne({ clientId })
    .select('clientId shopDomain shopifyAccessToken growthWidgetConfig growthEmbedPublicKey')
    .lean();
  if (!client?.shopifyAccessToken || !client.shopDomain) {
    return { success: false, reason: 'shopify_not_connected' };
  }

  const cfg = client.growthWidgetConfig || {};
  const payload = {
    clientId,
    apiBaseUrl: String(apiBaseUrl || '').replace(/\/+$/, ''),
    embedKey: client.growthEmbedPublicKey || '',
    consentText:
      cfg.consentText?.trim() ||
      `Get order updates and offers on WhatsApp from ${cfg.brandName || 'our store'}`,
    defaultChecked: cfg.checkoutConsentDefaultChecked !== false,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  let metafieldSynced = false;
  try {
    const shopGid = await resolveShopGid(clientId);
    const mutation = `
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }
    `;
    const data = await executeGraphQL(clientId, mutation, {
      metafields: [
        {
          ownerId: shopGid,
          namespace: CHECKOUT_CONFIG_METAFIELD.namespace,
          key: CHECKOUT_CONFIG_METAFIELD.key,
          type: CHECKOUT_CONFIG_METAFIELD.type,
          value: JSON.stringify(payload),
        },
      ],
    });
    const errors = data?.metafieldsSet?.userErrors || [];
    if (errors.length) {
      log.warn(`metafieldsSet: ${errors.map((e) => e.message).join('; ')}`);
    } else {
      metafieldSynced = true;
    }
  } catch (e) {
    log.warn(`Checkout consent metafield sync failed: ${e.message}`);
  }

  await Client.updateOne(
    { clientId },
    {
      $set: {
        checkoutConsentConfig: payload,
        checkoutConsentConfigSyncedAt: new Date(),
      },
    }
  );

  return { success: true, metafieldSynced, config: payload };
}

async function resolveShopGid(clientId) {
  const data = await executeGraphQL(
    clientId,
    `query { shop { id myshopifyDomain } }`
  );
  return data?.shop?.id;
}

function normalizeShopHost(shopDomain) {
  return String(shopDomain || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .toLowerCase();
}

function buildCheckoutEditorUrl(shopDomain) {
  const host = normalizeShopHost(shopDomain);
  if (!host) return null;
  const storeHandle = host.replace(/\.myshopify\.com$/i, '');
  return `https://admin.shopify.com/store/${storeHandle}/settings/checkout/editor`;
}

function buildCheckoutCustomizeAppsUrl(shopDomain) {
  const host = normalizeShopHost(shopDomain);
  if (!host) return buildCheckoutEditorUrl(shopDomain);
  return `https://${host}/admin/settings/checkout/editor?page=contact&context=apps`;
}

/**
 * Honest install status — API registration alone does NOT render checkout UI.
 */
async function getCheckoutOptInInstallStatus(clientId, options = {}) {
  const client = await Client.findOne({ clientId })
    .select(
      'clientId shopDomain shopifyAccessToken shopifyConnectionStatus shopifyThemePixelInstalledAt shopifyWebPixelId checkoutConsentConfigSyncedAt audienceContext shopifyScopes'
    )
    .lean();

  if (!client?.shopifyAccessToken || !client.shopDomain) {
    return {
      shopifyConnected: false,
      checkoutEditorUrl: null,
      checkoutCustomizeUrl: null,
      extensionDeployed: Boolean(process.env.SHOPIFY_CHECKOUT_EXTENSION_DEPLOYED === 'true'),
      webPixelRegistered: false,
      themeInjected: false,
      configSynced: false,
      checkoutBlockRequired: true,
      thirdPartyCheckout: null,
      statusHint:
        'Connect Shopify in Settings → Integrations, then deploy the TopEdge app extensions from Partners.',
      nextSteps: ['connect_shopify'],
    };
  }

  const ctx = client.audienceContext || {};
  const thirdParty =
    ctx.manualOverrides?.thirdPartyCheckout ||
    ctx.thirdPartyCheckout ||
    null;

  let webPixelApi = { installed: false };
  try {
    const { getWebPixelInstallStatus } = require('./pixelInstaller');
    webPixelApi = await getWebPixelInstallStatus(clientId);
  } catch {
    /* ignore */
  }

  const extensionReleased = process.env.SHOPIFY_CHECKOUT_EXTENSION_DEPLOYED !== 'false';
  const themeInjected = Boolean(client.shopifyThemePixelInstalledAt);
  const webPixelRegistered =
    Boolean(client.shopifyWebPixelId) || webPixelApi.installed === true;
  const configSynced = Boolean(client.checkoutConsentConfigSyncedAt);
  const scopeSummary = buildScopeSummary(client.shopifyScopes);
  const usesNativeCheckout = !thirdParty || thirdParty === 'unknown';
  const checkoutBlockRequired = usesNativeCheckout;

  const checkoutEditorUrl = buildCheckoutEditorUrl(client.shopDomain);
  const checkoutCustomizeUrl = buildCheckoutCustomizeAppsUrl(client.shopDomain);

  const nextSteps = [];
  if (!configSynced) nextSteps.push('save_consent_config');
  if (!webPixelRegistered) nextSteps.push('register_web_pixel');
  if (checkoutBlockRequired) nextSteps.push('activate_checkout_block');

  let statusHint =
    'API install does not show a checkbox by itself. After registering, open Checkout Editor and add the TopEdge app block on the Contact step, then publish.';
  if (thirdParty && thirdParty !== 'unknown') {
    statusHint = `This store uses ${thirdParty} checkout — the Shopify checkout checkbox will not appear there. Use Audience → Third-party checkout webhooks for abandons on that flow.`;
  } else if (configSynced && webPixelRegistered) {
    statusHint =
      'Registered with Shopify. Add “TopEdge WhatsApp opt-in” in Checkout Editor → Contact → Apps, then Save and Publish checkout.';
  }

  return {
    shopifyConnected: true,
    shopDomain: client.shopDomain,
    checkoutEditorUrl,
    checkoutCustomizeUrl,
    extensionDeployed: extensionReleased,
    extensionReleased,
    webPixelRegistered,
    themeInjected,
    configSynced,
    checkoutBlockRequired,
    thirdPartyCheckout: thirdParty,
    usesNativeCheckout,
    webPixelScopeMissing:
      webPixelApi.reason === 'missing_pixel_scopes' && !scopeSummary.hasPixelScopes,
    hasPixelScopes: scopeSummary.hasPixelScopes,
    grantedScopes: scopeSummary.granted,
    appConfiguredScopes: scopeSummary.appConfigured,
    missingPixelScopes: scopeSummary.missingFromGrant,
    statusHint,
    nextSteps,
    checkboxNote:
      'The WhatsApp opt-in checkbox is a Checkout UI app block. It only appears after you add it in Checkout Editor (not from API success alone).',
  };
}

async function resolveClientByShop(shopRaw) {
  const host = normalizeShopHost(shopRaw);
  if (!host) return null;
  const bare = host.replace(/\.myshopify\.com$/i, '');
  return Client.findOne({
    $or: [
      { shopDomain: host },
      { shopDomain: new RegExp(`${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') },
      { 'commerce.shopify.domain': host },
    ],
    shopifyConnectionStatus: 'connected',
  })
    .select(
      'clientId growthWidgetConfig growthEmbedPublicKey growthEmbedEnabled shopDomain checkoutConsentConfig'
    )
    .lean();
}

async function getPublicCheckoutConsentConfig(shopRaw, apiBaseUrl) {
  const client = await resolveClientByShop(shopRaw);
  if (!client) return null;

  const cfg = client.growthWidgetConfig || {};
  const stored = client.checkoutConsentConfig || {};
  const enabled = client.growthEmbedEnabled !== false;

  return {
    clientId: client.clientId,
    embedKey: client.growthEmbedPublicKey || '',
    apiBaseUrl: String(apiBaseUrl || stored.apiBaseUrl || '').replace(/\/+$/, ''),
    consentText:
      stored.consentText ||
      cfg.consentText?.trim() ||
      'Get order updates and offers on WhatsApp',
    defaultChecked:
      stored.defaultChecked !== undefined
        ? stored.defaultChecked
        : cfg.checkoutConsentDefaultChecked !== false,
    enabled,
  };
}

module.exports = {
  syncCheckoutConsentConfig,
  getCheckoutOptInInstallStatus,
  getPublicCheckoutConsentConfig,
  buildCheckoutEditorUrl,
  buildCheckoutCustomizeAppsUrl,
  resolveClientByShop,
};
