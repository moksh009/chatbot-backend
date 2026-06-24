'use strict';

const Client = require('../../models/Client');

function hasDbPixelRegistration(client) {
  return Boolean(
    client?.shopifyWebPixelId ||
      client?.shopifyWebPixelInstalledAt ||
      client?.shopifyThemePixelInstalledAt
  );
}

/**
 * Aligns with Website Tracking tab: registration on Client wins over stale shopifyTrackingDisabled.
 */
async function resolveTrackingInstallStatus(clientId) {
  let client = await Client.findOne({ clientId })
    .select(
      'shopifyWebPixelId shopifyWebPixelInstalledAt shopifyThemePixelInstalledAt shopifyTrackingDisabled shopDomain shopifyAccessToken'
    )
    .lean();

  const hasDbRegistration = hasDbPixelRegistration(client);

  if (client?.shopifyTrackingDisabled && hasDbRegistration) {
    await Client.updateOne({ clientId }, { $set: { shopifyTrackingDisabled: false } }).catch(() => {});
    client = { ...client, shopifyTrackingDisabled: false };
  }

  let webPixelOnShopify = false;
  if (client?.shopifyAccessToken && client?.shopDomain) {
    try {
      const { getWebPixelInstallStatus } = require('../shopify/pixelInstaller');
      const api = await getWebPixelInstallStatus(clientId);
      webPixelOnShopify = api?.installed === true;
    } catch {
      webPixelOnShopify = false;
    }
  }

  const trackingInstalled = hasDbRegistration || webPixelOnShopify;

  return {
    trackingInstalled,
    hasDbRegistration,
    webPixelOnShopify,
    trackingDisabled: Boolean(client?.shopifyTrackingDisabled && !hasDbRegistration),
  };
}

module.exports = {
  hasDbPixelRegistration,
  resolveTrackingInstallStatus,
};
