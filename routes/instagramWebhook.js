const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const { saveOmnichannelMessage } = require("../utils/omnichannel");
const { runDualBrainEngine } = require("../utils/dualBrainEngine");
const crypto = require("crypto");

// Middleware to verify Instagram Webhook signature (HMAC-SHA256)
const verifyInstagramSignature = async (req, res, buf) => {
  const signature = req.get("x-hub-signature-256");
  if (!signature) throw new Error("Missing X-Hub-Signature-256");

  const { clientId } = req.params;
  const client = await Client.findOne({ clientId });
  if (!client || !client.instagramAppSecret) return; // Allow bypass if not configured for legacy, or throw?

  const elements = signature.split("=");
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac("sha256", client.instagramAppSecret)
    .update(buf)
    .digest("hex");

  if (signatureHash !== expectedHash) {
    throw new Error("Invalid Webhook Signature");
  }
};

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
router.post("/:clientId/webhook/instagram", express.json({ verify: verifyInstagramSignature }), async (req, res) => {
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
        // Handle messages and postbacks
        if (event.message && !event.message.is_echo) {
            const parsedMessage = {
                from:      event.sender.id,
                profileName: "", // Can be fetched via Graph API if needed
                type:      "text",
                text:      { body: event.message.text || "" },
                messageId: event.message.mid,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        } else if (event.postback) {
            const parsedMessage = {
                from:      event.sender.id,
                type:      "interactive",
                interactive: {
                    type: "button_reply",
                    button_reply: { id: event.postback.payload, title: event.postback.title }
                },
                messageId: event.postback.mid || `pb_${event.timestamp}`,
                timestamp: event.timestamp,
                channel:   "instagram"
            };
            await runDualBrainEngine(parsedMessage, client);
        }
      }
    }
  } catch (err) {
    console.error("[Instagram Webhook] POST Error:", err.message);
  }
});

module.exports = router;
