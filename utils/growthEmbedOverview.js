const crypto = require('crypto');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');

function maskPhoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '••••';
  return `•••• ${d.slice(-4)}`;
}

async function ensureGrowthEmbedDoc(clientId) {
  let doc = await Client.findOne({ clientId }).select(
    'growthEmbedPublicKey growthEmbedEnabled growthCompliance growthWidgetConfig clientId'
  );
  if (!doc) return null;
  if (!doc.growthEmbedPublicKey || String(doc.growthEmbedPublicKey).length < 16) {
    const key = crypto.randomBytes(24).toString('hex');
    doc = await Client.findOneAndUpdate(
      { clientId },
      { $set: { growthEmbedPublicKey: key } },
      { new: true }
    ).select('growthEmbedPublicKey growthEmbedEnabled growthCompliance growthWidgetConfig clientId');
  }
  return doc;
}

async function buildGrowthEmbedOverview(clientId, period = '30d') {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const doc = await ensureGrowthEmbedDoc(clientId);
  if (!doc) return null;

  const impressions = doc.growthWidgetConfig?.impressions || {};
  const totalImpressions = Object.entries(impressions).reduce(
    (sum, [, v]) => sum + (Number(v) || 0),
    0
  );
  const activeWidgets = (doc.growthWidgetConfig?.activeWidgets || []).filter(Boolean);
  const websiteMatch = { clientId, optInSource: { $regex: /^website_/i } };

  const [statusWebsite, newWebsite, recentWebsite, byWidget] = await Promise.all([
    AdLead.aggregate([
      { $match: websiteMatch },
      { $group: { _id: '$optStatus', count: { $sum: 1 } } },
    ]),
    AdLead.countDocuments({
      ...websiteMatch,
      optStatus: 'opted_in',
      optInDate: { $gte: since },
    }),
    AdLead.find(websiteMatch)
      .sort({ optInDate: -1, updatedAt: -1 })
      .limit(10)
      .select('name optInSource optStatus optInDate updatedAt phoneNumber')
      .lean(),
    AdLead.aggregate([
      { $match: websiteMatch },
      { $group: { _id: '$optInSource', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 12 },
    ]),
  ]);

  const statusMap = {};
  statusWebsite.forEach((x) => {
    statusMap[x._id || 'unknown'] = x.count;
  });
  const totalWebsite = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const optedIn = statusMap.opted_in || 0;
  const websiteOptInRate =
    totalWebsite > 0 ? Number(((optedIn / totalWebsite) * 100).toFixed(1)) : 0;

  return {
    success: true,
    periodDays: days,
    embedEnabled: doc.growthEmbedEnabled !== false,
    activeWidgetCount: activeWidgets.length,
    activeWidgets,
    totalImpressions,
    impressionsByWidget: impressions,
    lastImpressionAt: doc.growthWidgetConfig?.lastImpressionAt || null,
    doubleOptInEnabled: doc.growthWidgetConfig?.doubleOptInEnabled === true,
    strictCart: doc.growthCompliance?.cartRecoveryRequiresOptIn === true,
    website: {
      total: totalWebsite,
      optedIn,
      pending: statusMap.pending || 0,
      unknown: statusMap.unknown || 0,
      optedOut: statusMap.opted_out || 0,
      newInPeriod: newWebsite,
      optInRate: websiteOptInRate,
      bySource: byWidget.map((x) => ({
        source: x._id || 'unknown',
        count: x.count,
      })),
      recent: recentWebsite.map((x) => ({
        name: x.name || 'Visitor',
        phoneMasked: maskPhoneDigits(x.phoneNumber),
        source: x.optInSource || 'unknown',
        status: x.optStatus || 'unknown',
        timestamp: x.optInDate || x.updatedAt || null,
      })),
    },
  };
}

module.exports = {
  ensureGrowthEmbedDoc,
  buildGrowthEmbedOverview,
  maskPhoneDigits,
};
