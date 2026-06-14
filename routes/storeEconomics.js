const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const StoreEconomicsConfig = require('../models/StoreEconomicsConfig');
const StoreEconomicsProduct = require('../models/StoreEconomicsProduct');
const CartRecoveryAttempt = require('../models/CartRecoveryAttempt');
const {
  calculateAndStoreAllProducts,
  buildDashboardMetrics,
  buildProductIntelligence,
  getOrdersByState,
} = require('../utils/commerce/storeEconomicsEngine');
const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');

// Apply auth middleware to all routes
router.use(protect);

/**
 * GET /api/store-economics/status?clientId=X
 */
router.get('/status', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    const config = await StoreEconomicsConfig.findOne({ clientId }).lean();
    let products = [];
    if (config) {
      products = await StoreEconomicsProduct.find({ clientId }).lean();
    }

    res.json({ success: true, config, products });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/store-economics/wizard/step/:stepNumber
 */
router.patch('/wizard/step/:stepNumber', async (req, res) => {
  try {
    const { stepNumber } = req.params;
    const data = req.body;
    const { clientId } = data;

    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    let config = await StoreEconomicsConfig.findOne({ clientId });
    if (!config) {
      config = new StoreEconomicsConfig({ clientId });
    }

    config.currentWizardStep = Math.max(config.currentWizardStep, parseInt(stepNumber) + 1);

    if (stepNumber === '1') {
      config.packagingMode = data.packagingMode;
      config.uniformPackagingCost = data.uniformPackagingCost;

      if (data.products && Array.isArray(data.products)) {
        const bulkOps = data.products.map(p => ({
          updateOne: {
            filter: { clientId, shopifyProductId: p.shopifyProductId },
            update: {
              $set: {
                productName: p.productName,
                productImageUrl: p.productImageUrl,
                sellingPrice: p.sellingPrice,
                cogs: p.cogs,
                packagingCost: p.packagingCost,
                updatedAt: new Date()
              }
            },
            upsert: true
          }
        }));
        if (bulkOps.length > 0) {
          await StoreEconomicsProduct.bulkWrite(bulkOps);
        }
      }
    } else if (stepNumber === '2') {
      config.codAccepted = data.codAccepted;
      config.deliveryCostPerOrder = data.deliveryCostPerOrder;
      config.unacceptedCodLossPerOrder = data.unacceptedCodLossPerOrder;
      config.codRtoRate = data.codRtoRate !== undefined ? data.codRtoRate / 100 : null;
      config.totalRtoRate = data.totalRtoRate !== undefined ? data.totalRtoRate / 100 : null;
      config.prepaidRtoRate = data.prepaidRtoRate !== undefined ? data.prepaidRtoRate / 100 : null;
      config.unacceptedOrderLossPerOrder = data.unacceptedOrderLossPerOrder;
    } else if (stepNumber === '3') {
      config.cacPerCustomer = data.cacPerCustomer;
      config.gatewayFeeRate = data.gatewayFeeRate !== undefined ? data.gatewayFeeRate / 100 : null;
      config.shopifyTransactionFeeRate = data.shopifyTransactionFeeRate !== undefined ? data.shopifyTransactionFeeRate / 100 : null;
      config.gstEnabled = !!data.gstEnabled;
      config.gstRate =
        data.gstEnabled && data.gstRate !== undefined ? data.gstRate / 100 : null;
      config.fixedOverheadsPerOrder = data.fixedOverheadsPerOrder;
    }

    await config.save();

    // After step 3, trigger calculation so step 4 review has computed values
    if (stepNumber === '3') {
      try {
        await calculateAndStoreAllProducts(clientId);
      } catch (calcErr) {
        console.warn('[StoreEconomics] Partial calc after step 3:', calcErr.message);
      }
    }

    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/store-economics/wizard/finish
 */
router.post('/wizard/finish', async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    await calculateAndStoreAllProducts(clientId);
    
    const finishedAt = new Date();
    await StoreEconomicsConfig.updateOne(
      { clientId },
      { $set: { setupCompleted: true, setupCompletedAt: finishedAt, lastRecomputedAt: finishedAt } }
    );

    const products = await StoreEconomicsProduct.find({ clientId }).lean();
    res.json({ success: true, products });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/store-economics/dashboard
 */
router.get('/dashboard', async (req, res) => {
  try {
    const { clientId, startDate, endDate } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    const rangeStart = startDate && String(startDate) !== 'null' ? startDate : null;
    const rangeEnd = endDate && String(endDate) !== 'null' ? endDate : null;

    const [metrics, productIntelligence, ordersByState] = await Promise.all([
      buildDashboardMetrics(clientId, rangeStart, rangeEnd),
      buildProductIntelligence(clientId, rangeStart, rangeEnd),
      getOrdersByState(clientId, rangeStart, rangeEnd),
    ]);

    const configDoc = await StoreEconomicsConfig.findOne({ clientId })
      .select('gstEnabled gstRate lastRecomputedAt setupCompletedAt')
      .lean();

    res.json({
      success: true,
      data: {
        ...metrics,
        ...productIntelligence,
        ordersByState,
        configMeta: configDoc
          ? {
              gstEnabled: !!configDoc.gstEnabled,
              gstRatePercent: configDoc.gstRate ? Math.round(configDoc.gstRate * 100) : null,
              lastRecomputedAt: configDoc.lastRecomputedAt || configDoc.setupCompletedAt || null,
            }
          : null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/store-economics/shopify/fetch-products
 */
router.post('/shopify/fetch-products', async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    const products = await withShopifyRetry(clientId, async (shop) => {
      const response = await shop.get('/products.json', { params: { limit: 250, status: 'active', fields: 'id,title,image,variants' } });
      const shopifyProducts = response.data.products || [];
      
      return shopifyProducts.map(sp => {
        const price = sp.variants && sp.variants.length > 0 ? parseFloat(sp.variants[0].price) : 0;
        return {
          shopifyProductId: String(sp.id),
          productName: sp.title,
          productImageUrl: sp.image ? sp.image.src : null,
          sellingPrice: price,
          cogs: null,
          packagingCost: null
        };
      });
    });

    const bulkOps = products.map(p => ({
      updateOne: {
        filter: { clientId, shopifyProductId: p.shopifyProductId },
        update: {
          $set: {
            productName: p.productName,
            productImageUrl: p.productImageUrl,
            sellingPrice: p.sellingPrice,
            updatedAt: new Date()
          }
        },
        upsert: true
      }
    }));
    
    if (bulkOps.length > 0) {
      await StoreEconomicsProduct.bulkWrite(bulkOps);
    }

    const savedProducts = await StoreEconomicsProduct.find({ clientId }).lean();
    res.json({ success: true, products: savedProducts });
  } catch (error) {
    console.error('[fetch-products error]', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/store-economics/recompute
 * Recalculates per-product margins from stored COGS and config.
 */
router.post('/recompute', async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    const config = await StoreEconomicsConfig.findOne({ clientId });
    if (!config?.setupCompleted) {
      return res.status(400).json({ success: false, error: 'Complete economics setup first' });
    }

    await calculateAndStoreAllProducts(clientId);
    const recomputedAt = new Date();
    await StoreEconomicsConfig.updateOne({ clientId }, { $set: { lastRecomputedAt: recomputedAt } });

    const count = await StoreEconomicsProduct.countDocuments({ clientId });
    res.json({ success: true, productCount: count, lastRecomputedAt: recomputedAt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/store-economics/cart-recovery
 */
router.get('/cart-recovery', async (req, res) => {
  try {
    const { clientId, startDate, endDate } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    const start = startDate ? new Date(startDate) : new Date(0);
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const AdLead = require('../models/AdLead');
    const { getRecoveryTotalsFromAttempts } = require('../utils/commerce/cartRecoveryAttemptService');

    const [automationRows, leadRows, attemptTotals] = await Promise.all([
      CartRecoveryAttempt.aggregate([
        { $match: { clientId, attemptTimestamp: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: null,
            automationAttempts: { $sum: 1 },
            automationRecovered: { $sum: { $cond: [{ $eq: ['$status', 'recovered'] }, 1, 0] } },
            revenueRecovered: { $sum: { $ifNull: ['$recoveredOrderAmount', 0] } },
          },
        },
      ]),
      AdLead.aggregate([
        {
          $match: {
            clientId,
            lastInteraction: { $gte: start, $lte: end },
            cartStatus: { $in: ['abandoned', 'recovered', 'active', 'cart_added'] },
          },
        },
        { $group: { _id: '$cartStatus', count: { $sum: 1 } } },
      ]),
      getRecoveryTotalsFromAttempts(clientId, start, end).catch(() => null),
    ]);

    const auto = automationRows[0] || { automationAttempts: 0, automationRecovered: 0, revenueRecovered: 0 };
    const leadByStatus = Object.fromEntries((leadRows || []).map((r) => [r._id, r.count]));

    const abandonedCarts = Number(leadByStatus.abandoned) || 0;
    const recoveredCarts = Math.max(
      Number(leadByStatus.recovered) || 0,
      attemptTotals?.recoveredCarts || auto.automationRecovered || 0
    );
    const activeCarts = (Number(leadByStatus.active) || 0) + (Number(leadByStatus.cart_added) || 0);
    const didNotBuy = Math.max(0, abandonedCarts - recoveredCarts);
    const revenueRecovered = Math.round(
      Number(attemptTotals?.revenueRecovered) ||
        Number(auto.revenueRecovered) ||
        0
    );

    const recoveryRate = abandonedCarts > 0
      ? Math.round((recoveredCarts / abandonedCarts) * 10000) / 100
      : auto.automationAttempts > 0
        ? Math.round((auto.automationRecovered / auto.automationAttempts) * 10000) / 100
        : 0;

    res.json({
      success: true,
      data: {
        abandonedCarts,
        recoveredCarts,
        didNotBuy,
        activeCarts,
        revenueRecovered,
        waRevenueRecovered: Math.round(Number(attemptTotals?.waRevenue) || 0),
        organicRevenueRecovered: Math.round(Number(attemptTotals?.organicRevenue) || 0),
        recoveryRate,
        automationAttempts: auto.automationAttempts,
        automationRecovered: auto.automationRecovered,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
