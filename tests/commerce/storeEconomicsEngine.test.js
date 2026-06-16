'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateNetProfitPerProduct,
  lineItemEconomicsContribution,
} = require('../../utils/commerce/storeEconomicsEngine');

const baseConfig = {
  cacPerCustomer: 100,
  deliveryCostPerOrder: 50,
  packagingMode: 'uniform',
  uniformPackagingCost: 20,
  gatewayFeeRate: 0.02,
  shopifyTransactionFeeRate: 0.02,
  codAccepted: false,
  prepaidRtoRate: 0.1,
  unacceptedOrderLossPerOrder: 200,
  fixedOverheadsPerOrder: 30,
  gstEnabled: false,
};

const product = {
  shopifyProductId: 'p1',
  sellingPrice: 1000,
  cogs: 400,
  packagingCost: 20,
};

test('lineItemEconomicsContribution excludes order-level CAC and delivery', () => {
  const { itemRevenue, cogs, packaging, gatewayAndShopify } = lineItemEconomicsContribution(
    { productId: 'p1', quantity: 2, price: 1000 },
    product,
    baseConfig
  );

  assert.equal(itemRevenue, 2000);
  assert.equal(cogs, 800);
  assert.equal(packaging, 40);
  assert.ok(Math.abs(gatewayAndShopify - 80) < 0.001);
});

test('dashboard waterfall math stays consistent for multi-line orders', () => {
  const orders = [
    {
      totalPrice: 3000,
      items: [
        { productId: 'p1', quantity: 1, price: 1000 },
        { productId: 'p1', quantity: 1, price: 1000 },
      ],
    },
    {
      totalPrice: 1000,
      items: [{ productId: 'p1', quantity: 1, price: 1000 }],
    },
  ];

  let totalGrossRevenue = 0;
  let totalCogs = 0;
  let totalPackagingCost = 0;
  let totalGatewayAndShopifyFees = 0;
  let totalCac = 0;
  let totalShippingCost = 0;
  const totalOrderCount = orders.length;

  for (const order of orders) {
    totalCac += baseConfig.cacPerCustomer;
    totalShippingCost += baseConfig.deliveryCostPerOrder;

    let matchedLineRevenue = 0;
    for (const lineItem of order.items) {
      const { itemRevenue, cogs, packaging, gatewayAndShopify } = lineItemEconomicsContribution(
        lineItem,
        product,
        baseConfig
      );
      matchedLineRevenue += itemRevenue;
      totalCogs += cogs;
      totalPackagingCost += packaging;
      totalGatewayAndShopifyFees += gatewayAndShopify;
    }
    totalGrossRevenue += matchedLineRevenue;
  }

  const totalRtoLoss = totalOrderCount * baseConfig.prepaidRtoRate * baseConfig.unacceptedOrderLossPerOrder;
  const totalFixedOverheads = totalOrderCount * baseConfig.fixedOverheadsPerOrder;

  const operatingProfitBeforeRto = totalGrossRevenue
    - totalCogs
    - totalCac
    - totalPackagingCost
    - totalShippingCost
    - totalGatewayAndShopifyFees;
  const trueNetProfit = operatingProfitBeforeRto - totalRtoLoss - totalFixedOverheads;
  const waterfallSum = operatingProfitBeforeRto - totalRtoLoss - totalFixedOverheads;

  const legacyProductNetProfit = orders.reduce((sum, order) => {
    return sum + order.items.reduce((lineSum, lineItem) => {
      const { netProfit } = calculateNetProfitPerProduct(product, baseConfig);
      return lineSum + netProfit * lineItem.quantity;
    }, 0);
  }, 0) - totalRtoLoss - totalFixedOverheads;

  assert.ok(Math.abs(trueNetProfit - waterfallSum) < 0.01);
  assert.ok(Math.abs(trueNetProfit - legacyProductNetProfit) > 1);
});
