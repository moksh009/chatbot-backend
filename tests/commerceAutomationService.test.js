const assert = require('assert');
const service = require('../utils/commerceAutomationService');

function run() {
  assert.equal(service.normalizeEvent('fulfilled'), 'shipped');
  assert.equal(service.normalizeEvent('refunded'), 'cancelled');
  assert.equal(service.normalizeEvent('paid'), 'paid');

  const skuSimulation = service.simulateAutomation({
    automation: {
      triggerType: 'sku_event',
      event: 'paid',
      matchType: 'exact',
      sku: 'ABC-1',
    },
    order: {
      event: 'paid',
      items: [{ sku: 'ABC-1' }],
    },
  });
  assert.equal(skuSimulation.matched, true);

  const statusSimulation = service.simulateAutomation({
    automation: {
      triggerType: 'order_status',
      event: 'shipped',
    },
    order: {
      event: 'fulfilled',
    },
  });
  assert.equal(statusSimulation.matched, true);

  console.log('commerceAutomationService tests passed');
}

run();
