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
} = require('../utils/storeEconomicsEngine');
const { withShopifyRetry } = require('../utils/shopifyHelper');

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
      config.gstRate = data.gstRate !== undefined ? data.gstRate / 100 : null;
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
    
    await StoreEconomicsConfig.updateOne(
      { clientId },
      { $set: { setupCompleted: true, setupCompletedAt: new Date() } }
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
    if (!clientId || !startDate || !endDate) return res.status(400).json({ success: false, error: 'Missing required parameters' });

    const [metrics, productIntelligence, ordersByState] = await Promise.all([
      buildDashboardMetrics(clientId, startDate, endDate),
      buildProductIntelligence(clientId, startDate, endDate),
      getOrdersByState(clientId, startDate, endDate),
    ]);

    res.json({
      success: true,
      data: {
        ...metrics,
        ...productIntelligence,
        ordersByState,
      }
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
 * GET /api/store-economics/cart-recovery
 */
router.get('/cart-recovery', async (req, res) => {
  try {
    const { clientId, startDate, endDate } = req.query;
    if (!clientId || !startDate || !endDate) return res.status(400).json({ success: false, error: 'Missing required parameters' });

    const start = new Date(startDate);
    const end = new Date(endDate);

    const metrics = await CartRecoveryAttempt.aggregate([
      { $match: { clientId, attemptTimestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          abandonedCarts: { $sum: 1 },
          recoveredCarts: { $sum: { $cond: [{ $eq: ['$status', 'recovered'] }, 1, 0] } },
          didNotBuy: { $sum: { $cond: [{ $in: ['$status', ['pending', 'expired']] }, 1, 0] } },
          revenueRecovered: { $sum: '$recoveredOrderAmount' }
        }
      }
    ]);

    const raw = metrics[0] || { abandonedCarts: 0, recoveredCarts: 0, didNotBuy: 0, revenueRecovered: 0 };
    const recoveryRate = raw.abandonedCarts > 0
      ? Math.round((raw.recoveredCarts / raw.abandonedCarts) * 10000) / 100
      : 0;
    
    res.json({ success: true, data: { ...raw, recoveryRate } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
