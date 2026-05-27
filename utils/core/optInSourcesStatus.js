'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const ImportSession = require('../../models/ImportSession');
const GrowthQrScan = require('../../models/GrowthQrScan');
const { buildTrackingHealth } = require('../commerce/trackingHealth');
const { buildGrowthEmbedOverview } = require('./growthEmbedOverview');

const MONTH_START = () => moment().startOf('month').toDate();
const DAYS_30 = () => moment().subtract(30, 'days').toDate();

async function countOptIns(clientId, sourceMatch, since = null) {
  const match = { clientId, optStatus: 'opted_in' };
  if (sourceMatch) match.optInSource = sourceMatch;
  if (since) match.optInDate = { $gte: since };
  return AdLead.countDocuments(match);
}

async function buildOptInSourcesStatus(clientId) {
  const monthStart = MONTH_START();
  const since30 = DAYS_30();

  const client = await Client.findOne({ clientId })
    .select(
      'growthEmbedEnabled growthEmbedPublicKey growthWidgetConfig shopifyDomain shopifyConnected shopifyAccessToken phoneNumber wabaAccounts platformVars audienceContext'
    )
    .lean();
  if (!client) return null;

  const thirdPartyMatch = { $regex: /^(gokwik|razorpay|shiprocket|third_party)/i };

  const thankYouSourceMatch = { $regex: /thank_you/i };

  const [tracking, overview, checkoutMonth, checkoutTotal, thirdPartyMonth, thirdPartyTotal, keywordMonth, keywordTotal, importMonth, importTotal, qrMonth, qrTotal, shopifyStats, recentCheckout, recentThirdParty, recentWidget, recentKeyword, importSessions, qrBySource, thankYouTotal, popupTotal] =
    await Promise.all([
      buildTrackingHealth(clientId, 30).catch(() => null),
      buildGrowthEmbedOverview(clientId, '30d').catch(() => null),
      countOptIns(clientId, { $regex: /^checkout/i }, monthStart),
      countOptIns(clientId, { $regex: /^checkout/i }),
      countOptIns(clientId, thirdPartyMatch, monthStart),
      countOptIns(clientId, thirdPartyMatch),
      countOptIns(clientId, 'keyword', monthStart),
      countOptIns(clientId, 'keyword'),
      countOptIns(clientId, /^csv_import/i, monthStart),
      countOptIns(clientId, /^csv_import/i),
      countOptIns(clientId, { $regex: /^qr/i }, monthStart),
      countOptIns(clientId, { $regex: /^qr/i }),
      AdLead.aggregate([
        { $match: { clientId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            optedIn: {
              $sum: { $cond: [{ $eq: ['$optStatus', 'opted_in'] }, 1, 0] },
            },
            shopifyTagged: {
              $sum: {
                $cond: [{ $ifNull: ['$shopifyCustomerId', false] }, 1, 0],
              },
            },
          },
        },
      ]),
      AdLead.find({ clientId, optInSource: { $regex: /^checkout/i } })
        .sort({ optInDate: -1 })
        .limit(10)
        .select('name phoneNumber optInSource optStatus optInDate')
        .lean(),
      AdLead.find({ clientId, optInSource: thirdPartyMatch })
        .sort({ optInDate: -1, updatedAt: -1 })
        .limit(10)
        .select('name phoneNumber optInSource optStatus optInDate updatedAt')
        .lean(),
      AdLead.find({ clientId, optInSource: { $regex: /^website_/i } })
        .sort({ optInDate: -1 })
        .limit(10)
        .select('name phoneNumber optInSource optStatus optInDate')
        .lean(),
      AdLead.find({ clientId, optInSource: 'keyword' })
        .sort({ optInDate: -1 })
        .limit(10)
        .select('name phoneNumber optStatus optInDate')
        .lean(),
      ImportSession.find({ clientId })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('batchId filename status createdAt totalRows successCount')
        .lean(),
      GrowthQrScan.aggregate([
        { $match: { clientId, scannedAt: { $gte: since30 } } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      countOptIns(clientId, thankYouSourceMatch),
      AdLead.countDocuments({
        clientId,
        optStatus: 'opted_in',
        $and: [
          { optInSource: { $regex: /^website_/i } },
          { optInSource: { $not: { $regex: /thank_you/i } } },
        ],
      }),
    ]);

  const shopAgg = shopifyStats[0] || { total: 0, optedIn: 0, shopifyTagged: 0 };
  const shopifyOptInPct =
    shopAgg.shopifyTagged > 0
      ? Number(((shopAgg.optedIn / shopAgg.shopifyTagged) * 100).toFixed(1))
      : 0;

  const embedLive =
    client.growthEmbedEnabled !== false && String(client.growthEmbedPublicKey || '').length >= 16;
  const activeWidgets = (client.growthWidgetConfig?.activeWidgets || []).filter(Boolean);
  const webPixelActive = tracking?.webPixelInstalled === true;
  const checkoutCapturing = checkoutMonth > 0 || webPixelActive;

  let checkoutStatus = 'not_configured';
  let checkoutStatusReason = 'Install Custom Web Pixel + checkout consent extension';
  if (checkoutCapturing && checkoutMonth > 0) {
    checkoutStatus = 'live';
    checkoutStatusReason = `Capturing ${checkoutMonth} this month`;
  } else if (webPixelActive && !checkoutMonth) {
    checkoutStatus = 'setup_needed';
    checkoutStatusReason = 'Pixel installed but no checkout consents yet — enable checkout UI extension';
  } else if (webPixelActive || tracking?.webPixelInstalled) {
    checkoutStatus = 'setup_needed';
    checkoutStatusReason = 'Finish checkout consent extension setup';
  }

  const ctx = client.audienceContext || {};
  const provider =
    ctx.manualOverrides?.thirdPartyCheckout ||
    ctx.thirdPartyCheckout ||
    'unknown';
  const intKey =
    provider === 'gokwik'
      ? 'gokwik'
      : provider === 'razorpay_magic'
        ? 'razorpay_magic'
        : provider === 'shiprocket'
          ? 'shiprocket_checkout'
          : 'generic';
  const intCfg = ctx.integrations?.[intKey] || {};
  const webhookConfigured = !!intCfg.webhookSecret;
  const lastWebhook = intCfg.lastWebhookAt;

  let thirdPartyStatus = 'not_configured';
  let thirdPartyStatusReason = `Connect ${provider === 'unknown' ? 'third-party' : provider} webhook`;
  if (thirdPartyMonth > 0 || thirdPartyTotal > 0) {
    thirdPartyStatus = 'live';
    thirdPartyStatusReason = `Webhook receiving · ${thirdPartyMonth} this month`;
  } else if (webhookConfigured && lastWebhook) {
    thirdPartyStatus = 'setup_needed';
    thirdPartyStatusReason = 'Webhook configured but no recent events — send a test from your dashboard';
  } else if (webhookConfigured) {
    thirdPartyStatus = 'setup_needed';
    thirdPartyStatusReason = 'Webhook URL saved — configure provider dashboard and send test event';
  }

  let widgetStatus = 'not_configured';
  let widgetStatusReason = 'Paste growth snippet on your Shopify theme';
  const widgetMonthEarly = overview?.website?.newInPeriod || 0;
  const lastImpression = client.growthWidgetConfig?.lastImpressionAt;
  if (embedLive && activeWidgets.length > 0 && widgetMonthEarly > 0) {
    widgetStatus = 'live';
    widgetStatusReason = `Live · ${widgetMonthEarly} sign-ups this period`;
  } else if (embedLive && lastImpression) {
    widgetStatus = 'setup_needed';
    widgetStatusReason = 'Snippet detected but no opt-ins yet — verify consent checkbox on widgets';
  } else if (embedLive && activeWidgets.length > 0) {
    widgetStatus = 'setup_needed';
    widgetStatusReason = 'No events in 24h — verify snippet on storefront';
  } else if (embedLive) {
    widgetStatus = 'setup_needed';
    widgetStatusReason = 'Enable at least one widget surface';
  }

  const waConnected =
    Boolean(client.phoneNumber) ||
    Boolean(client.wabaAccounts?.length) ||
    Boolean(client.platformVars?.adminWhatsappNumber);

  const widgetMonth = overview?.website?.newInPeriod || 0;
  const widgetTotal = overview?.website?.optedIn || 0;

  const sources = {
    shopify_checkout: {
      status: checkoutStatus,
      statusReason: checkoutStatusReason,
      capturedThisMonth: checkoutMonth,
      totalCaptured: checkoutTotal,
      conversionHint: '30–50% of orders with phone when checkbox shown',
      meta: {
        webPixelActive,
        checkoutConsentDefaultChecked:
          client.growthWidgetConfig?.checkoutConsentDefaultChecked !== false,
        lastConsentAt: recentCheckout[0]?.optInDate || null,
        recent: recentCheckout,
      },
    },
    third_party_checkout: {
      status: thirdPartyStatus,
      statusReason: thirdPartyStatusReason,
      capturedThisMonth: thirdPartyMonth,
      totalCaptured: thirdPartyTotal,
      conversionHint: 'Depends on checkout volume and explicit opt-in rate',
      meta: {
        provider,
        webhookConfigured,
        lastWebhookAt: lastWebhook,
        consentStrategy: intCfg.consentStrategy || 'explicit',
        recent: recentThirdParty,
      },
    },
    website_widgets: {
      status: widgetStatus,
      statusReason: widgetStatusReason,
      capturedThisMonth: widgetMonth,
      totalCaptured: widgetTotal,
      conversionHint: '1–5% of visitors who see a widget',
      meta: {
        snippetDetected: embedLive,
        lastImpressionAt: lastImpression,
        activeWidgetCount: activeWidgets.length,
        activeWidgets,
        recent: recentWidget,
        thankYouCaptured: thankYouTotal,
        popupCaptured: popupTotal,
      },
    },
    whatsapp_keyword: {
      status: waConnected ? (keywordTotal > 0 ? 'live' : 'setup_needed') : 'not_configured',
      statusReason: waConnected
        ? keywordTotal > 0
          ? 'Keyword capturing inbound opt-ins'
          : 'WhatsApp connected — promote your keyword'
        : 'Connect WhatsApp first',
      capturedThisMonth: keywordMonth,
      totalCaptured: keywordTotal,
      conversionHint: 'Depends on keyword promotion',
      meta: { keywords: ['YES', 'START', 'JOIN', 'HELLO'], recent: recentKeyword },
    },
    click_to_whatsapp_ads: {
      status: 'post_launch',
      capturedThisMonth: 0,
      totalCaptured: 0,
      conversionHint: 'Varies by ad spend',
      meta: {},
    },
    manual_import: {
      status: importTotal > 0 ? 'live' : 'not_configured',
      capturedThisMonth: importMonth,
      totalCaptured: importTotal,
      conversionHint: 'One-time or periodic uploads',
      meta: { recentImports: importSessions },
    },
    shopify_migration: {
      status: shopAgg.shopifyTagged > 0 ? 'live' : client.shopifyConnected ? 'setup_needed' : 'not_configured',
      capturedThisMonth: 0,
      totalCaptured: shopAgg.shopifyTagged,
      conversionHint: 'Re-consent often 5–15%',
      meta: {
        shopifyCustomers: shopAgg.shopifyTagged,
        optedInCount: shopAgg.optedIn,
        optInPercent: shopifyOptInPct,
      },
    },
    qr_offline: {
      status: qrTotal > 0 || (qrBySource?.length || 0) > 0 ? 'live' : waConnected ? 'setup_needed' : 'not_configured',
      capturedThisMonth: qrMonth,
      totalCaptured: qrTotal,
      conversionHint: 'Depends on QR placement',
      meta: { scansBySource: qrBySource.map((x) => ({ source: x._id, count: x.count })) },
    },
  };

  const [totalOptedIn, newThisMonth, totalLeads] = await Promise.all([
    AdLead.countDocuments({ clientId, optStatus: 'opted_in' }),
    AdLead.countDocuments({ clientId, optStatus: 'opted_in', optInDate: { $gte: monthStart } }),
    AdLead.countDocuments({ clientId }),
  ]);

  const consentRate = totalLeads > 0 ? Number(((totalOptedIn / totalLeads) * 100).toFixed(1)) : 0;

  return {
    success: true,
    kpis: {
      subscribers: totalOptedIn,
      newThisMonth,
      consentRate,
    },
    sources,
    tracking: tracking
      ? {
          storefrontActive: tracking.storefrontActive,
          webPixelInstalled: tracking.webPixelInstalled,
          lastWebPixelEventAt: tracking.lastWebPixelEventAt,
        }
      : null,
  };
}

module.exports = { buildOptInSourcesStatus };
