const StoreEconomicsConfig = require('../models/StoreEconomicsConfig');
const StoreEconomicsProduct = require('../models/StoreEconomicsProduct');
const { withShopifyRetry } = require('./shopifyHelper');

/**
 * Calculates net profit for a single product based on configured costs.
 * Formula must match exactly: Net Profit = Gross Margin - CAC - Packaging - Delivery - Gateway - Shopify
 */
function calculateNetProfitPerProduct(product, config) {
  const effectivePackagingCost = config.packagingMode === 'uniform'
    ? config.uniformPackagingCost
    : (product.packagingCost || 0);

  const grossMargin = product.sellingPrice - product.cogs;

  const gatewayDeduction = product.sellingPrice * (config.gatewayFeeRate || 0);
  const shopifyDeduction = product.sellingPrice * (config.shopifyTransactionFeeRate || 0);

  const netProfit = grossMargin
    - (config.cacPerCustomer || 0)
    - effectivePackagingCost
    - (config.deliveryCostPerOrder || 0)
    - gatewayDeduction
    - shopifyDeduction;

  const netProfitMarginRate = product.sellingPrice > 0
    ? netProfit / product.sellingPrice
    : 0;

  return { grossMargin, netProfit, netProfitMarginRate };
}

/**
 * Recalculates and bulk updates all products for a workspace.
 */
async function calculateAndStoreAllProducts(clientId) {
  const config = await StoreEconomicsConfig.findOne({ clientId });
  if (!config) return;

  const products = await StoreEconomicsProduct.find({ clientId });
  if (!products.length) return;

  const bulkOps = products.map(product => {
    const { grossMargin, netProfit, netProfitMarginRate } = calculateNetProfitPerProduct(product, config);
    return {
      updateOne: {
        filter: { _id: product._id },
        update: { $set: { grossMargin, netProfit, netProfitMarginRate, updatedAt: new Date() } }
      }
    };
  });

  if (bulkOps.length > 0) {
    await StoreEconomicsProduct.bulkWrite(bulkOps);
  }
}

/**
 * Dashboard primary metrics builder.
 * Processes real orders against stored unit economics.
 */
async function buildDashboardMetrics(clientId, startDate, endDate) {
  const [config, products, orders] = await Promise.all([
    StoreEconomicsConfig.findOne({ clientId }).lean(),
    StoreEconomicsProduct.find({ clientId }).lean(),
    fetchShopifyOrdersInRange(clientId, startDate, endDate)
  ]);

  if (!config || !config.setupCompleted) throw new Error('Store Economics not configured');

  const productMap = new Map(products.map(p => [p.shopifyProductId, p]));

  let totalGrossRevenue = 0;
  let totalCogs = 0;
  let totalNetProfit = 0;
  let totalPackagingCost = 0;
  let totalShippingCost = 0;
  let totalGatewayAndShopifyFees = 0;
  let totalCac = 0;
  let totalOrderCount = 0;
  let codOrderCount = 0;
  let prepaidOrderCount = 0;

  for (const order of orders) {
    const isCod = order.paymentGateway?.toLowerCase().includes('cod') ||
                  order.paymentMethod?.toLowerCase().includes('cash_on_delivery') ||
                  (order.gateway || '').toLowerCase().includes('cash');

    totalGrossRevenue += parseFloat(order.total_price || 0);
    totalOrderCount++;
    totalShippingCost += (config.deliveryCostPerOrder || 0);
    totalCac += (config.cacPerCustomer || 0);

    if (isCod) codOrderCount++;
    else prepaidOrderCount++;

    for (const lineItem of order.line_items) {
      const product = productMap.get(String(lineItem.product_id));
      if (!product) continue;

      const qty = lineItem.quantity;

      const effectivePackagingCost = config.packagingMode === 'uniform'
        ? (config.uniformPackagingCost || 0)
        : (product.packagingCost || 0);

      totalPackagingCost += effectivePackagingCost * qty;
      totalCogs += (product.cogs || 0) * qty;
      totalNetProfit += (product.netProfit || 0) * qty;

      const itemRevenue = parseFloat(lineItem.price || 0) * qty;
      totalGatewayAndShopifyFees += itemRevenue * ((config.gatewayFeeRate || 0) + (config.shopifyTransactionFeeRate || 0));
    }
  }

  // RTO losses calculation
  let totalRtoLoss = 0;
  if (config.codAccepted) {
    const codRtoLoss = codOrderCount * (config.codRtoRate || 0) * (config.unacceptedCodLossPerOrder || 0);
    const prepaidRtoLoss = prepaidOrderCount
      * ((config.totalRtoRate || 0) - (config.codRtoRate || 0) * (codOrderCount / Math.max(totalOrderCount, 1)))
      * (config.unacceptedOrderLossPerOrder || 0);
    totalRtoLoss = codRtoLoss + prepaidRtoLoss;
  } else {
    totalRtoLoss = totalOrderCount * (config.prepaidRtoRate || 0) * (config.unacceptedOrderLossPerOrder || 0);
  }

  const totalFixedOverheads = totalOrderCount * (config.fixedOverheadsPerOrder || 0);
  const trueNetProfit = totalNetProfit - totalRtoLoss - totalFixedOverheads;

  const actualRtoRate = await computeActualRtoRate(clientId, startDate, endDate, totalOrderCount, config);

  const waterfall = [
    { label: 'Gross Revenue', value: totalGrossRevenue, type: 'positive' },
    { label: 'COGS', value: -totalCogs, type: 'negative' },
    { label: 'CAC', value: -totalCac, type: 'negative' },
    { label: 'Packaging', value: -totalPackagingCost, type: 'negative' },
    { label: 'Shipping', value: -totalShippingCost, type: 'negative' },
    { label: 'RTO Losses', value: -totalRtoLoss, type: 'negative' },
    { label: 'Gateway & Shopify Fees', value: -totalGatewayAndShopifyFees, type: 'negative' },
    { label: 'Fixed Overheads', value: -totalFixedOverheads, type: 'negative' },
    { label: 'True Net Profit', value: trueNetProfit, type: trueNetProfit >= 0 ? 'result_positive' : 'result_negative' }
  ];

  const waterfallSum = totalGrossRevenue
    - totalCogs
    - totalCac
    - totalPackagingCost
    - totalShippingCost
    - totalRtoLoss
    - totalGatewayAndShopifyFees
    - totalFixedOverheads;

  if (Math.abs(waterfallSum - trueNetProfit) > 0.01) {
    console.error(`[StoreEconomics] Waterfall integrity check failed for clientId: ${clientId}. Waterfall sum: ${waterfallSum}, True Net Profit: ${trueNetProfit}`);
  }

  // Health Score Calculation
  const netProfitMarginRate = totalGrossRevenue > 0 ? trueNetProfit / totalGrossRevenue : 0;
  const cacToRevRatio = totalGrossRevenue > 0 ? (totalOrderCount * config.cacPerCustomer) / totalGrossRevenue : 0;
  const rtoRateDecimal = actualRtoRate.value / 100;
  
  // Normalized components (0 to 1)
  const normMargin = Math.max(0, Math.min(1, netProfitMarginRate * 5)); // Expect ~20% margin to be 100 score
  const normRto = Math.max(0, 1 - rtoRateDecimal * 3); // Expect <33% RTO
  const normCac = Math.max(0, 1 - cacToRevRatio * 5); // Expect CAC to be < 20% of Rev

  const healthScore = Math.round((normMargin * 0.6 + normRto * 0.2 + normCac * 0.2) * 100);
  
  let healthStatus = 'At Risk';
  if (healthScore >= 70) healthStatus = 'Good';
  else if (healthScore >= 40) healthStatus = 'Needs Attention';

  // Break-even: how many orders needed to cover total fixed overheads from net profit
  const avgNetProfitPerOrder = totalOrderCount > 0 ? (totalNetProfit / totalOrderCount) : 0;
  let breakEven = null;
  if (config.fixedOverheadsPerOrder && avgNetProfitPerOrder > 0 && totalOrderCount > 0) {
    const breakEvenOrders = Math.ceil(totalFixedOverheads / avgNetProfitPerOrder);
    const breakEvenRevenue = breakEvenOrders * (totalGrossRevenue / totalOrderCount);
    const coveragePercent = totalFixedOverheads > 0 ? (trueNetProfit / totalFixedOverheads) * 100 : 0;
    breakEven = { orders: breakEvenOrders, revenue: breakEvenRevenue, coveragePercent: Math.round(coveragePercent * 100) / 100 };
  }

  // Cost composition for donut chart (percentage of total costs)
  const totalCosts = totalCogs + totalPackagingCost + totalShippingCost + totalRtoLoss + totalGatewayAndShopifyFees + totalCac + totalFixedOverheads;
  const costComposition = totalCosts > 0 ? [
    { name: 'COGS', value: Math.round((totalCogs / totalCosts) * 10000) / 100 },
    { name: 'Packaging', value: Math.round((totalPackagingCost / totalCosts) * 10000) / 100 },
    { name: 'Shipping', value: Math.round((totalShippingCost / totalCosts) * 10000) / 100 },
    { name: 'RTO Losses', value: Math.round((totalRtoLoss / totalCosts) * 10000) / 100 },
    { name: 'Gateway Fees', value: Math.round((totalGatewayAndShopifyFees / totalCosts) * 10000) / 100 },
    { name: 'CAC', value: Math.round((totalCac / totalCosts) * 10000) / 100 },
    { name: 'Fixed Overheads', value: Math.round((totalFixedOverheads / totalCosts) * 10000) / 100 }
  ] : [];

  const codPct = totalOrderCount > 0 ? Math.round((codOrderCount / totalOrderCount) * 1000) / 10 : 0;
  const prepaidPct = totalOrderCount > 0 ? Math.round((prepaidOrderCount / totalOrderCount) * 1000) / 10 : 0;

  return {
    heroMetrics: {
      trueNetProfit,
      totalGrossRevenue,
      liveRtoRate: actualRtoRate,
      liveRtoRateIsConfigured: actualRtoRate.isConfigured
    },
    paymentMethodSplit: {
      codOrders: codOrderCount,
      prepaidOrders: prepaidOrderCount,
      codPercent: codPct,
      prepaidPercent: prepaidPct,
    },
    waterfall,
    totalOrderCount,
    healthScore: { value: healthScore, status: healthStatus },
    breakEven,
    costComposition,
    timeline: { startDate, endDate }
  };
}

/**
 * Geographic order distribution from Mongo order shipping addresses.
 */
async function getOrdersByState(clientId, startDate, endDate) {
  const Order = require('../models/Order');
  const { extractStateFromAddress } = require('./extractStateFromAddress');

  const query = { clientId };
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  const orders = await Order.find(query)
    .select('shippingAddress state address city totalPrice amount')
    .lean();

  const stateMap = {};
  for (const order of orders) {
    const state =
      extractStateFromAddress(order.shippingAddress) ||
      extractStateFromAddress(order.state) ||
      extractStateFromAddress([order.address, order.city, order.state].filter(Boolean).join(', '));
    if (!state) continue;
    if (!stateMap[state]) stateMap[state] = { orderCount: 0, totalRevenue: 0 };
    stateMap[state].orderCount += 1;
    stateMap[state].totalRevenue += Number(order.totalPrice ?? order.amount ?? 0);
  }

  return Object.entries(stateMap)
    .map(([state, data]) => ({ state, ...data }))
    .sort((a, b) => b.orderCount - a.orderCount);
}

/**
 * Attempts to compute RTO rate from real Shopify data first. Falls back to config.
 */
async function computeActualRtoRate(clientId, startDate, endDate, totalOrderCount, config) {
  try {
    const returnedOrders = await fetchShopifyReturnedOrdersInRange(clientId, startDate, endDate);
    if (returnedOrders !== null && totalOrderCount > 0) {
      return {
        value: (returnedOrders / totalOrderCount) * 100,
        isConfigured: false
      };
    }
  } catch (err) {
    console.warn('[StoreEconomics] Could not fetch actual return data from Shopify:', err.message);
  }

  const configuredRate = config.codAccepted
    ? (config.totalRtoRate || 0) * 100
    : (config.prepaidRtoRate || 0) * 100;

  return { value: configuredRate, isConfigured: true };
}

/**
 * Computes product performance data.
 */
async function buildProductIntelligence(clientId, startDate, endDate) {
  const [products, orders, config] = await Promise.all([
    StoreEconomicsProduct.find({ clientId }).lean(),
    fetchShopifyOrdersInRange(clientId, startDate, endDate),
    StoreEconomicsConfig.findOne({ clientId }).lean()
  ]);

  if (!config) throw new Error('Store Economics not configured');

  const productMap = new Map(products.map(p => [p.shopifyProductId, p]));
  const productStats = new Map();

  for (const order of orders) {
    for (const lineItem of order.line_items) {
      const product = productMap.get(String(lineItem.product_id));
      if (!product) continue;

      const existing = productStats.get(product.shopifyProductId) || {
        product,
        unitsSold: 0,
        totalNetProfit: 0
      };

      existing.unitsSold += lineItem.quantity;
      existing.totalNetProfit += (product.netProfit || 0) * lineItem.quantity;
      productStats.set(product.shopifyProductId, existing);
    }
  }

  const statsArray = Array.from(productStats.values()).map(stat => ({
    shopifyProductId: stat.product.shopifyProductId,
    productName: stat.product.productName,
    productImageUrl: stat.product.productImageUrl,
    sellingPrice: stat.product.sellingPrice,
    unitsSold: stat.unitsSold,
    netProfitPerUnit: stat.product.netProfit,
    netProfitMarginPercent: ((stat.product.netProfitMarginRate || 0) * 100).toFixed(2),
    totalNetProfit: stat.totalNetProfit,
    primaryCostDriver: determinePrimaryCostDriver(stat.product, config)
  }));

  const topCashMachines = [...statsArray]
    .sort((a, b) => b.netProfitMarginPercent - a.netProfitMarginPercent)
    .slice(0, 5);

  const moneyDrainers = [...statsArray]
    .sort((a, b) => a.netProfitMarginPercent - b.netProfitMarginPercent)
    .slice(0, 5);

  return { topCashMachines, moneyDrainers };
}

function determinePrimaryCostDriver(product, config) {
  const effectivePackaging = config.packagingMode === 'uniform'
    ? (config.uniformPackagingCost || 0)
    : (product.packagingCost || 0);

  const components = {
    'High CAC': config.cacPerCustomer || 0,
    'High Packaging': effectivePackaging,
    'High Shipping': config.deliveryCostPerOrder || 0,
    'Low Margin': Math.max(0, product.sellingPrice - (product.cogs || 0) - (product.netProfit || 0)) // Just using relative weight
  };

  return Object.entries(components).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Fetch orders from Shopify recursively.
 */
async function fetchShopifyOrdersInRange(clientId, startDate, endDate) {
  return await withShopifyRetry(clientId, async (shop) => {
    let allOrders = [];
    let url = '/orders.json';
    const params = {
      status: 'any',
      created_at_min: startDate,
      created_at_max: endDate,
      limit: 250,
      fields: 'id,total_price,payment_gateway,financial_status,fulfillment_status,line_items'
    };

    let hasNext = true;

    while (hasNext) {
      try {
        const response = await shop.get(url, { params: url === '/orders.json' ? params : {} });
        if (response.data.orders) {
          allOrders = allOrders.concat(response.data.orders);
        }

        const linkHeader = response.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
          const links = linkHeader.split(', ');
          const nextLink = links.find(l => l.includes('rel="next"'));
          if (nextLink) {
            const match = nextLink.match(/<([^>]+)>/);
            if (match) {
              const fullUrl = match[1];
              const parsedUrl = new URL(fullUrl);
              url = '/orders.json' + parsedUrl.search;
            } else {
              hasNext = false;
            }
          } else {
            hasNext = false;
          }
        } else {
          hasNext = false;
        }
      } catch (err) {
        console.error(`[fetchShopifyOrders] Error fetching page:`, err.message);
        break;
      }
    }
    return allOrders;
  });
}

/**
 * Fetch returned orders from Shopify
 */
async function fetchShopifyReturnedOrdersInRange(clientId, startDate, endDate) {
  return await withShopifyRetry(clientId, async (shop) => {
    let returnedCount = 0;
    let url = '/orders.json';
    const params = {
      status: 'any',
      created_at_min: startDate,
      created_at_max: endDate,
      financial_status: 'refunded',
      limit: 250,
      fields: 'id,financial_status,fulfillment_status'
    };

    let hasNext = true;

    while (hasNext) {
      try {
        const response = await shop.get(url, { params: url === '/orders.json' ? params : {} });
        if (response.data.orders) {
          returnedCount += response.data.orders.length;
        }

        const linkHeader = response.headers['link'];
        if (linkHeader && linkHeader.includes('rel="next"')) {
           const links = linkHeader.split(', ');
           const nextLink = links.find(l => l.includes('rel="next"'));
           if (nextLink) {
             const match = nextLink.match(/<([^>]+)>/);
             if (match) {
               const fullUrl = match[1];
               const parsedUrl = new URL(fullUrl);
               url = '/orders.json' + parsedUrl.search;
             } else {
               hasNext = false;
             }
           } else {
             hasNext = false;
           }
        } else {
           hasNext = false;
        }
      } catch (err) {
         console.warn(`[fetchShopifyReturnedOrders] Could not fetch returns:`, err.message);
         return null;
      }
    }

    // Also fetch restocked ones if needed, but often refunded encompasses restocked.
    return returnedCount;
  });
}

module.exports = {
  calculateNetProfitPerProduct,
  calculateAndStoreAllProducts,
  buildDashboardMetrics,
  getOrdersByState,
  computeActualRtoRate,
  buildProductIntelligence,
  determinePrimaryCostDriver,
  fetchShopifyOrdersInRange,
  fetchShopifyReturnedOrdersInRange
};
