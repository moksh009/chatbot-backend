'use strict';

const Client = require('../../models/Client');
const { executeGraphQL } = require('./shopifyGraphQL');
const { generateWebPixelScript } = require('../commerce/pixelEventProcessor');
const log = require('../core/logger')('PixelInstaller');
const { hasPixelScopes: tokenHasPixelScopes } = require('./shopifyScopeUtils');

const WEB_PIXEL_CREATE = `
  mutation WebPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      userErrors { field message code }
      webPixel { id settings }
    }
  }
`;

const WEB_PIXEL_UPDATE = `
  mutation WebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      userErrors { field message code }
      webPixel { id settings }
    }
  }
`;

const WEB_PIXEL_QUERY = `
  query TopEdgeWebPixelStatus {
    webPixel {
      id
      settings
    }
  }
`;

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function throwOnUserErrors(payload, label) {
  const errors = payload?.userErrors || [];
  if (errors.length) {
    const msg = errors.map((e) => e.message).join('; ');
    const err = new Error(`${label}: ${msg}`);
    err.code = errors[0]?.code || 'WEB_PIXEL_ERROR';
    err.userErrors = errors;
    throw err;
  }
}

function buildSettings(clientId, apiBaseUrl) {
  const payload = {
    clientId: String(clientId),
    apiBaseUrl: String(apiBaseUrl).replace(/\/+$/, ''),
  };
  /** GraphQL WebPixelInput.settings is a JSON scalar string on Shopify Admin API */
  return JSON.stringify(payload);
}

function parseSettingsObject(raw) {
  const parsed = parseSettings(raw);
  if (typeof parsed === 'string') {
    try {
      return JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  return parsed;
}

function resolveApiBaseUrl(options = {}) {
  return (
    options.apiBaseUrl ||
    process.env.BACKEND_URL ||
    process.env.SERVER_URL ||
    ''
  ).replace(/\/+$/, '');
}

/**
 * Shopify API registration status (not live event traffic).
 */
async function getWebPixelInstallStatus(clientId) {
  const client = await Client.findOne({ clientId })
    .select(
      'clientId shopDomain shopifyAccessToken shopifyConnectionStatus shopifyWebPixelId shopifyScopes'
    )
    .lean();

  if (!client?.shopifyAccessToken || !client.shopDomain) {
    return { installed: false, reason: 'shopify_not_connected', apiConnected: false };
  }

  const hasPixelScopes = tokenHasPixelScopes(client.shopifyScopes);

  try {
    const data = await executeGraphQL(clientId, WEB_PIXEL_QUERY);
    const pixel = data?.webPixel;
    if (!pixel?.id) {
      return {
        installed: false,
        reason: 'not_registered',
        apiConnected: true,
        hasPixelScopes,
        storedWebPixelId: client.shopifyWebPixelId || null,
      };
    }
    const settings = parseSettingsObject(pixel.settings);
    return {
      installed: true,
      webPixelId: pixel.id,
      settings,
      matchesClient: settings.clientId === clientId,
      apiConnected: true,
      hasPixelScopes,
      storedWebPixelId: client.shopifyWebPixelId || pixel.id,
    };
  } catch (e) {
    const msg = String(e.message || '');
    if (/access denied|read_pixels|write_pixels|read_customer_events|ACCESS_DENIED/i.test(msg)) {
      return {
        installed: false,
        reason: hasPixelScopes ? 'api_error' : 'missing_pixel_scopes',
        apiConnected: true,
        hasPixelScopes,
        message: hasPixelScopes
          ? msg
          : 'Token is missing read_pixels/write_pixels/read_customer_events — reconnect the store from Settings.',
      };
    }
    throw e;
  }
}

/**
 * Idempotent: create or update the app's web pixel with TopEdge settings.
 */
async function installWebPixel(clientId, options = {}) {
  const apiBaseUrl = resolveApiBaseUrl(options);
  if (!apiBaseUrl) {
    throw new Error('BACKEND_URL or SERVER_URL is required for pixel install');
  }

  const client = await Client.findOne({ clientId });
  if (!client?.shopifyAccessToken || !client.shopDomain) {
    return { success: false, reason: 'shopify_not_connected' };
  }

  const settings = buildSettings(clientId, apiBaseUrl);
  const variables = { webPixel: { settings } };
  const settingsObj = parseSettingsObject(settings);
  const existing = await getWebPixelInstallStatus(clientId);

  if (existing.reason === 'missing_pixel_scopes') {
    return {
      success: false,
      reason: 'missing_pixel_scopes',
      message:
        'This store token is missing pixel scopes (read_pixels/write_pixels/read_customer_events). Disconnect and reconnect Shopify from Settings so the app can register checkout capture.',
    };
  }
  if (existing.reason === 'api_error') {
    return {
      success: false,
      reason: 'api_error',
      message: existing.message || 'Shopify API error while registering the web pixel.',
    };
  }

  let data;
  let action;
  let pixel;

  const pixelId = existing.webPixelId || client.shopifyWebPixelId;

  if (pixelId) {
    data = await executeGraphQL(clientId, WEB_PIXEL_UPDATE, {
      id: pixelId,
      ...variables,
    });
    throwOnUserErrors(data?.webPixelUpdate, 'webPixelUpdate');
    pixel = data.webPixelUpdate.webPixel;
    action = 'updated';
  } else {
    try {
      data = await executeGraphQL(clientId, WEB_PIXEL_CREATE, variables);
      throwOnUserErrors(data?.webPixelCreate, 'webPixelCreate');
      pixel = data.webPixelCreate.webPixel;
      action = 'created';
    } catch (createErr) {
      if (/already|exists|taken/i.test(createErr.message)) {
        const retry = await getWebPixelInstallStatus(clientId);
        if (retry.webPixelId) {
          data = await executeGraphQL(clientId, WEB_PIXEL_UPDATE, {
            id: retry.webPixelId,
            ...variables,
          });
          throwOnUserErrors(data?.webPixelUpdate, 'webPixelUpdate');
          pixel = data.webPixelUpdate.webPixel;
          action = 'updated';
        } else {
          throw createErr;
        }
      } else {
        throw createErr;
      }
    }
  }

  await Client.updateOne(
    { clientId },
    {
      $set: {
        shopifyWebPixelId: pixel.id,
        shopifyWebPixelInstalledAt: new Date(),
        shopifyWebPixelSettings: settingsObj,
      },
    }
  );

  log.info(`[PixelInstaller] ${action} web pixel ${pixel.id} for ${clientId}`);

  return {
    success: true,
    action,
    webPixelId: pixel.id,
    settings: parseSettingsObject(pixel.settings),
    manualSnippet: generateWebPixelScript(clientId, apiBaseUrl),
    pollHint: 'Complete a test checkout contact step to confirm live events.',
  };
}

module.exports = {
  installWebPixel,
  getWebPixelInstallStatus,
  buildSettings,
  parseSettings,
  parseSettingsObject,
};
