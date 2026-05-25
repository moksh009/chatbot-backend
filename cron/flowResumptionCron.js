"use strict";

const cron = require('node-cron');
const Conversation = require('../models/Conversation');
const AdLead = require('../models/AdLead');
const { executeNode, loadPublishedFlowByRef } = require('../utils/commerce/dualBrainEngine');
const { getCachedClient, DEFAULT_CLIENT_SELECT } = require('../utils/core/clientCache');
const log = require('../utils/core/logger')('FlowResumption');
const { wrapCron } = require('../utils/core/perfLogger');

module.exports = function scheduleFlowResumption() {
  // Default */2 reduces Mongo load; set FLOW_RESUMPTION_EVERY_MINUTE=true for * * * * *
  const expr =
    process.env.FLOW_RESUMPTION_EVERY_MINUTE === 'true' ? '* * * * *' : '*/2 * * * *';
  cron.schedule(expr, wrapCron('FlowResumption', async () => {
    const now = new Date();

    try {
      const pausedConvos = await Conversation.find({
        flowPausedUntil: { $lte: now },
        status: { $in: ['FLOW_PAUSED', 'DELAYED', 'BOT_ACTIVE'] },
      })
        .select('_id clientId phone activeFlowId pausedAtNodeId flowPausedUntil status')
        .limit(50)
        .lean();

      if (pausedConvos.length === 0) return;

      log.info(`⏰ Resuming ${pausedConvos.length} paused flow(s)...`);

      const uniqueClientIds = [...new Set(pausedConvos.map((c) => c.clientId).filter(Boolean))];
      const clientMap = new Map();
      await Promise.all(
        uniqueClientIds.map(async (cid) => {
          const doc = await getCachedClient(cid, DEFAULT_CLIENT_SELECT);
          if (doc) clientMap.set(cid, doc);
        })
      );

      const phonesByClient = {};
      for (const convo of pausedConvos) {
        if (!convo.clientId || !convo.phone) continue;
        if (!phonesByClient[convo.clientId]) phonesByClient[convo.clientId] = new Set();
        phonesByClient[convo.clientId].add(convo.phone);
      }

      const leadMap = new Map();
      await Promise.all(
        Object.entries(phonesByClient).map(async ([cid, phoneSet]) => {
          const phones = [...phoneSet];
          const leads = await AdLead.find({
            clientId: cid,
            phoneNumber: { $in: phones },
          })
            .select('phoneNumber clientId name email tags customFields')
            .lean();
          for (const lead of leads) {
            leadMap.set(`${cid}:${lead.phoneNumber}`, lead);
          }
        })
      );

      for (const convo of pausedConvos) {
        try {
          const client = clientMap.get(convo.clientId);
          if (!client) continue;

          const lead =
            leadMap.get(`${convo.clientId}:${convo.phone}`) ||
            (await AdLead.findOne({
              phoneNumber: convo.phone,
              clientId: convo.clientId,
            })
              .select('phoneNumber clientId name email tags customFields')
              .lean());

          const nodeId = convo.pausedAtNodeId;

          if (!nodeId) {
            await Conversation.findByIdAndUpdate(convo._id, {
              $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 },
              $set: { status: 'BOT_ACTIVE' },
            });
            continue;
          }

          let flowNodes = [];
          let flowEdges = [];
          if (convo.activeFlowId) {
            const flow = await loadPublishedFlowByRef(convo.clientId, String(convo.activeFlowId));
            if (flow?.nodes?.length) {
              flowNodes = flow.nodes;
              flowEdges = flow.edges || [];
            }
          }

          if (!flowNodes.length) {
            log.warn(`⚠️ No published flow for convo ${convo.phone} (flow ${convo.activeFlowId})`);
            await Conversation.findByIdAndUpdate(convo._id, {
              $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 },
              $set: { status: 'BOT_ACTIVE' },
            });
            continue;
          }

          await Conversation.findByIdAndUpdate(convo._id, {
            $unset: { flowPausedUntil: 1, pausedAtNodeId: 1 },
            $set: { status: 'BOT_ACTIVE' },
          });

          const nextEdge = flowEdges.find(
            (e) =>
              e.source === nodeId &&
              (!e.sourceHandle ||
                e.sourceHandle === 'a' ||
                e.sourceHandle === 'bottom' ||
                e.sourceHandle === 'out')
          );

          if (nextEdge) {
            log.info(`🚀 Resuming ${convo.phone} at node ${nextEdge.target}`);
            await executeNode(
              nextEdge.target,
              flowNodes,
              flowEdges,
              client,
              convo,
              lead,
              convo.phone,
              global.io
            );
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
  }));
};
