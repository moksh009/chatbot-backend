"use strict";

const express           = require("express");
const router            = express.Router();
const Client            = require("../models/Client");
const User              = require("../models/User");
const Subscription      = require("../models/Subscription");
const { verifyToken }   = require("../middleware/auth");
const jwt               = require("jsonwebtoken");
const bcrypt            = require("bcryptjs");

// ─── Middleware: only resellers or super admins ──────────────────────────────
function requireReseller(req, res, next) {
  const userType = req.user?.userType || req.user?.role;
  if (userType === "reseller" || userType === "SUPER_ADMIN" || userType === "super_admin") {
    return next();
  }
  res.status(403).json({ success: false, message: "Reseller access required" });
}

// ─── GET /api/reseller/dashboard ────────────────────────────────────────────
router.get("/dashboard", verifyToken, requireReseller, async (req, res) => {
  try {
    const resellerId = req.user?.id;
    const clients    = await Client.find({ resellerUserId: resellerId }).lean();
    const clientIds  = clients.map(c => c._id);

    // Subscriptions for revenue calculation
    const subs = await Subscription.find({ clientId: { $in: clientIds } }).lean();
    const totalRevenue = subs.reduce((s, sub) => {
      const planPrices = { starter: 999, growth: 2999, enterprise: 7999 };
      return s + (planPrices[sub.plan] || 0);
    }, 0);

    // Count new clients this month
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const newThisMonth = clients.filter(c => new Date(c.createdAt) >= monthStart).length;

    // Plan distribution
    const planCounts = { starter: 0, growth: 0, enterprise: 0, trial: 0 };
    subs.forEach(s => { planCounts[s.plan] = (planCounts[s.plan] || 0) + 1; });

    // Recent activity (last 5 client updates)
    const recentClients = clients
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .slice(0, 5)
      .map(c => ({ clientId: c.clientId, businessName: c.businessName, lastActive: c.updatedAt || c.createdAt }));

    res.json({
      success: true,
      stats: {
        totalClients:    clients.length,
        activeClients:   clients.filter(c => c.isActive).length,
        totalRevenue,
        newClientsThisMonth: newThisMonth,
        clientsByPlan:   planCounts
      },
      recentActivity: recentClients
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/reseller/clients ───────────────────────────────────────────────
router.get("/clients", verifyToken, requireReseller, async (req, res) => {
  try {
    const resellerId = req.user?.id;
    const page       = parseInt(req.query.page) || 1;
    const limit      = parseInt(req.query.limit) || 20;
    const search     = req.query.search || "";

    const filter = { resellerUserId: resellerId };
    if (search) filter.businessName = { $regex: search, $options: "i" };

    const total   = await Client.countDocuments(filter);
    const clients = await Client.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Enrich with subscription info
    const enriched = await Promise.all(clients.map(async c => {
      const sub = await Subscription.findOne({ clientId: c._id }).lean();
      return { ...c, subscription: sub };
    }));

    res.json({ success: true, clients: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/reseller/clients — create sub-account ────────────────────────
router.post("/clients", verifyToken, requireReseller, async (req, res) => {
  try {
    const resellerId = req.user?.id;
    const { businessName, adminEmail, adminPhone, adminName, plan, sendWelcomeEmail } = req.body;

    if (!businessName || !adminEmail) {
      return res.status(400).json({ success: false, message: "businessName and adminEmail are required" });
    }

    // Generate unique client ID
    const clientId = businessName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") + "_" + Date.now().toString(36);

    // Create Client record
    const client = await Client.create({
      clientId,
      businessName,
      adminPhone:     adminPhone || "",
      resellerUserId: resellerId,
      resellerPlan:   plan || "starter",
      billedToReseller: true,
      isActive:       true
    });

    // Create admin User for this client
    const tempPassword = crypto_randomPassword();
    const user = await User.create({
      name:      adminName || businessName,
      email:     adminEmail,
      password:  tempPassword,
      role:      "CLIENT_ADMIN",
      userType:  "client",
      clientId
    });

    // Create Subscription
    await Subscription.create({
      clientId:        client._id,
      plan:            plan || "starter",
      status:          "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd:   new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });

    // Send welcome email if requested
    if (sendWelcomeEmail) {
      try {
        const { sendEmail } = require("../utils/emailService");
        await sendEmail({
          to:      adminEmail,
          subject: `Welcome to ${req.headers["x-product-name"] || "TopEdge AI"}!`,
          html:    `<p>Hi ${adminName || businessName},</p>
                    <p>Your account has been set up. Login with:</p>
                    <p><strong>Email:</strong> ${adminEmail}<br>
                    <strong>Temporary Password:</strong> ${tempPassword}</p>
                    <p>Please change your password on first login.</p>`
        });
      } catch { /* email failure shouldn't block account creation */ }
    }

    res.status(201).json({ success: true, client, message: "Client account created successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/reseller/clients/:clientId — update client ────────────────────
router.put("/clients/:clientId", verifyToken, requireReseller, async (req, res) => {
  try {
    const { businessName, resellerPlan, isActive } = req.body;
    const client = await Client.findOneAndUpdate(
      { clientId: req.params.clientId, resellerUserId: req.user?.id },
      { $set: { businessName, resellerPlan, isActive } },
      { new: true }
    );
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });
    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/reseller/clients/:clientId — deactivate ────────────────────
router.delete("/clients/:clientId", verifyToken, requireReseller, async (req, res) => {
  try {
    await Client.findOneAndUpdate(
      { clientId: req.params.clientId, resellerUserId: req.user?.id },
      { $set: { isActive: false, suspendedAt: new Date() } }
    );
    res.json({ success: true, message: "Client deactivated" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/reseller/clients/:clientId/login-as — impersonation ──────────
router.post("/clients/:clientId/login-as", verifyToken, requireReseller, async (req, res) => {
  try {
    const client = await Client.findOne({
      clientId:        req.params.clientId,
      resellerUserId:  req.user?.id
    }).lean();

    if (!client) return res.status(404).json({ success: false, message: "Client not found or not authorized" });

    // Get the client's admin user
    const clientUser = await User.findOne({ clientId: req.params.clientId, role: "CLIENT_ADMIN" }).lean();
    if (!clientUser) return res.status(404).json({ success: false, message: "Client admin user not found" });

    // Issue 15-minute impersonation token
    const impersonationToken = jwt.sign(
      {
        id:              clientUser._id,
        clientId:        req.params.clientId,
        role:            clientUser.role,
        email:           clientUser.email,
        isImpersonation: true,
        impersonatedBy:  req.user?.id
      },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    res.json({
      success: true,
      impersonationToken,
      clientName: client.businessName,
      clientId:   req.params.clientId,
      message:    "Impersonation token issued (expires in 15 minutes)"
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/reseller/clients/:clientId/stats ───────────────────────────────
router.get("/clients/:clientId/stats", verifyToken, requireReseller, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId }).lean();
    if (!client) return res.status(404).json({ success: false, message: "Not found" });

    const AdLead       = require("../models/AdLead");
    const Conversation = require("../models/Conversation");
    const Campaign     = require("../models/Campaign");

    const [totalLeads, totalConvos, totalCampaigns, sub] = await Promise.all([
      AdLead.countDocuments({ clientId: client._id }),
      Conversation.countDocuments({ clientId: req.params.clientId }),
      Campaign.countDocuments({ clientId: req.params.clientId }),
      Subscription.findOne({ clientId: client._id }).lean()
    ]);

    res.json({
      success: true,
      stats:   { totalLeads, totalConvos, totalCampaigns },
      subscription: sub
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Helper: generate temporary password
function crypto_randomPassword() {
  const crypto = require("crypto");
  return "Tmp" + crypto.randomBytes(5).toString("hex") + "!";
}

module.exports = router;
