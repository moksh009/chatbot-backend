const IntentRule = require('../models/IntentRule');
const Conversation = require('../models/Conversation');

/**
 * ActionExecutorService
 * The deterministic engine that maps detected intents to operational outcomes.
 */
class ActionExecutorService {
  /**
   * Orchestrates the execution of all actions associated with an intent.
   */
  async executeIntentActions(clientId, phoneNumber, intentName) {
    try {
      console.log(`[ActionExecutor] Executing actions for Intent: ${intentName} | Client: ${clientId}`);

      // 1. Fetch the active rule
      const rule = await IntentRule.findOne({
        clientId: clientId.toString(),
        intentName,
        isActive: true
      });

      if (!rule) {
        console.warn(`[ActionExecutor] No active rule found for intent: ${intentName}. Terminating.`);
        return;
      }

      // 2. Iterate through each configured action
      for (const action of rule.actions) {
        try {
          await this.handleAction(clientId, phoneNumber, action);
        } catch (actionError) {
          console.error(`[ActionExecutor] Individual action failure (${action.actionType}):`, actionError.message);
          // Continue to next action even if one fails
        }
      }

      console.log(`[ActionExecutor] Action execution cycle complete for ${intentName}`);
    } catch (error) {
      console.error(`[ActionExecutor] Execution error for ${intentName}:`, error);
    }
  }

  /**
   * Routes and executes specific action types using Mongoose queries and system calls.
   */
  async handleAction(clientId, phoneNumber, action) {
    const { actionType, payload } = action;

    switch (actionType) {
      case 'TAG_CHAT':
        // Update conversation: add unique tag using $addToSet
        await Conversation.updateOne(
          { clientId: clientId.toString(), phone: phoneNumber },
          { $addToSet: { tags: payload.tag } },
          { upsert: true }
        );
        console.log(`[ActionExecutor] TAG_CHAT: Added tag "${payload.tag}" to ${phoneNumber}`);
        break;

      case 'ASSIGN_AGENT':
        // Update conversation: assign to specific agent and update status
        await Conversation.updateOne(
          { clientId: clientId.toString(), phone: phoneNumber },
          { 
            $set: { 
              assignedTo: payload.agentId,
              status: 'HUMAN_TAKEOVER', // Transition to human for high-intent queries
              assignedAt: new Date()
            } 
          },
          { upsert: true }
        );
        console.log(`[ActionExecutor] ASSIGN_AGENT: Assigned ${phoneNumber} to agent ${payload.agentId}`);
        break;

      case 'PAUSE_BOT':
        // Update conversation: set status to PAUSED (added to enum in Task 1)
        // Also set botPaused boolean for backward compatibility
        await Conversation.updateOne(
          { clientId: clientId.toString(), phone: phoneNumber },
          { 
            $set: { 
              status: 'PAUSED',
              botPaused: true,
              isBotPaused: true
            } 
          },
          { upsert: true }
        );
        console.log(`[ActionExecutor] PAUSE_BOT: Automation suspended for ${phoneNumber}`);
        break;

      case 'SEND_TEMPLATE':
        // Placeholder for WhatsApp API call
        console.log(`[ActionExecutor] SEND_TEMPLATE: Sending ${payload.templateId} to ${phoneNumber}`);
        // whatsappApiService.sendTemplate(phoneNumber, payload.templateId);
        break;

      case 'NOTIFY_TEAM':
        // Notification logic (Socket.io or Admin Alert)
        console.log(`[ActionExecutor] NOTIFY_TEAM: Admin alert -> "${payload.message}"`);
        if (global.io) {
          global.io.to(`client_${clientId}`).emit('admin_notification', {
            type: 'INTENT_ACTION_TRIGGERED',
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
