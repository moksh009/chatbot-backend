"use strict";

const express = require("express");
const router  = express.Router();
const Client  = require("../models/Client");
const { protect } = require("../middleware/auth");
const { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates } = require("../utils/flowGenerator");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/complete
// Called when user clicks Launch in Step 10 of the onboarding wizard
// Generates the flow, saves it, marks wizard as complete
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/complete", protect, async (req, res) => {
  const { clientId } = req.params;
  const { wizardData } = req.body;

  if (!wizardData) return res.status(400).json({ error: "wizardData is required" });

  try {
    // Security: ensure user can only complete their own client's wizard
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    console.log(`[Wizard] Starting flow generation for ${clientId}...`);

    // Generate the complete flow
    const { nodes, edges } = await generateEcommerceFlow(client, wizardData);

    // Generate system prompt
    const systemPrompt = await generateSystemPrompt(client, wizardData);

    // Build the new flow object
    const newFlow = {
      id:          `flow_wizard_${Date.now()}`,
      name:        `${wizardData.businessName || client.name} — Main Flow`,
      platform:    "whatsapp",
      isActive:    true,
      folderId:    "",
      nodes,
      edges,
      createdAt:   new Date(),
      updatedAt:   new Date(),
      generatedBy: "wizard"
    };

    // Update the client document:
    // 1. Mark wizard as complete
    // 2. SET the business/bot settings (last-one-wins from wizard)
    // 3. PUSH the new flow into visualFlows (so they keeping growing a list)
    // 4. SET flowNodes/flowEdges to the newest one (for legacy engine support)
    
    const settingsUpdate = {
      wizardCompleted:    true,
      wizardCompletedAt:  new Date(),
      isAIFallbackEnabled: true,
      ...(wizardData.replaceExisting !== false && { 
        flowNodes: nodes, 
        flowEdges: edges 
      }),
      ...(wizardData.businessName    && { businessName: wizardData.businessName, name: wizardData.businessName }),
      ...(wizardData.botName         && { "nicheData.botName": wizardData.botName }),
      ...(wizardData.googleReviewUrl && { googleReviewUrl: wizardData.googleReviewUrl }),
      ...(systemPrompt               && { systemPrompt }),
      ...(wizardData.razorpayKeyId    && { razorpayKeyId: wizardData.razorpayKeyId }),
      ...(wizardData.razorpaySecret   && { razorpaySecret: wizardData.razorpaySecret }),
      ...(wizardData.cashfreeAppId    && { cashfreeAppId: wizardData.cashfreeAppId }),
      ...(wizardData.cashfreeSecretKey && { cashfreeSecretKey: wizardData.cashfreeSecretKey }),
      ...(wizardData.activePaymentGateway && { activePaymentGateway: wizardData.activePaymentGateway }),
      ...(wizardData.adminPhone       && { adminPhone: wizardData.adminPhone }),
      ...(wizardData.cartTiming && {
        "automationFlows": [
          {
            id:     "abandoned_cart",
            type:   "abandoned_cart",
            active: true,
            config: {
              delayMinutes1: wizardData.cartTiming.msg1 || 15,
              delayHours2:   wizardData.cartTiming.msg2 || 2,
              delayHours3:   wizardData.cartTiming.msg3 || 24
            }
          },
          ...((wizardData.razorpayKeyId || wizardData.cashfreeAppId) ? [{
            id:     "cod_to_prepaid",
            type:   "cod_to_prepaid",
            active: true,
            config: {
              delayMinutes:    3,
              discountAmount:  50,
              razorpayEnabled: !!wizardData.razorpayKeyId,
              cashfreeEnabled: !!wizardData.cashfreeAppId
            }
          }] : []),
          {
            id:     "review_collection",
            type:   "review_collection",
            active: !!(wizardData.googleReviewUrl),
            config: {
              delayDays:    4,
              reviewUrl:    wizardData.googleReviewUrl || ""
            }
          }
        ]
      }),
    };

    const updateQuery = { 
      $set: settingsUpdate,
      $push: { visualFlows: newFlow }
    };

    const updateQuery = { $set: settingsUpdate };

    if (wizardData.customTemplates && wizardData.customTemplates.length > 0) {
      updateQuery.$push = {
        messageTemplates: {
          $each: wizardData.customTemplates.map(t => ({
            ...t,
            status: 'PENDING',
            source: 'wizard_custom',
            createdAt: new Date()
          }))
        }
      };
    }

    await Client.findByIdAndUpdate(client._id, updateQuery, { new: true });

    console.log(`[Wizard] ✅ Complete! Flow generated with ${nodes.length} nodes for ${clientId}`);

    res.json({
      success:        true,
      flowId:         newFlow.id,
      nodesGenerated: nodes.length,
      message:        `Your bot is live! ${nodes.length} nodes generated.`
    });

  } catch (err) {
    console.error(`[Wizard] Error completing wizard for ${clientId}:`, err.message);
    res.status(500).json({ error: err.message || "Wizard completion failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wizard/:clientId/shopify-products
// Fetch top 10 products from Shopify for auto-import in Step 2
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:clientId/shopify-products", protect, async (req, res) => {
  const { clientId } = req.params;

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (!client.shopDomain || !client.shopifyAccessToken) {
      return res.json({ success: false, products: [], message: "Shopify not connected" });
    }

    const axios = require("axios");
    const resp = await axios.get(
      `https://${client.shopDomain}/admin/api/2023-10/products.json?limit=10&fields=id,title,variants,images`,
      { headers: { "X-Shopify-Access-Token": client.shopifyAccessToken } }
    );

    const products = (resp.data.products || []).map(p => ({
      name:        p.title,
      price:       p.variants?.[0]?.price || "",
      description: "",
      imageUrl:    p.images?.[0]?.src || "",
      shopifyId:   p.id
    }));

    res.json({ success: true, products });
  } catch (err) {
    console.error(`[Wizard] Shopify product fetch error for ${clientId}:`, err.message);
    res.json({ success: false, products: [], message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wizard/:clientId/templates
// Get the pre-built templates to show in Step 8 of the wizard
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/templates", protect, async (req, res) => {
  const { wizardData } = req.body;
  try {
    const templates = getPrebuiltTemplates(wizardData || {});
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/reset
// Re-run the wizard (super admin only or triggered from Settings)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/reset", protect, async (req, res) => {
  const { clientId } = req.params;
  try {
    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    await Client.findOneAndUpdate({ clientId }, { $set: { wizardCompleted: false } });
    res.json({ success: true, message: "Wizard reset. Will show on next login." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
