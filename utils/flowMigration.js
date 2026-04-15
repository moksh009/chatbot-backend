"use strict";

const WhatsAppFlow = require("../models/WhatsAppFlow");
const Client = require("../models/Client");

/**
 * MIGRATION UTILITY
 * Moves legacy visualFlows and flowNodes from Client model to WhatsAppFlow model.
 */
async function migrateClientFlows(clientId) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error(`Client ${clientId} not found`);

  console.log(`[FlowMigration] Starting migration for ${clientId}...`);

  const results = {
    migrated: 0,
    errors: 0
  };

  // 1. Process visualFlows (multiple flows)
  const visualFlows = client.visualFlows || [];
  for (const flow of visualFlows) {
    try {
      const flowId = flow.id || `f_${Math.random().toString(36).substr(2, 9)}`;
      
      const existing = await WhatsAppFlow.findOne({ flowId });
      if (existing) {
        console.log(`[FlowMigration] Skipping existing flow ${flowId}`);
        continue;
      }

      await WhatsAppFlow.create({
        clientId: client.clientId,
        flowId: flowId,
        name: flow.name || "Unnamed Flow",
        status: flow.isActive ? 'PUBLISHED' : 'DRAFT',
        nodes: flow.nodes || [],
        edges: flow.edges || [],
        publishedNodes: flow.isActive ? (flow.nodes || []) : [],
        publishedEdges: flow.isActive ? (flow.edges || []) : [],
        categories: flow.categories || [],
        description: flow.description || "",
        version: 1
      });
      results.migrated++;
    } catch (err) {
      console.error(`[FlowMigration] Error migrating flow ${flow.id}:`, err.message);
      results.errors++;
    }
  }

  // 2. Process legacy flowNodes/flowEdges (single global flow if any)
  if (client.flowNodes?.length > 0 && !visualFlows.some(f => f.isPrimary)) {
    try {
      const flowId = `legacy_${client.clientId}`;
      const existing = await WhatsAppFlow.findOne({ flowId });
      
      if (!existing) {
        await WhatsAppFlow.create({
          clientId: client.clientId,
          flowId: flowId,
          name: "Main Canvas Flow",
          status: 'PUBLISHED',
          nodes: client.flowNodes,
          edges: client.flowEdges,
          publishedNodes: client.flowNodes,
          publishedEdges: client.flowEdges,
          version: 1,
          description: "Auto-migrated from legacy global canvas"
        });
        results.migrated++;
      }
    } catch (err) {
      console.error(`[FlowMigration] Error migrating legacy canvas:`, err.message);
      results.errors++;
    }
  }

  // 3. Mark client as migrated
  await Client.updateOne(
    { clientId },
    { $set: { flowMigrationStatus: results.errors === 0 ? 'completed' : 'failed' } }
  );

  console.log(`[FlowMigration] Completed for ${clientId}: ${results.migrated} migrated, ${results.errors} errors.`);
  return results;
}

module.exports = { migrateClientFlows };
