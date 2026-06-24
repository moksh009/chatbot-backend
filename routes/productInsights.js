'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { apiCache } = require('../middleware/apiCache');
const {
  aggregateProductStats,
} = require('../utils/commerce/productInsightsRollup');
const { buildWinningProductsWorkspace } = require('../utils/commerce/winningProducts/winningProductsAggregator');
const ProductDailyStat = require('../models/ProductDailyStat');

function tenantClientId(req) {
  if (req.user?.role === 'SUPER_ADMIN' && req.query.clientId) {
    return String(req.query.clientId).trim();
  }
  return req.user?.clientId || null;
}

function parseDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(90, Math.max(7, Math.round(n)));
}

router.get('/workspace', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'SUPER_ADMIN' && req.user?.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const days = parseDays(req.query.days);
    const payload = await buildWinningProductsWorkspace(clientId, days);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/products', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'SUPER_ADMIN' && req.user?.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const days = parseDays(req.query.days);
    const sort = String(req.query.sort || 'views');
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 20));
    const aggregated = await aggregateProductStats(clientId, days);
    let products = aggregated.winningProducts || [];
    if (sort === 'revenue') {
      products = [...products].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
    } else if (sort === 'conversion') {
      products = [...products].sort((a, b) => (b.viewToCartRate || 0) - (a.viewToCartRate || 0));
    }
    res.json({
      success: true,
      rangeDays: days,
      products: products.slice(0, limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/products/:productId', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    if (req.user?.role !== 'SUPER_ADMIN' && req.user?.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const days = parseDays(req.query.days);
    const productId = decodeURIComponent(req.params.productId);
    const { dateRangeKeys } = require('../utils/commerce/productInsightsRollup');
    const keys = dateRangeKeys(days);
    const rows = await ProductDailyStat.find({
      clientId,
      productId,
      date: { $in: keys },
    })
      .sort({ date: 1 })
      .lean();

    const totals = rows.reduce(
      (acc, row) => {
        acc.views += row.views || 0;
        acc.addToCarts += row.addToCarts || 0;
        acc.purchases += row.purchases || 0;
        acc.revenue += row.revenue || 0;
        return acc;
      },
      { views: 0, addToCarts: 0, purchases: 0, revenue: 0 }
    );

    res.json({
      success: true,
      productId,
      rangeDays: days,
      title: rows[rows.length - 1]?.title || '',
      handle: rows[rows.length - 1]?.handle || '',
      image: rows[rows.length - 1]?.image || '',
      totals,
      trend: rows.map((r) => ({
        date: r.date,
        views: r.views || 0,
        addToCarts: r.addToCarts || 0,
        purchases: r.purchases || 0,
        revenue: r.revenue || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
