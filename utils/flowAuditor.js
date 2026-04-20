"use strict";

const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const { validateFlowNode } = require('./validator');
const { getShopifyClient } = require('./shopifyHelper');
const log = require('./logger')('FlowAuditor');
const NotificationService = require('./notificationService');

/**
 * Scans a client's entire system for logic failures, broken links, 
 * and data-binding issues.
 */
async function auditClientSystem(clientId) {
  const audit = {
    clientId,
    timestamp: new Date(),
    healthScore: 100,
    criticalFailures: [],
    warnings: []
  };

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return null;

    // 1. Audit Flows
    const allNodesToCheck = [];
    if (client.flowNodes && Array.isArray(client.flowNodes)) {
      allNodesToCheck.push(...client.flowNodes);
    }
    if (client.visualFlows && Array.isArray(client.visualFlows)) {
      client.visualFlows.forEach(vf => {
        if (vf.nodes && Array.isArray(vf.nodes)) {
          allNodesToCheck.push(...vf.nodes);
        }
      });
    }

    for (const node of allNodesToCheck) {
      const { errors, warnings } = validateFlowNode(node, client);
      if (errors.length > 0) {
        audit.criticalFailures.push(...errors.map(e => ({ ...e, location: `Node: ${node.data?.label || node.id}` })));
        audit.healthScore -= (errors.length * 10);
      }
      if (warnings.length > 0) {
        audit.warnings.push(...warnings.map(w => ({ ...w, location: `Node: ${node.data?.label || node.id}` })));
      }
    }

    // 2. Variable Continuity Check
    const leadFields = Object.keys(AdLead.schema.paths);
    const flowText = JSON.stringify(allNodesToCheck || "");
    const variableMatches = flowText.match(/\{\{([^{}]+)\}\}/g) || [];
    
    variableMatches.forEach(tag => {
      const field = tag.replace(/\{\{|\}\}/g, '').split('.')[0];
      // Check if variable exists in Lead Schema or is a known system variable
      const systemVars = ['first_name', 'last_name', 'phone', 'full_name', 'order_id', 'agent_name'];
      if (!leadFields.includes(field) && !systemVars.includes(field)) {
         audit.warnings.push({
           code: 'GHOST_VARIABLE',
           message: `Variable ${tag} detected in flow but no data field exists for it.`,
           fix: 'Add this field to Lead Settings or ensure it is captured via a Capture Node first.'
         });
      }
    });

    // 3. Store Health
    if (client.storeType === 'shopify' && client.shopDomain) {
      try {
        await getShopifyClient(clientId);
      } catch (err) {
        audit.criticalFailures.push({
          code: 'SHOPIFY_AUTH_FAILED',
          message: 'Shopify API connection failed. Token might be invalid.',
          fix: 'Reconnect your Shopify store in Settings.'
        });
        audit.healthScore -= 30;
      }
    }

    // 4. Persistence & Notification
    audit.healthScore = Math.max(0, audit.healthScore);
    
    // If health drops below 80, emit a priority maintenance notification
    if (audit.healthScore < 80) {
      await NotificationService.createNotification(clientId, {
        type: 'alert',
        title: 'System Health Alert ⚠️',
        message: `Your system health score is ${audit.healthScore}%. ${audit.criticalFailures.length} critical issues detected in your flows.`,
        priority: 'high',
        actionUrl: '/settings/health'
      });
    }

    return audit;
  } catch (err) {
    log.error('Audit failed:', err.message);
    return null;
  }
}

module.exports = { auditClientSystem };
