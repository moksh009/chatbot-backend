const IntentRule = require('../models/IntentRule');
const Conversation = require('../models/Conversation');
const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');

class ActionExecutorService {
  /**
   * Core engine that executes deterministic actions mapped to an intent.
   */
  async executeIntentActions(clientId, phoneNumber, intentName) {
    try {
      console.log(`[ActionExecutor] Executing actions for ${intentName} (${phoneNumber})`);

      // 1. Find the active rule for this intent
      const rule = await IntentRule.findOne({
        clientId,
        intentName,
        isActive: true
      });

      if (!rule) {
        console.warn(`[ActionExecutor] No active rule found for intent: ${intentName}`);
        return;
      }

      // 2. Iterate and execute each action
      for (const action of rule.actions) {
        await this.handleAction(clientId, phoneNumber, action);
      }

      console.log(`[ActionExecutor] All actions completed for ${intentName}`);
    } catch (error) {
      console.error('[ActionExecutor] Execution error:', error);
    }
  }

  /**
   * Individual action handler switch
   */
  async handleAction(clientId, phoneNumber, action) {
    const { actionType, payload } = action;

    switch (actionType) {
      case 'TAG_CHAT':
        await Conversation.updateOne(
          { clientId, phone: phoneNumber },
          { $addToSet: { tags: payload.tag } },
          { upsert: true }
        );
        console.log(`[ActionExecutor] Added tag "${payload.tag}" to ${phoneNumber}`);
        break;

      case 'ASSIGN_AGENT':
        await Conversation.updateOne(
          { clientId, phone: phoneNumber },
          { 
            $set: { 
              assignedTo: payload.agentId,
              status: 'HUMAN_TAKEOVER',
              assignedAt: new Date()
            } 
          },
          { upsert: true }
        );
        console.log(`[ActionExecutor] Assigned ${phoneNumber} to agent ${payload.agentId}`);
        break;

      case 'PAUSE_BOT':
        await Conversation.updateOne(
          { clientId, phone: phoneNumber },
          { $set: { botPaused: true, isBotPaused: true } },
          { upsert: true }
        );
        console.log(`[ActionExecutor] Bot paused for ${phoneNumber}`);
        break;

      case 'SEND_TEMPLATE':
        // Assuming we have a helper to send WhatsApp templates
        try {
          // You might need to fetch client credentials (token, phoneId) here or pass them in
          // For now using placeholder logic similar to existing helpers
          console.log(`[ActionExecutor] Sending template ${payload.templateId} to ${phoneNumber}`);
          // await sendWhatsAppTemplate({ to: phoneNumber, templateName: payload.templateId, ... });
        } catch (err) {
          console.error('[ActionExecutor] SendTemplate error:', err);
        }
        break;

      case 'NOTIFY_TEAM':
        console.log(`[TEAM_NOTIFICATION] Client: ${clientId} | Message: ${payload.message}`);
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('admin_notification', {
            type: 'INTENT_TRIGGERED',
            message: payload.message,
            phoneNumber
          });
        }
        break;

      default:
        console.warn(`[ActionExecutor] Unknown action type: ${actionType}`);
    }
  }
}

module.exports = new ActionExecutorService();
