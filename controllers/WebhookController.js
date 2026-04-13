const MessageBufferService = require('../services/MessageBufferService');

/**
 * WebhookController
 * Handles incoming WhatsApp messages from Meta's Cloud API.
 * High-throughput, asynchronous architecture to satisfy Meta's performance requirements.
 */
exports.handleWhatsAppWebhook = async (req, res) => {
  try {
    /**
     * CRITICAL ARCHITECTURE RULE: 
     * We must respond to Meta with a 200 OK status code IMMEDIATELY.
     * Meta retries webhooks if the response takes longer than 5 seconds,
     * which would result in duplicate processing and resource waste.
     */
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    // 1. Root level validation
    if (body.object !== 'whatsapp_business_account') {
      return;
    }

    // 2. Extract nested message details from Meta's complex payload structure
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Only process text-based messages for the Intent Engine
    if (message && message.type === 'text') {
      const incomingText = message.text.body;
      const phoneNumber = message.from;
      
      /**
       * Resolve clientId: 
       * Typically mappings are stored in the database linking Meta's phone_number_id/waba_id to our clientId.
       * For this implementation, we allow it from query or metadata fallback.
       */
      const clientId = req.query.clientId || value?.metadata?.display_phone_number;

      if (!clientId) {
        console.warn(`[Webhook] Message received for ${phoneNumber} but no clientId could be resolved.`);
        return;
      }

      /**
       * 3. ASYNCHRONOUSLY offload to the Redis buffer.
       * This triggers the 10-second sliding window for aggregation.
       */
      MessageBufferService.ingestWebhookMessage(clientId, phoneNumber, incomingText)
        .catch(err => console.error('[Webhook] Async Buffer Ingestion Error:', err));
      
      console.log(`[Webhook] Successfully handed off message from ${phoneNumber} to BufferService.`);
    }

  } catch (error) {
    /**
     * Even if processing fails, we don't send an error response here 
     * because we've already closed the request with a 200 OK.
     */
    console.error('[Webhook] Critical Failure in Controller:', error);
  }
};
