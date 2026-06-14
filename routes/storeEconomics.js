const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const StoreEconomicsConfig = require('../models/StoreEconomicsConfig');
const StoreEconomicsProduct = require('../models/StoreEconomicsProduct');
const { calculateRecoveryMetrics } = require('../services/cartRecoveryMetricsService');
const { tenantClientId } = require('../utils/core/queryHelpers');
const {
  calculateAndStoreAllProducts,
  buildDashboardMetrics,
  buildProductIntelligence,
  getOrdersByState,
} = require('../utils/commerce/storeEconomicsEngine');
const { hasEconomicsInputs, isEconomicsSetupReady } = require('../utils/commerce/storeEconomicsSetup');
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

    res.json({
      success: true,
      config,
      products,
      setupReady: isEconomicsSetupReady(config, products),
      hasInputs: hasEconomicsInputs(config, products),
    });
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

    const config = await StoreEconomicsConfig.findOne({ clientId });
    if (!config) {
      return res.status(400).json({
        success: false,
        error: 'SETUP_INCOMPLETE',
        message: 'Complete all setup steps before activating economics.',
      });
    }

    const products = await StoreEconomicsProduct.find({ clientId }).lean();
    if (!hasEconomicsInputs(config, products)) {
      return res.status(400).json({
        success: false,
        error: 'NO_COST_DATA',
        message: 'Add product COGS and at least one cost — delivery, CAC, packaging, fees, or RTO — before activating.',
      });
    }

    await calculateAndStoreAllProducts(clientId);
    
    const finishedAt = new Date();
    await StoreEconomicsConfig.updateOne(
      { clientId },
      { $set: { setupCompleted: true, setupCompletedAt: finishedAt, lastRecomputedAt: finishedAt } }
    );

    const refreshedProducts = await StoreEconomicsProduct.find({ clientId }).lean();
    res.json({ success: true, products: refreshedProducts, setupReady: true });
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

    const [configDoc, products] = await Promise.all([
      StoreEconomicsConfig.findOne({ clientId }).lean(),
      StoreEconomicsProduct.find({ clientId }).lean(),
    ]);

    if (!isEconomicsSetupReady(configDoc, products)) {
      return res.status(400).json({
        success: false,
        error: 'ECONOMICS_SETUP_REQUIRED',
        message: 'Add your store cost statistics before viewing profit analytics.',
      });
    }

    const [metrics, productIntelligence, ordersByState] = await Promise.all([
      buildDashboardMetrics(clientId, rangeStart, rangeEnd),
      buildProductIntelligence(clientId, rangeStart, rangeEnd),
      getOrdersByState(clientId, rangeStart, rangeEnd),
    ]);

    const configMetaDoc = await StoreEconomicsConfig.findOne({ clientId })
      .select('gstEnabled gstRate lastRecomputedAt setupCompletedAt')
      .lean();

    res.json({
      success: true,
      data: {
        ...metrics,
        ...productIntelligence,
        ordersByState,
        configMeta: configMetaDoc
          ? {
              gstEnabled: !!configMetaDoc.gstEnabled,
              gstRatePercent: configMetaDoc.gstRate ? Math.round(configMetaDoc.gstRate * 100) : null,
              lastRecomputedAt: configMetaDoc.lastRecomputedAt || configMetaDoc.setupCompletedAt || null,
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { startDate, endDate, from: fromRaw, to: toRaw, preset } = req.query;

    const { parseDateRange } = require('../utils/commerce/abandonedCartWorkspace');
    const { startOfDayForDateStrIST, endOfDayForDateStrIST } = require('../utils/core/queryHelpers');

    let from;
    let to;
    if (fromRaw && toRaw) {
      const fromStr = String(fromRaw).slice(0, 10);
      const toStr = String(toRaw).slice(0, 10);
      from = startOfDayForDateStrIST(fromStr);
      to = endOfDayForDateStrIST(toStr);
    } else if (startDate && endDate) {
      from = startOfDayForDateStrIST(String(startDate).slice(0, 10));
      to = endOfDayForDateStrIST(String(endDate).slice(0, 10));
    } else {
      ({ from, to } = parseDateRange({ preset: preset || '30d', from: fromRaw, to: toRaw }));
    }

    const metrics = await calculateRecoveryMetrics(clientId, {
      mode: 'cohort',
      from,
      to,
      includeFunnel: true,
      includeRows: false,
    });

    res.json({
      success: true,
      data: {
        totalAbandoned: metrics.totalAbandoned,
        abandonedCarts: metrics.totalAbandoned,
        recoveredCarts: metrics.recoveredCarts,
        didNotBuy: Math.max(0, metrics.totalAbandoned - metrics.recoveredCarts),
        activeCarts: 0,
        revenueRecovered: metrics.revenueRecovered,
        waRevenueRecovered: metrics.revenueRecoveredFromWhatsapp,
        organicRevenueRecovered: metrics.organicRevenue,
        whatsappRecovered: metrics.whatsappRecovered,
        organicRecovered: metrics.organicRecovered,
        recoveryRate: metrics.recoveryRate,
        messageEfficiencyRate: metrics.funnel?.messageEfficiencyRate ?? 0,
        funnel: metrics.funnel,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
