'use strict';

const Client = require('../../models/Client');
const {
  themeHasOptInScript,
  injectOptInScriptIntoLiquid,
} = require('./optInThemeInject');

const THEME_LIQUID_KEY = 'layout/theme.liquid';

const THEME_FILES_UPSERT_MUTATION = `
mutation themeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    upsertedThemeFiles { filename }
    userErrors { field message }
  }
}`;

function resolveBackendUrl(backendUrl) {
  return backendUrl || process.env.BACKEND_URL || process.env.SERVER_URL || 'https://api.topedgeai.com';
}

function pickMainTheme(themes = []) {
  if (!themes.length) return null;
  return (
    themes.find((t) => t.role === 'main') ||
    themes.find((t) => t.role === 'live') ||
    themes[0]
  );
}

function toThemeGid(themeId) {
  return `gid://shopify/OnlineStoreTheme/${themeId}`;
}

function formatOptInThemeInjectError(err) {
  const status = err?.response?.status;
  const shopifyErrors = err?.response?.data?.errors;
  const detail =
    typeof shopifyErrors === 'string'
      ? shopifyErrors
      : Array.isArray(shopifyErrors)
        ? shopifyErrors.join(', ')
        : err?.message || 'Unknown Shopify error';

  if (err?.code === 'NO_MAIN_THEME') {
    return {
      success: false,
      code: 'NO_MAIN_THEME',
      message:
        'No live Shopify theme found. In Shopify admin, open Online Store → Themes and publish a live theme, then try again.',
    };
  }

  if (err?.code === 'NO_THEME_LIQUID') {
    return {
      success: false,
      code: 'NO_THEME_LIQUID',
      message:
        'Your storefront theme is missing layout/theme.liquid. Contact TopEdge support if you use a headless storefront.',
    };
  }

  if (status === 403 || /access denied|scope|permission|write_themes/i.test(detail)) {
    return {
      success: false,
      code: 'SHOPIFY_SCOPE',
      message:
        'TopEdge needs write_themes permission to install opt-in tools. Open Settings → Connections, disconnect Shopify, and reconnect to grant theme access.',
    };
  }

  if (status === 404) {
    return {
      success: false,
      code: 'THEME_NOT_WRITABLE',
      message:
        'Could not update your live Shopify theme. In Shopify admin, open Online Store → Themes, make sure a theme is published as live, then try publishing again. If it still fails, reconnect Shopify in TopEdge Settings.',
    };
  }

  if (status === 401 || err?.isShopifyAuthError) {
    return {
      success: false,
      code: 'SHOPIFY_AUTH',
      message:
        err?.message ||
        'Shopify session expired — reconnect your store in Settings → Connections.',
    };
  }

  return {
    success: false,
    code: 'THEME_INJECT_FAILED',
    message: `Store theme install failed: ${detail}`,
  };
}

async function listMainTheme(shop) {
  const themesRes = await shop.get('/themes.json');
  const mainTheme = pickMainTheme(themesRes.data.themes || []);
  if (!mainTheme) {
    const err = new Error('Main theme not found');
    err.code = 'NO_MAIN_THEME';
    throw err;
  }
  return mainTheme;
}

async function readThemeLiquid(shop, themeId) {
  const assetRes = await shop.get(`/themes/${themeId}/assets.json`, {
    params: { 'asset[key]': THEME_LIQUID_KEY },
  });
  const liquid = assetRes.data.asset?.value;
  if (!liquid) {
    const err = new Error('Could not read theme.liquid');
    err.code = 'NO_THEME_LIQUID';
    throw err;
  }
  return liquid;
}

async function putThemeLiquidRest(shop, themeId, liquid) {
  await shop.put(`/themes/${themeId}/assets.json`, {
    asset: { key: THEME_LIQUID_KEY, value: liquid },
  });
}

async function putThemeLiquidGraphQL(clientId, themeId, liquid) {
  const { withShopifyGraphQL } = require('../shopify/shopifyHelper');
  const data = await withShopifyGraphQL(clientId, THEME_FILES_UPSERT_MUTATION, {
    themeId: toThemeGid(themeId),
    files: [
      {
        filename: THEME_LIQUID_KEY,
        body: { type: 'TEXT', value: liquid },
      },
    ],
  });

  const payload = data?.themeFilesUpsert;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map((u) => u.message).join('; ');
    const err = new Error(msg);
    err.response = { status: 422, data: { errors: msg } };
    throw err;
  }
  if (!payload?.upsertedThemeFiles?.length) {
    throw new Error('GraphQL themeFilesUpsert returned no files');
  }
}

async function writeThemeLiquidWithFallback(clientId, shop, themeId, liquid, putErr) {
  if (putErr?.response?.status !== 404) throw putErr;

  let refreshedTheme = themeId;
  try {
    const mainTheme = await listMainTheme(shop);
    refreshedTheme = mainTheme.id;
    await putThemeLiquidRest(shop, refreshedTheme, liquid);
    return { themeId: refreshedTheme, method: 'rest_retry' };
  } catch (retryErr) {
    if (retryErr?.response?.status !== 404) throw retryErr;
  }

  const mainTheme = await listMainTheme(shop);
  await putThemeLiquidGraphQL(clientId, mainTheme.id, liquid);
  return { themeId: mainTheme.id, method: 'graphql' };
}

/**
 * Inject opt-in loader into the merchant's live theme.liquid.
 * Never throws for expected Shopify API failures — returns { success: false, code, message }.
 */
async function injectOptInThemeEmbed(clientId, shop, { backendUrl, embedKey }) {
  const client = await Client.findOne({ clientId }).select('growthEmbedPublicKey');
  const key = embedKey || client?.growthEmbedPublicKey;
  if (!key) {
    return {
      success: false,
      code: 'MISSING_EMBED_KEY',
      message: 'growthEmbedPublicKey missing — create an opt-in tool first',
    };
  }

  const finalBackendUrl = resolveBackendUrl(backendUrl);

  let mainTheme;
  let liquid;
  try {
    mainTheme = await listMainTheme(shop);
    liquid = await readThemeLiquid(shop, mainTheme.id);
  } catch (err) {
    return formatOptInThemeInjectError(err);
  }

  if (themeHasOptInScript(liquid, clientId)) {
    return {
      success: true,
      message: 'Opt-in script already injected',
      alreadyPresent: true,
      themeId: mainTheme.id,
    };
  }

  const { liquid: nextLiquid } = injectOptInScriptIntoLiquid(
    liquid,
    finalBackendUrl,
    key,
    clientId
  );

  try {
    await putThemeLiquidRest(shop, mainTheme.id, nextLiquid);
    return {
      success: true,
      message: 'Opt-in script injected',
      alreadyPresent: false,
      themeId: mainTheme.id,
      method: 'rest',
    };
  } catch (putErr) {
    try {
      const written = await writeThemeLiquidWithFallback(
        clientId,
        shop,
        mainTheme.id,
        nextLiquid,
        putErr
      );
      return {
        success: true,
        message:
          written.method === 'graphql'
            ? 'Opt-in script injected via GraphQL'
            : 'Opt-in script injected',
        alreadyPresent: false,
        themeId: written.themeId,
        method: written.method,
      };
    } catch (fallbackErr) {
      console.warn('[optInThemePublish] theme inject failed', {
        clientId,
        themeId: mainTheme.id,
        rest: putErr.message,
        fallback: fallbackErr.message,
      });
      return formatOptInThemeInjectError(fallbackErr.response ? fallbackErr : putErr);
    }
  }
}

module.exports = {
  THEME_LIQUID_KEY,
  formatOptInThemeInjectError,
  injectOptInThemeEmbed,
  pickMainTheme,
};
