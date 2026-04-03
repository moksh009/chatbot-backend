const express = require("express");
const router = express.Router();
const Client = require("../models/Client");
const { saveOmnichannelMessage } = require("../utils/omnichannel");
const { runDualBrainEngine } = require("../utils/dualBrainEngine");
const { replyToInstagramComment, sendInstagramDM } = require("../utils/instagramApi");
const InstagramAutomation = require("../models/InstagramAutomation");
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

      // Handle comments and post changes
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === "comments") {
          await handleInstagramComment(change.value, client);
        }
      }
    }
  } catch (err) {
    console.error("[Instagram Webhook] POST Error:", err.message);
  }
});

/**
 * Process Instagram Comments to match ManyChat style triggers
 */
async function handleInstagramComment(commentData, client) {
  try {
    const { id: commentId, text, from, media } = commentData;
    if (!commentId || !from || !media || !text) return;
    
    // Ignore our own comments/replies
    if (from.id === client.instagramPageId) return;

    // Find active comment automations
    const automations = await InstagramAutomation.find({
      clientId: client.clientId,
      isActive: true,
      "trigger.type": "comment"
    });

    if (!automations || automations.length === 0) return;

    for (const auto of automations) {
      // 1. Post Match Check
      let postMatch = false;
      if (auto.trigger.postType === "any_post") {
        postMatch = true;
      } else if (auto.trigger.posts && auto.trigger.posts.some(p => p.postId === media.id)) {
        postMatch = true;
      }
      if (!postMatch) continue;

      // 2. Keyword Match Check
      let keywordMatch = false;
      if (auto.trigger.matchAny) {
        keywordMatch = true;
      } else if (auto.trigger.keywords && auto.trigger.keywords.length > 0) {
        const commentLower = text.toLowerCase();
        keywordMatch = auto.trigger.keywords.some(kw => commentLower.includes(kw.toLowerCase()));
      }
      if (!keywordMatch) continue;

      // 3. Prevent Duplicates (check sentLogs)
      const alreadySent = auto.sentLogs && auto.sentLogs.some(log => log.facebookId === from.id && log.postId === media.id);
      if (alreadySent) continue;

      // Ensure access token is valid
      if (!client.instagramAccessToken) {
          console.warn(`[IG Auto] No access token for client ${client.clientId}`);
          break;
      }

      // --- MATCH FOUND --- Execute Actions!

      // Update sent logs instantly to prevent race conditions
      await InstagramAutomation.findByIdAndUpdate(auto._id, {
        $inc: { "stats.totalSends": 1, "stats.uniqueSends": 1 },
        $push: { sentLogs: { facebookId: from.id, postId: media.id, sentAt: new Date() } }
      });

      console.log(`[IG Auto] Triggering comment automation '${auto.name}' for user ${from.id}`);

      // ACTION 1: Public Reply
      if (auto.actions.publicReply?.enabled && auto.actions.publicReply?.messages?.length > 0) {
        const replies = auto.actions.publicReply.messages;
        const randomReply = replies[Math.floor(Math.random() * replies.length)];
        try {
          await replyToInstagramComment(commentId, randomReply, client.instagramAccessToken);
        } catch (e) {
          console.error(`[IG Auto] Public reply failed:`, e.message);
        }
      }

      // ACTION 2: Send DM
      if (auto.actions.dmFlow?.enabled && auto.actions.dmFlow?.openingDm?.text) {
        try {
          const dmText = auto.actions.dmFlow.openingDm.text;
          const buttons = auto.actions.dmFlow.openingDm.buttons || [];
          // Pre-populate buttons with sendLink if enabled
          if (auto.actions.dmFlow.sendLink?.enabled && auto.actions.dmFlow.sendLink?.url) {
              buttons.push({ 
                  title: auto.actions.dmFlow.sendLink.buttonText || "View Link", 
                  url: auto.actions.dmFlow.sendLink.url 
              });
          }
          await sendInstagramDM(from.id, { text: dmText, buttons }, client.instagramAccessToken);
        } catch (e) {
          console.error(`[IG Auto] Send DM failed:`, e.message);
        }
      }
    }
  } catch (error) {
    console.error("[IG Auto] Error handling comment:", error.message);
  }
}

module.exports = router;
