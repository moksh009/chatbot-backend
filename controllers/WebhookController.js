const MessageBufferService = require('../services/MessageBufferService');

/**
 * Controller for handling incoming Meta/WhatsApp webhooks.
 * Designed for maximum throughput and reliability.
 */
exports.handleWhatsAppWebhook = async (req, res) => {
  try {
    // 1. Instantly respond to Meta with 200 OK/SUCCESS
    // This prevents Meta from assuming our server is down and retrying/duplicating messages.
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    // 2. Validate it's a message event
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message && message.type === 'text') {
        const incomingText = message.text.body;
        const phoneNumber = message.from;
        const clientId = req.query.clientId || value?.metadata?.display_phone_number; // Or derived from business_id mapping

        // 3. Asynchronously offload to the Redis buffer
        // Note: In production, you'd match metaId/business_id to our internal clientId
        if (clientId) {
          MessageBufferService.ingestWebhookMessage(clientId, phoneNumber, incomingText)
            .catch(err => console.error('[WebhookController] Buffer Error:', err));
        }
      }
    }
  } catch (error) {
    // Even if it fails internally, we already sent the 200 OK. 
    // We log for debugging but don't crash the response loop.
    console.error('[WebhookController] Critical Failure:', error);
  }
};
