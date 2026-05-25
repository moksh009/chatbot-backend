'use strict';

const cron = require('node-cron');
const AdLead = require('../models/AdLead');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const { enrollWinBackForLead } = require('../services/postPurchaseJourneys/enroll');
const log = require('../utils/core/logger')('WinBackCron');
const { wrapCron } = require('../utils/core/perfLogger');

async function runWinBackTick() {
  const flows = await WhatsAppFlow.find({
    flowType: 'post_purchase_journey',
    playbookKey: 'win_back',
    journeyTrigger: 'win_back_inactive',
    status: 'PUBLISHED',
  }).lean();

  if (!flows.length) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);

  let enrolled = 0;
  const byClient = flows.reduce((acc, f) => {
    (acc[f.clientId] = acc[f.clientId] || []).push(f);
    return acc;
  }, {});

  for (const [clientId, clientFlows] of Object.entries(byClient)) {
    const leads = await AdLead.find({
      clientId,
      isOrderPlaced: true,
      lastOrderAt: { $lt: cutoff },
      optedOut: { $ne: true },
    })
      .limit(200)
      .lean();

    const Client = require('../models/Client');
    const client = await Client.findOne({ clientId }).lean();
    if (!client) continue;

    for (const lead of leads) {
      for (const flow of clientFlows) {
        const r = await enrollWinBackForLead({ client, lead, flow });
        if (r.enrolled) enrolled += 1;
      }
    }
  }

  return enrolled;
}

function registerWinBackCron() {
  cron.schedule(
    '0 4 * * *',
    wrapCron('win_back_enrollment', async () => {
      const n = await runWinBackTick();
      if (n) log.info(`Win-back enrolled: ${n}`);
    }),
    { timezone: 'Asia/Kolkata' }
  );
}

module.exports = { registerWinBackCron, runWinBackTick };
