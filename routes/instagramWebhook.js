const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const { saveOmnichannelMessage } = require("../utils/omnichannel");

/**
 * Verification handshake for Instagram Messenger API
 */
router.get("/:clientId/webhook/instagram", async (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.sendStatus(404);

    // Reuse the same verify token as WhatsApp for simplicity (or let it be defined in Client)
    const clientVerifyToken = client.verifyToken || "topedge_ai_handshake";

    if (mode === "subscribe" && token === clientVerifyToken) {
      console.log(`[Instagram Webhook] Verified for client: ${client.clientId}`);
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  } catch (err) {
    console.error("[Instagram Webhook] GET Error:", err.message);
    res.sendStatus(500);
  }
});

/**
 * Handle incoming Instagram DM events
 */
router.post("/:clientId/webhook/instagram", async (req, res) => {
  // Always acknowledge immediately per Meta requirements
  res.sendStatus(200);
  
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client?.instagramConnected) return;
    
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        // Skip delivery receipts, only handle messages
        if (!event.message || event.message.is_echo) continue;
        
        // Normalize to standard parsed message format
        const parsedMessage = {
          from:      event.sender.id,   // Instagram PSID
          type:      "text",
          text:      { body: event.message.text || "" },
          messageId: event.message.mid,
          timestamp: event.timestamp,
          channel:   "instagram"
        };
        
        // Save to DB and update Conversation state
        // Bot automation for Instagram is disabled in Phase 13 (human only)
        await saveOmnichannelMessage(parsedMessage, client, "instagram");
        
        console.log(`[Instagram Webhook] Message from ${parsedMessage.from} for ${clientId}`);
      }
    }
  } catch (err) {
    console.error("[Instagram Webhook] POST Error:", err.message);
  }
});

module.exports = router;
