const log = require('../utils/core/logger')('Phase3Workers');
const { startCampaignDispatchWorker } = require('./campaignDispatchWorker');
const { startSequenceDispatchWorker } = require('./sequenceDispatchWorker');
const { startDispatchMaintenanceWorker } = require('./dispatchMaintenanceWorker');
const { startWebhookDeliveryWorker } = require('./webhookDeliveryWorker');
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
  return { campaign, sequence, maintenance, webhook };
}

module.exports = { startPhase3Workers };
