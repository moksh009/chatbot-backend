"use strict";

const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const { executeNode } = require('../utils/dualBrainEngine');
const log = require('../utils/logger')('FlowResumption');

module.exports = function scheduleFlowResumption() {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    
    try {
      // Find all conversations where flow is paused and delay has expired
      const pausedConvos = await Conversation.find({
        flowPausedUntil: { $lte: now }
      });

      if (pausedConvos.length === 0) return;

      log.info(`⏰ Resuming ${pausedConvos.length} paused flow(s)...`);

      for (const convo of pausedConvos) {
        try {
          const client = await Client.findOne({ clientId: convo.clientId });
          if (!client) continue;

          const lead = await AdLead.findOne({ phoneNumber: convo.phone, clientId: convo.clientId });
          const nodeId = convo.pausedAtNodeId;
          
          if (!nodeId) {
            // If no stored node ID, we can't resume safely. Clear delay anyway.
            await Conversation.findByIdAndUpdate(convo._id, { $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 } });
            continue;
          }

          const flowNodes = client.flowNodes || [];
          const flowEdges = client.flowEdges || [];
          
          // Clear delay before resuming to prevent re-triggering by cron
          await Conversation.findByIdAndUpdate(convo._id, { $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 } });

          // Find the NEXT node to execute (from the Delay/Wait exit)
          const nextEdge = flowEdges.find(e => e.source === nodeId && (!e.sourceHandle || e.sourceHandle === 'a' || e.sourceHandle === 'bottom' || e.sourceHandle === 'out'));
          
          if (nextEdge) {
            log.info(`🚀 Resuming ${convo.phone} at node ${nextEdge.target}`);
            await executeNode(nextEdge.target, flowNodes, flowEdges, client, convo, lead, convo.phone, global.io);
          } else {
             log.warn(`⚠️ No outgoing edge found for delay node ${nodeId} in convo ${convo.phone}`);
          }

        } catch (err) {
          log.error(`❌ Error resuming convo ${convo._id}:`, err.message);
        }
      }
    } catch (err) {
      log.error(`❌ Flow Resumption Cron Error:`, err.message);
    }
  });
};
