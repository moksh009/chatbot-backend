'use strict';

const { buildConnectionStatusPayload, decryptToken, isValidShopDomain } = require('./connectionStatus');
const {
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
  getEffectiveWhatsAppWabaId,
} = require('../meta/clientWhatsAppCreds');
const {
  parseShopifyScopes,
  expandImpliedScopes,
  getShopifyAppConfiguredScopes,
  hasPixelScopes,
  buildScopeSummary,
} = require('../shopify/shopifyScopeUtils');
const MetaTemplate = require('../../models/MetaTemplate');

function tokenStatusFrom(tok, probed, clientStatusOverride) {
  // Prefer live probe over stale DB status flag
  if (probed?.tokenStatus) return probed.tokenStatus;
  if (clientStatusOverride === 'error') return 'revoked';
  if (!tok || tok.length < 6) return 'missing';
  return 'valid';
}

async function buildConnectionStatusContract(client) {
  const { getCachedOrProbe } = require('../security/connectionTokenProbe');
  if (!client) {
    return {
      whatsapp: { connected: false, phoneNumberId: null, wabaId: null, tokenStatus: 'missing', lastVerifiedAt: null, issues: ['client_not_found'] },
      instagram: { connected: false, igUserId: null, pageId: null, tokenStatus: 'missing', issues: [] },
      shopify: { connected: false, shopDomain: null, scopes: [], hasPixelScopes: false, issues: [] },
      meta: { connected: false, businessId: null, hasTemplatePermission: false, issues: [] },
      razorpay: { connected: false, mode: null, issues: [] },
      email: { connected: false, transport: null, issues: [] },
      overall: { readyForBot: false, readyForCampaigns: false, readyForCommerce: false, approvedTemplateCount: 0 },
      setupHealth: buildSetupHealth({
        whatsapp: { connected: false, tokenStatus: 'missing' },
        shopify: { connected: false, tokenStatus: 'missing', isFullyAuthorized: false, shopDomain: null },
        approvedTemplateCount: 0,
        overall: { readyForBot: false, readyForCampaigns: false, readyForCommerce: false },
      }),
      _legacy: buildConnectionStatusPayload(null),
    };
  }

  const flags = buildConnectionStatusPayload(client);
  const phoneNumberId = getEffectiveWhatsAppPhoneNumberId(client) || null;
  const wabaId = getEffectiveWhatsAppWabaId(client) || null;
  const waTok = getEffectiveWhatsAppAccessToken(client);
  const waProbe = await getCachedOrProbe(client, 'whatsapp').catch(() => null);
  const waIssues = [];
  if (!phoneNumberId) waIssues.push('missing_phone_number_id');
  if (!wabaId) waIssues.push('missing_waba_id');
  if (waTok.length < 6) waIssues.push('missing_whatsapp_token');

  const shopDomain =
    client.shopDomain || client.commerce?.shopify?.domain || client.config?.shopDomain || null;
  const shopifyTok = decryptToken(client.shopifyAccessToken || client.commerce?.shopify?.accessToken || '');
  const shopifyProbe = await getCachedOrProbe(client, 'shopify').catch(() => null);

  const igTok = decryptToken(client.instagramAccessToken || client.social?.instagram?.accessToken || '');
  const igPage = client.instagramPageId || client.social?.instagram?.pageId || null;

  let approvedTemplateCount = 0;
  try {
    approvedTemplateCount = await MetaTemplate.countDocuments({
      clientId: client.clientId,
      status: { $in: ['APPROVED', 'approved'] },
    });
  } catch (_) {
    approvedTemplateCount = (client.syncedMetaTemplates || []).filter((t) =>
      String(t.status || '').toUpperCase() === 'APPROVED'
    ).length;
  }

  const readyForBot = flags.whatsapp_connected;
  const readyForCampaigns = readyForBot && approvedTemplateCount > 0;
  const readyForCommerce = readyForCampaigns && flags.shopify_connected;

  const whatsappBlock = {
    connected: flags.whatsapp_connected,
    phoneNumberId,
    wabaId,
    tokenStatus: tokenStatusFrom(waTok, waProbe),
    lastVerifiedAt: client.whatsappLastVerifiedAt || null,
    connectionType: client.whatsappConnectionType || (flags.whatsapp_connected ? 'manual' : null),
    connectionMethod: client.whatsappConnectionMethod || null,
    displayPhoneNumber: client.whatsappDisplayPhoneNumber || null,
    coexistence: !!client.whatsappCoexistence,
    qualityRating: client.whatsappQualityRating || null,
    messagingLimit: client.whatsappMessagingLimit || null,
    webhookSubscribed: !!client.whatsappWebhookSubscribed,
    issues: waIssues,
  };

  const shopifyBlock = (() => {
    const scopeSummary = buildScopeSummary(client.shopifyScopes);
    const shopifyStatusOverride = String(client.shopifyConnectionStatus || '').toLowerCase();
    const shopifyTokenStatus = tokenStatusFrom(shopifyTok, shopifyProbe, shopifyStatusOverride);
    const issues = [];
    if (!isValidShopDomain(shopDomain)) issues.push('invalid_shop_domain');
    if (scopeSummary.missingFromGrant.length > 0) issues.push('missing_scopes');
    if (shopifyStatusOverride === 'error') issues.push('token_outdated');
    return {
      connected: flags.shopify_connected,
      shopDomain: shopDomain || null,
      tokenStatus: shopifyTokenStatus,
      scopes: scopeSummary.effectiveGranted,
      scopesRaw: client.shopifyScopes || '',
      appConfiguredScopes: getShopifyAppConfiguredScopes(),
      hasPixelScopes: scopeSummary.hasPixelScopes,
      missingScopes: scopeSummary.missingFromGrant,
      isFullyAuthorized: scopeSummary.isFullyAuthorized,
      issues,
    };
  })();

  const overall = {
    readyForBot,
    readyForCampaigns,
    readyForCommerce,
    approvedTemplateCount,
  };

  const setupHealth = buildSetupHealth({
    whatsapp: whatsappBlock,
    shopify: shopifyBlock,
    approvedTemplateCount,
    overall,
  });

  return {
    whatsapp: whatsappBlock,
    instagram: {
      connected: flags.instagram_connected,
      igUserId: client.instagramUserId || client.social?.instagram?.userId || null,
      pageId: igPage,
      tokenStatus: tokenStatusFrom(igTok, await getCachedOrProbe(client, 'instagram').catch(() => null)),
      issues: igTok.length < 6 ? ['missing_instagram_token'] : [],
    },
    shopify: shopifyBlock,
    meta: {
      connected: flags.meta_connected,
      businessId: client.metaBusinessId || client.metaAdAccountId || null,
      hasTemplatePermission: flags.meta_connected,
      issues: [],
    },
    razorpay: {
      connected: !!(client.razorpayKeyId || client.razorpayKeySecret),
      mode: client.razorpayMode || (client.razorpayKeyId?.startsWith('rzp_test') ? 'test' : 'live'),
      tokenStatus: tokenStatusFrom(
        client.razorpayKeyId,
        await getCachedOrProbe(client, 'razorpay').catch(() => null)
      ),
      issues: [],
    },
    email: {
      connected: !!(client.emailUser || client.resendApiKey || client.emailTransport),
      transport: client.resendApiKey ? 'resend' : client.emailUser ? 'gmail' : client.emailTransport || null,
      issues: [],
    },
    overall,
    setupHealth,
    _legacy: flags,
  };
}

function buildSetupHealth({ whatsapp, shopify, approvedTemplateCount, overall }) {
  const waOk = whatsapp.connected && whatsapp.tokenStatus === 'valid';
  const waStatus = waOk ? 'ok' : whatsapp.connected ? 'warn' : 'error';
  const waValue = !whatsapp.connected
    ? 'Not connected'
    : whatsapp.tokenStatus === 'valid'
      ? 'Connected'
      : 'Check token';

  const shopOk =
    shopify.connected &&
    shopify.tokenStatus === 'valid' &&
    shopify.isFullyAuthorized !== false;
  const shopStatus = shopOk ? 'ok' : shopify.connected ? 'warn' : 'error';
  const shopValue = !shopify.connected
    ? 'Not connected'
    : shopify.shopDomain || 'Connected';

  const tplStatus = approvedTemplateCount > 0 ? 'ok' : whatsapp.connected ? 'warn' : 'error';
  const tplValue =
    approvedTemplateCount > 0 ? `${approvedTemplateCount} approved` : 'None approved yet';

  const items = [
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      status: waStatus,
      value: waValue,
      href: '/settings?tab=connections&connect=whatsapp',
    },
    {
      id: 'shopify',
      label: 'Shopify',
      status: shopStatus,
      value: shopValue,
      href: '/settings?tab=connections&connect=shopify',
    },
    {
      id: 'templates',
      label: 'Templates',
      status: tplStatus,
      value: tplValue,
      href: '/meta-manager?tab=library',
    },
  ];

  let nextStep = null;
  if (!whatsapp.connected) {
    nextStep = {
      id: 'whatsapp',
      label: 'Connect WhatsApp',
      href: '/settings?tab=connections&connect=whatsapp',
    };
  } else if (!shopify.connected) {
    nextStep = {
      id: 'shopify',
      label: 'Connect Shopify',
      href: '/settings?tab=connections&connect=shopify',
    };
  } else if (approvedTemplateCount < 1) {
    nextStep = {
      id: 'templates',
      label: 'Add approved templates',
      href: '/meta-manager?tab=library',
    };
  }

  const allOk = items.every((item) => item.status === 'ok');

  return {
    approvedTemplateCount,
    items,
    nextStep,
    allOk,
    readyForBot: overall.readyForBot,
    readyForCampaigns: overall.readyForCampaigns,
    readyForCommerce: overall.readyForCommerce,
  };
}

module.exports = { buildConnectionStatusContract, buildSetupHealth };
