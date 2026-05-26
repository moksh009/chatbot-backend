'use strict';

const moment = require('moment');
const AdLead = require('../../models/AdLead');

const SOURCE_FILTERS = {
  shopify_checkout: { optInSource: { $regex: /^checkout/i } },
  website_widgets: { optInSource: { $regex: /^website_/i } },
  whatsapp_keyword: { optInSource: 'keyword' },
  manual_import: { optInSource: { $regex: /^csv/i } },
  shopify_migration: { shopifyCustomerId: { $exists: true, $ne: null, $ne: '' } },
  qr_offline: { optInSource: { $regex: /^qr/i } },
};

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '••••';
  return `•••• ${d.slice(-4)}`;
}

function canonicalSource(optInSource) {
  const s = String(optInSource || '').toLowerCase();
  if (s.startsWith('checkout')) return 'shopify_checkout';
  if (s.startsWith('website_')) return 'website_widgets';
  if (s === 'keyword') return 'whatsapp_keyword';
  if (s.startsWith('csv')) return 'manual_import';
  if (s.startsWith('qr')) return 'qr_offline';
  return 'other';
}

function lastConsentEntry(lead) {
  const hist = lead.optInHistory || [];
  const optedIn = [...hist].reverse().find((h) => h.event === 'opted_in' || h.action === 'opted_in');
  return optedIn || hist[hist.length - 1] || null;
}

function buildMatch(clientId, query = {}) {
  const match = { clientId };
  const period = String(query.period || '30d').toLowerCase();
  const days = period === 'today' ? 1 : period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since =
    period === 'today'
      ? moment().startOf('day').toDate()
      : moment().subtract(days, 'days').toDate();
  match.$or = [{ optInDate: { $gte: since } }, { updatedAt: { $gte: since } }];

  const status = String(query.status || '').trim();
  if (status) match.optStatus = status;

  const sources = String(query.sources || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (sources.length === 1 && SOURCE_FILTERS[sources[0]]) {
    Object.assign(match, SOURCE_FILTERS[sources[0]]);
  } else if (sources.length > 1) {
    match.$and = match.$and || [];
    match.$and.push({
      $or: sources.map((id) => SOURCE_FILTERS[id]).filter(Boolean),
    });
  }

  const q = String(query.q || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    match.$and = match.$and || [];
    match.$and.push({
      $or: [{ name: rx }, { phoneNumber: rx }, { email: rx }],
    });
  }

  return { match, since, days };
}

async function buildCaptureActivity(clientId, query = {}) {
  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.min(100, Math.max(10, parseInt(query.limit || '25', 10)));
  const skip = (page - 1) * limit;
  const { match } = buildMatch(clientId, query);

  const todayStart = moment().startOf('day').toDate();
  const yesterdayStart = moment().subtract(1, 'day').startOf('day').toDate();
  const weekStart = moment().startOf('week').toDate();
  const lastWeekStart = moment().subtract(1, 'week').startOf('week').toDate();
  const lastWeekEnd = moment().subtract(1, 'week').endOf('week').toDate();

  const [rows, total, todayCount, yesterdayCount, weekCount, lastWeekCount, topToday] =
    await Promise.all([
      AdLead.find(match)
        .sort({ optInDate: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'name phoneNumber email optInSource optStatus optInDate updatedAt optInHistory channelConsent'
        )
        .lean(),
      AdLead.countDocuments(match),
      AdLead.countDocuments({
        clientId,
        optStatus: 'opted_in',
        optInDate: { $gte: todayStart },
      }),
      AdLead.countDocuments({
        clientId,
        optStatus: 'opted_in',
        optInDate: { $gte: yesterdayStart, $lt: todayStart },
      }),
      AdLead.countDocuments({
        clientId,
        optStatus: 'opted_in',
        optInDate: { $gte: weekStart },
      }),
      AdLead.countDocuments({
        clientId,
        optStatus: 'opted_in',
        optInDate: { $gte: lastWeekStart, $lte: lastWeekEnd },
      }),
      AdLead.aggregate([
        {
          $match: {
            clientId,
            optStatus: 'opted_in',
            optInDate: { $gte: todayStart },
          },
        },
        { $group: { _id: '$optInSource', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]),
    ]);

  const topSourceRaw = topToday[0]?._id || null;
  const topSourceToday = topSourceRaw ? canonicalSource(topSourceRaw) : null;

  return {
    success: true,
    stats: {
      capturesToday: todayCount,
      capturesYesterday: yesterdayCount,
      capturesThisWeek: weekCount,
      capturesLastWeek: lastWeekCount,
      topSourceToday,
    },
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    rows: rows.map((lead) => {
      const consent = lastConsentEntry(lead);
      return {
        id: String(lead._id),
        when: lead.optInDate || lead.updatedAt,
        name: lead.name || 'Customer',
        phoneMasked: maskPhone(lead.phoneNumber),
        email: lead.email ? String(lead.email).replace(/(.{2}).+(@.+)/, '$1•••$2') : null,
        source: canonicalSource(lead.optInSource),
        sourceRaw: lead.optInSource || 'unknown',
        channel: 'whatsapp',
        status: lead.optStatus || 'unknown',
        consentText: consent?.note || null,
        ipAddress: consent?.ipAddress || null,
        userAgent: consent?.userAgent || null,
        optInHistory: lead.optInHistory || [],
      };
    }),
  };
}

async function buildCaptureExport(clientId, query = {}) {
  const { match } = buildMatch(clientId, { ...query, limit: 5000 });
  const rows = await AdLead.find(match)
    .sort({ optInDate: -1 })
    .limit(5000)
    .select('name phoneNumber email optInSource optStatus optInDate optInHistory')
    .lean();

  return rows.map((lead) => {
    const consent = lastConsentEntry(lead);
    return {
      phone: lead.phoneNumber || '',
      email: lead.email || '',
      source: lead.optInSource || '',
      canonicalSource: canonicalSource(lead.optInSource),
      status: lead.optStatus || '',
      timestamp: lead.optInDate || '',
      consentText: consent?.note || '',
      ip: consent?.ipAddress || '',
      userAgent: consent?.userAgent || '',
    };
  });
}

module.exports = {
  buildCaptureActivity,
  buildCaptureExport,
  canonicalSource,
  maskPhone,
};
