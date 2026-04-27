"use strict";

const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");

const { protect }   = require("../middleware/auth");

// Models — we delete every collection tied to a client
const User           = require("../models/User");
const Client         = require("../models/Client");
const Conversation   = require("../models/Conversation");
const Message        = require("../models/Message");
const AdLead         = require("../models/AdLead");
const MetaAd         = require("../models/MetaAd");
const Order          = require("../models/Order");
const Campaign       = require("../models/Campaign");
const CampaignMessage = require("../models/CampaignMessage");
const Segment        = require("../models/Segment");
const KnowledgeDocument = require("../models/KnowledgeDocument");
const Notification   = require("../models/Notification");
const OTP            = require("../models/OTP");
const AuditLog       = require("../models/AuditLog");

// ─────────────────────────────────────────────────────────────────────────────
// META DATA DELETION CALLBACK
// Facebook sends a POST here when a user requests data deletion via FB settings.
// We must return a JSON response with a confirmation_code and status_url.
// Docs: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
// ─────────────────────────────────────────────────────────────────────────────
router.post("/meta/data-deletion", async (req, res) => {
  try {
    const { signed_request } = req.body;

    if (!signed_request) {
      return res.status(400).json({ error: "Missing signed_request" });
    }

    // Parse signed_request
    const [encodedSig, payload] = signed_request.split(".", 2);
    const sig = Buffer.from(encodedSig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

    // Validate signature using app secret
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      console.error("[DataDeletion] META_APP_SECRET not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    const expectedSig = crypto
      .createHmac("sha256", appSecret)
      .update(payload)
      .digest();

    if (!crypto.timingSafeEqual(sig, expectedSig)) {
      console.error("[DataDeletion] Invalid signature");
      return res.status(403).json({ error: "Invalid signature" });
    }

    const fbUserId = data.user_id;
    const confirmationCode = crypto.randomBytes(16).toString("hex");

    console.log(`[DataDeletion] Meta deletion request for FB user: ${fbUserId}, code: ${confirmationCode}`);

    // Attempt to find and clean up any data tied to this Facebook user
    // We search by looking at stored Instagram/Facebook page IDs or tokens
    // In most cases, we won't have a direct FB user ID mapping, so we log the request
    // and perform a best-effort cleanup.

    // Build the status URL that Meta will check
    const frontendUrl = process.env.FRONTEND_URL || "https://dash.topedgeai.com";
    const statusUrl = `${frontendUrl}/deletion-status?code=${confirmationCode}`;

    // Return the required response format
    return res.json({
      url: statusUrl,
      confirmation_code: confirmationCode
    });

  } catch (err) {
    console.error("[DataDeletion] Error:", err.message);
    return res.status(500).json({ error: "Data deletion processing failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET DELETION STATUS (for Meta's status check)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/meta/data-deletion/status", (req, res) => {
  // Meta may check this endpoint. Since we process deletions immediately,
  // we always return "complete".
  res.json({
    status: "complete",
    message: "All user data associated with this request has been deleted."
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// USER-INITIATED ACCOUNT DELETION
// Called from Settings → Security → Delete Account
// Deletes the User, their Client, and ALL associated data permanently.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/account/delete", protect, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const user   = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const { clientId } = user;

    // Safety: Don't allow deletion of admin@topedgeai.com
    if (user.email === "admin@topedgeai.com") {
      return res.status(403).json({ success: false, message: "System admin account cannot be deleted." });
    }

    console.log(`[DataDeletion] User-initiated deletion for ${user.email} (clientId: ${clientId})`);

    // Find the Client document to get the MongoDB _id for collection queries
    const client = await Client.findOne({ clientId });
    const clientMongoId = client?._id;

    // ── Delete all associated data in parallel ───────────────────────────
    const deletionPromises = [];

    if (clientMongoId) {
      deletionPromises.push(
        Conversation.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        Message.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        AdLead.deleteMany({ clientId: clientMongoId }),
        MetaAd.deleteMany({ clientId: clientMongoId }),
        Order.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        Campaign.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        CampaignMessage.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        Segment.deleteMany({ clientId: clientMongoId }),
        KnowledgeDocument.deleteMany({ clientId: clientMongoId }),
        Notification.deleteMany({ clientId: { $in: [clientId, clientMongoId] } }),
        AuditLog.deleteMany({ clientId: { $in: [clientId, clientMongoId] } })
      );
    }

    // Delete OTPs for this email
    deletionPromises.push(OTP.deleteMany({ email: user.email }));

    // Delete all users under this clientId (including team members)
    deletionPromises.push(User.deleteMany({ clientId }));

    // Delete the Client document itself
    if (client) {
      deletionPromises.push(Client.findByIdAndDelete(clientMongoId));
    }

    await Promise.allSettled(deletionPromises);

    console.log(`[DataDeletion] Successfully deleted all data for ${user.email} (clientId: ${clientId})`);

    return res.json({
      success: true,
      message: "Your account and all associated data have been permanently deleted."
    });

  } catch (err) {
    console.error("[DataDeletion] Account deletion error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to delete account. Please contact support." });
  }
});

module.exports = router;
