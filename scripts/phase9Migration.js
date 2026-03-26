require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');

const processMigrate = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    const clients = await Client.find();
    let updatedCount = 0;

    for (const client of clients) {
      let isModified = false;

      // 1. Seed simpleSettings if missing
      if (!client.simpleSettings) {
        client.simpleSettings = {
          openaiApiKey: client.openaiApiKey || client.config?.openaiApiKey || '',
          geminiApiKey: client.geminiApiKey || client.config?.geminiApiKey || '',
          keywordFallbacks: [],
          variableMap: {},
          offlineMessage: 'We are currently offline. Please leave a message.',
          humanTakeoverKeyword: 'speak to human'
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
        console.log(`✅ Migrated Phase 9 fields for Client: ${client.clientId}`);
      } else {
        console.log(`ℹ️ Client: ${client.clientId} is already up to date.`);
      }
    }

    console.log(`\n🎉 Migration complete. Updated ${updatedCount} clients.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
};

processMigrate();
