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
      'growthEmbedEnabled growthEmbedPublicKey growthWidgetConfig shopifyDomain shopifyConnected phoneNumber wabaAccounts platformVars'
    )
    .lean();
  if (!client) return null;

  const [tracking, overview, checkoutMonth, checkoutTotal, keywordMonth, keywordTotal, importMonth, importTotal, qrMonth, qrTotal, shopifyStats, recentCheckout, recentWidget, recentKeyword, importSessions, qrBySource] =
    await Promise.all([
      buildTrackingHealth(clientId, 30).catch(() => null),
      buildGrowthEmbedOverview(clientId, '30d').catch(() => null),
      countOptIns(clientId, { $regex: /^checkout/i }, monthStart),
      countOptIns(clientId, { $regex: /^checkout/i }),
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
  if (checkoutCapturing && checkoutMonth > 0) checkoutStatus = 'live';
  else if (webPixelActive || tracking?.webPixelInstalled) checkoutStatus = 'setup_needed';

  let widgetStatus = 'not_configured';
  if (embedLive && activeWidgets.length > 0 && (overview?.website?.newInPeriod || 0) > 0) {
    widgetStatus = 'live';
  } else if (embedLive && activeWidgets.length > 0) {
    widgetStatus = 'setup_needed';
  } else if (embedLive) {
    widgetStatus = 'setup_needed';
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
      capturedThisMonth: checkoutMonth,
      totalCaptured: checkoutTotal,
      conversionHint: '30–50% of orders with phone when checkbox shown',
      meta: {
        webPixelActive,
        lastConsentAt: recentCheckout[0]?.optInDate || null,
        recent: recentCheckout,
      },
    },
    website_widgets: {
      status: widgetStatus,
      capturedThisMonth: widgetMonth,
      totalCaptured: widgetTotal,
      conversionHint: '1–5% of visitors who see a widget',
      meta: {
        snippetDetected: embedLive,
        activeWidgetCount: activeWidgets.length,
        activeWidgets,
        recent: recentWidget,
      },
    },
    whatsapp_keyword: {
      status: waConnected ? (keywordTotal > 0 ? 'live' : 'setup_needed') : 'not_configured',
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
