'use strict';

const { buildConnectionStatusPayload, decryptToken, isValidShopDomain } = require('./connectionStatus');
const {
  parseShopifyScopes,
  expandImpliedScopes,
  getShopifyAppConfiguredScopes,
  hasPixelScopes,
  buildScopeSummary,
} = require('../shopify/shopifyScopeUtils');
const MetaTemplate = require('../../models/MetaTemplate');

function tokenStatusFrom(tok, probed) {
  if (probed?.tokenStatus) return probed.tokenStatus;
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
      overall: { readyForBot: false, readyForCampaigns: false, readyForCommerce: false },
      _legacy: buildConnectionStatusPayload(null),
    };
  }

  const flags = buildConnectionStatusPayload(client);
  const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId || client.config?.phoneNumberId || null;
  const wabaId = client.wabaId || client.whatsapp?.wabaId || client.config?.wabaId || null;
  const waTok = decryptToken(client.whatsappToken || client.whatsapp?.accessToken || '');
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

  return {
    whatsapp: {
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
      webhookSubscribed: !!client.whatsappWebhookSubscribed,
      issues: waIssues,
    },
    instagram: {
      connected: flags.instagram_connected,
      igUserId: client.instagramUserId || client.social?.instagram?.userId || null,
      pageId: igPage,
      tokenStatus: tokenStatusFrom(igTok, await getCachedOrProbe(client, 'instagram').catch(() => null)),
      issues: igTok.length < 6 ? ['missing_instagram_token'] : [],
    },
    shopify: (() => {
      const scopeSummary = buildScopeSummary(client.shopifyScopes);
      const shopifyTokenStatus = tokenStatusFrom(shopifyTok, shopifyProbe);
      const issues = [];
      if (!isValidShopDomain(shopDomain)) issues.push('invalid_shop_domain');
      if (scopeSummary.missingFromGrant.length > 0) issues.push('missing_scopes');
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
    })(),
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
    overall: {
      readyForBot,
      readyForCampaigns,
      readyForCommerce,
    },
    _legacy: flags,
  };
}

module.exports = { buildConnectionStatusContract };
