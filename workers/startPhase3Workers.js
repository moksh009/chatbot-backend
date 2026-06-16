const log = require('../utils/core/logger')('Phase3Workers');
const { startCampaignDispatchWorker } = require('./campaignDispatchWorker');
const { startSequenceDispatchWorker } = require('./sequenceDispatchWorker');
const { startDispatchMaintenanceWorker } = require('./dispatchMaintenanceWorker');
const { startWebhookDeliveryWorker } = require('./webhookDeliveryWorker');
const { startInventoryShopifyPushWorker } = require('./inventoryShopifyPushWorker');
const { startInventoryAmazonPushWorker } = require('./inventoryAmazonPushWorker');
const { startAmazonInventorySyncWorker } = require('./amazonInventorySyncWorker');
const { startSignupWelcomeWorker } = require('./signupWelcomeWorker');
const { ensureMaintenanceRepeatable } = require('../utils/messaging/queues/maintenanceQueue');

function startPhase3Workers() {
  if (process.env.PHASE3_DISPATCH_ENABLED === 'false') {
    log.info('PHASE3_DISPATCH_ENABLED=false — skipping Phase 3 workers');
    return { campaign: null, sequence: null, maintenance: null };
  }
  ensureMaintenanceRepeatable().catch((e) => log.warn(`Maintenance schedule: ${e.message}`));
  const campaign = startCampaignDispatchWorker();
  const sequence = startSequenceDispatchWorker();
  const maintenance = startDispatchMaintenanceWorker();
  const webhook = startWebhookDeliveryWorker();
  const inventoryPush = startInventoryShopifyPushWorker();
  const inventoryAmazonPush = startInventoryAmazonPushWorker();
  const amazonInventoryPull = startAmazonInventorySyncWorker();
  const signupWelcome = startSignupWelcomeWorker();
  let inboundEngine = null;
  try {
    const { startInboundEngineWorker } = require('../utils/messaging/inboundEngineQueue');
    inboundEngine = startInboundEngineWorker();
  } catch (e) {
    log.warn(`Inbound engine worker: ${e.message}`);
  }
  return {
    campaign,
    sequence,
    maintenance,
    webhook,
    inventoryPush,
    inventoryAmazonPush,
    amazonInventoryPull,
    signupWelcome,
    inboundEngine,
  };
}

module.exports = { startPhase3Workers };
