const Client = require('../models/Client');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');
const log = require('../utils/logger')('MigrationLogic');

/**
 * Reusable migration logic that can be called via CLI or Browser API
 */
async function runFullMigration() {
  try {
    const clients = await Client.find();
    let updatedCount = 0;
    const results = [];

    for (const client of clients) {
      let isModified = false;

      // 1. Seed simpleSettings if missing
      if (!client.simpleSettings || !client.simpleSettings.keywords) {
        client.simpleSettings = {
          keywords: [
            { word: 'hi',     action: 'restart_flow' },
            { word: 'hello',  action: 'restart_flow' },
            { word: 'order',  action: 'track_order'  },
            { word: 'cancel', action: 'cancel_flow'  },
            { word: 'human',  action: 'escalate'     }
          ],
          variableMap: {
            'name':     'lead.name',
            'total':    'order.totalPrice',
            'product':  'cart.productName'
          }
        };
        isModified = true;
      }

      // 2. Seed flowNodes and flowEdges if empty
      if (!client.flowNodes || client.flowNodes.length === 0) {
        const niche = client.niche || client.businessType || 'other';
        const defaultFlow = getDefaultFlowForNiche(niche);
        client.flowNodes = defaultFlow.nodes;
        client.flowEdges = defaultFlow.edges;
        isModified = true;
      }

      // 3. Seed automationFlows if missing
      if (!client.automationFlows || client.automationFlows.length === 0) {
        client.automationFlows = [
          { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
          { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
          { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
        ];
        isModified = true;
      }

      if (isModified) {
        await client.save();
        updatedCount++;
        results.push(`Migrated ${client.clientId}`);
      }
    }

    return { updatedCount, details: results };
  } catch (error) {
    log.error('Migration error:', error.message);
    throw error;
  }
}

module.exports = { runFullMigration };
