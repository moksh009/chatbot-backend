'use strict';

const crypto = require('crypto');
const WhatsAppFlow = require('../../models/WhatsAppFlow');
const { PLAYBOOK_TEMPLATES } = require('../../constants/playbookTemplates');
const log = require('../../utils/core/logger')('PlaybookSeed');

function buildFlowDoc(clientId, tpl) {
  const flowId = `ppj_${tpl.playbookKey}_${clientId}`;
  return {
    clientId,
    flowId,
    name: tpl.name,
    status: 'DRAFT',
    flowType: 'post_purchase_journey',
    playbookKey: tpl.playbookKey,
    journeyTrigger: tpl.journeyTrigger,
    journeyPolicies: tpl.journeyPolicies,
    isAutomation: true,
    automationTrigger: tpl.journeyTrigger,
    nodes: [
      {
        id: 'start',
        type: 'send_template',
        data: {
          templateName: tpl.steps[0]?.templateName,
          body: tpl.steps[0]?.content,
        },
      },
    ],
    edges: [],
    triggerConfig: { type: 'EVENT', event: tpl.journeyTrigger },
  };
}

async function seedPlaybooksForClient(clientId) {
  let created = 0;
  for (const tpl of PLAYBOOK_TEMPLATES) {
    const flowId = `ppj_${tpl.playbookKey}_${clientId}`;
    const exists = await WhatsAppFlow.findOne({ clientId, playbookKey: tpl.playbookKey }).lean();
    if (exists) continue;
    const legacy = await WhatsAppFlow.findOne({ clientId, flowId }).lean();
    if (legacy) {
      await WhatsAppFlow.updateOne(
        { _id: legacy._id },
        {
          $set: {
            flowType: 'post_purchase_journey',
            playbookKey: tpl.playbookKey,
            journeyTrigger: tpl.journeyTrigger,
            journeyPolicies: tpl.journeyPolicies,
          },
        }
      );
      continue;
    }
    await WhatsAppFlow.create(buildFlowDoc(clientId, tpl));
    created += 1;
  }
  if (created) log.info(`Seeded ${created} playbooks for ${clientId}`);
  return created;
}

async function seedAllConnectedTenants() {
  const Client = require('../../models/Client');
  const clients = await Client.find({
    $or: [{ shopDomain: { $ne: '' } }, { 'shopifyStores.0': { $exists: true } }],
  })
    .select('clientId')
    .lean();
  let total = 0;
  for (const c of clients) {
    total += await seedPlaybooksForClient(c.clientId);
  }
  return total;
}

module.exports = { seedPlaybooksForClient, seedAllConnectedTenants, buildFlowDoc };
