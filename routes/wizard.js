"use strict";

const express = require("express");
const router  = express.Router();
const Client  = require("../models/Client");
const { protect } = require("../middleware/auth");
const { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates } = require("../utils/flowGenerator");
const { withShopifyRetry } = require("../utils/shopifyHelper");

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
    
    // Get pre-built templates based on user's wizard data (like business name, cart timing)
    const templates = getPrebuiltTemplates(wizardData);
    
    // Generate the complete flow (passing templates so nodes can use them)
    const { nodes, edges } = await generateEcommerceFlow(client, { ...wizardData, templates });

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
      ...(wizardData.businessName    && { 
        businessName: wizardData.businessName, 
        name: wizardData.businessName,
        'brand.businessName': wizardData.businessName
      }),
      ...(wizardData.botName         && { 
        "nicheData.botName": wizardData.botName,
        "ai.persona.name": wizardData.botName
      }),
      ...(wizardData.tone && { "ai.persona.tone": wizardData.tone }),
      ...(wizardData.botLanguage && { "ai.persona.language": wizardData.botLanguage }),
      ...(wizardData.businessDescription && { "ai.persona.description": wizardData.businessDescription }),
      ...(wizardData.googleReviewUrl && { 
        googleReviewUrl: wizardData.googleReviewUrl,
        'brand.googleReviewUrl': wizardData.googleReviewUrl
      }),
      ...(wizardData.systemPrompt               && { 
        systemPrompt,
        'ai.systemPrompt': systemPrompt
      }),
      ...(wizardData.returnsInfo && { "ai.persona.returnsInfo": wizardData.returnsInfo }),
      ...(wizardData.faqText && { "ai.persona.faqText": wizardData.faqText }),
      ...(wizardData.razorpayKeyId    && { razorpayKeyId: wizardData.razorpayKeyId }),
      ...(wizardData.razorpaySecret   && { razorpaySecret: wizardData.razorpaySecret }),
      ...(wizardData.cashfreeAppId    && { cashfreeAppId: wizardData.cashfreeAppId }),
      ...(wizardData.cashfreeSecretKey && { cashfreeSecretKey: wizardData.cashfreeSecretKey }),
      ...(wizardData.activePaymentGateway && { activePaymentGateway: wizardData.activePaymentGateway }),
      ...(wizardData.adminPhone       && { 
        adminPhone: wizardData.adminPhone,
        'brand.adminPhone': wizardData.adminPhone,
        'config.adminPhones': wizardData.adminPhone.split(',').map(p => p.trim())
      }),
      ...(wizardData.metaAdsToken && {
        metaAdsConnected:   true,
        metaAdAccountId:    wizardData.metaAdAccountId,
        metaAdsToken:       wizardData.metaAdsToken,
        'social.metaAds.accountId':   wizardData.metaAdAccountId,
        'social.metaAds.accessToken': wizardData.metaAdsToken,
      }),
      ...(wizardData.metaAppId && { metaAppId: wizardData.metaAppId }),
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
      // Enterprise Ops Sync
      ...(wizardData.activePersona && { "ai.enterprisePersona": wizardData.activePersona }),
      ...(wizardData.referralPoints && { "brand.referralPoints": wizardData.referralPoints }),
      ...(wizardData.signupPoints   && { "brand.signupPoints": wizardData.signupPoints }),
      ...(wizardData.openTime && { "config.businessHours.openTime": wizardData.openTime }),
      ...(wizardData.closeTime && { "config.businessHours.closeTime": wizardData.closeTime }),
      ...(wizardData.workingDays && { "config.businessHours.workingDays": wizardData.workingDays }),
      ...(wizardData.b2bEnabled !== undefined && { 
        "brand.b2bEnabled": wizardData.b2bEnabled,
        "config.b2bEnabled": wizardData.b2bEnabled 
      }),
      ...(wizardData.b2bThreshold && { "brand.b2bThreshold": wizardData.b2bThreshold }),
      ...(wizardData.b2bAdminPhone && { "brand.b2bAdminPhone": wizardData.b2bAdminPhone }),
      ...(wizardData.businessLogo && { 
        "brand.businessLogo": wizardData.businessLogo,
        "businessLogo": wizardData.businessLogo 
      }),
      ...(wizardData.authorizedSignature && { 
        "brand.authorizedSignature": wizardData.authorizedSignature,
        "authorizedSignature": wizardData.authorizedSignature 
      }),
      ...(wizardData.warrantyDuration && { "brand.warrantyDuration": wizardData.warrantyDuration }),
      ...(wizardData.warrantyPolicy && { "brand.warrantyPolicy": wizardData.warrantyPolicy })
    };

    // Handle customTemplates (push them separately after main update)
    const customTemplatesPush = (wizardData.customTemplates && wizardData.customTemplates.length > 0)
      ? wizardData.customTemplates.map(t => ({ ...t, status: 'PENDING', source: 'wizard_custom', createdAt: new Date() }))
      : [];

    // If replaceExisting, update the active main flow's nodes instead of always pushing
    let updateQuery;
    if (wizardData.replaceExisting !== false) {
      // Replace the active whatsapp flow's nodes
      const existingFlows = client.visualFlows || [];
      const activeFlowIdx = existingFlows.findIndex(f => f.isActive && f.platform === 'whatsapp');
      
      if (activeFlowIdx !== -1) {
        // Update in-place
        existingFlows[activeFlowIdx] = {
          ...existingFlows[activeFlowIdx],
          nodes,
          edges,
          updatedAt: new Date(),
          generatedBy: 'wizard'
        };
        updateQuery = {
          $set: { ...settingsUpdate, visualFlows: existingFlows }
        };
      } else {
        // No active flow found, push the new one
        newFlow.isActive = true;
        updateQuery = {
          $set: settingsUpdate,
          $push: { visualFlows: newFlow }
        };
      }
    } else {
      // Add as new flow (keep existing active ones)
      updateQuery = {
        $set: settingsUpdate,
        $push: { visualFlows: newFlow }
      };
    }

    const updatedClient = await Client.findByIdAndUpdate(client._id, updateQuery, { new: true });

    // Push customTemplates separately if any
    if (customTemplatesPush.length > 0) {
      await Client.findByIdAndUpdate(client._id, {
        $push: { messageTemplates: { $each: customTemplatesPush } }
      });
    }

    // Sync persona to flows (Goal 1: Alignment)
    if (updatedClient.ai?.persona) {
      const { syncPersonaToFlows } = require("../utils/personaEngine");
      syncPersonaToFlows(clientId, updatedClient.ai.persona);
    }

    const action = wizardData.replaceExisting !== false ? 'replaced' : 'added';
    console.log(`[Wizard] ✅ Complete! Flow ${action} with ${nodes.length} nodes for ${clientId}`);

    res.json({
      success:        true,
      flowId:         newFlow.id,
      nodesGenerated: nodes.length,
      action,
      message:        `Your bot is live! ${nodes.length} nodes generated and ${action} successfully.`
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
  const axios = require("axios");
  const { decrypt } = require("../utils/encryption");

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const shopDomain = client.shopDomain || client['commerce.shopify.domain'];
    const rawToken = client.shopifyAccessToken || client.commerce?.shopify?.accessToken;

    if (!shopDomain || !rawToken) {
      return res.json({ 
        success: false, 
        products: [], 
        message: "Shopify not connected. Please add your store credentials in Hub Settings first." 
      });
    }

    console.log(`[WizardProducts] Fetching products for ${clientId} | domain: ${shopDomain} | token starts: ${rawToken?.substring(0,10)}...`);

    // Helper to map a Shopify product list to our format
    const mapProducts = (list) => (list || [])
      .filter(p => p.status === 'active' || !p.status)
      .slice(0, 20)
      .map(p => ({
        name:        p.title,
        price:       p.variants?.[0]?.price || '',
        description: p.variants?.[0]?.title !== 'Default Title' ? p.variants?.[0]?.title : '',
        imageUrl:    p.images?.[0]?.src || '',
        shopifyId:   p.id,
        handle:      p.handle
      }));

    // ── STRATEGY 1: Use withShopifyRetry (auto-decrypts + auto-rotates) ──────
    try {
      const products = await withShopifyRetry(clientId, async (shop) => {
        const resp = await shop.get('/products.json?limit=30&fields=id,title,variants,images,status,handle');
        return mapProducts(resp.data.products);
      });
      console.log(`[WizardProducts] ✅ Strategy 1 (withShopifyRetry) success for ${clientId}: ${products.length} products`);
      return res.json({ success: true, products });
    } catch (strategy1Err) {
      console.warn(`[WizardProducts] Strategy 1 failed for ${clientId}:`, strategy1Err.response?.status, strategy1Err.message);
    }

    // ── STRATEGY 2: Try raw token (may be plain-text Admin API token) ─────────
    const decryptedToken = decrypt(rawToken);
    const apiVersion = client.shopifyApiVersion || '2023-10';
    const adminBaseUrl = `https://${shopDomain}/admin/api/${apiVersion}`;

    try {
      const resp = await axios.get(`${adminBaseUrl}/products.json?limit=30&fields=id,title,variants,images,status,handle`, {
        headers: { 'X-Shopify-Access-Token': decryptedToken, 'Content-Type': 'application/json' }
      });
      const products = mapProducts(resp.data.products);
      console.log(`[WizardProducts] ✅ Strategy 2 (raw admin token) success for ${clientId}: ${products.length} products`);
      return res.json({ success: true, products });
    } catch (strategy2Err) {
      console.warn(`[WizardProducts] Strategy 2 failed for ${clientId}:`, strategy2Err.response?.status, strategy2Err.message);
    }

    // ── STRATEGY 3: Try Storefront API (read-only public products) ────────────
    const storefrontToken = client.storefrontAccessToken || client.shopifyStorefrontToken;
    if (storefrontToken) {
      try {
        const sfResp = await axios.post(
          `https://${shopDomain}/api/${apiVersion}/graphql.json`,
          { query: `{ products(first: 20, query: "status:active") { edges { node { id title handle variants(first: 1) { edges { node { price } } } images(first: 1) { edges { node { url } } } } } } }` },
          { headers: { 'X-Shopify-Storefront-Access-Token': storefrontToken, 'Content-Type': 'application/json' } }
        );
        const edges = sfResp.data?.data?.products?.edges || [];
        const products = edges.map(({ node: p }) => ({
          name:      p.title,
          price:     p.variants?.edges?.[0]?.node?.price || '',
          imageUrl:  p.images?.edges?.[0]?.node?.url || '',
          shopifyId: p.id,
          handle:    p.handle
        }));
        console.log(`[WizardProducts] ✅ Strategy 3 (storefront token) success for ${clientId}: ${products.length} products`);
        return res.json({ success: true, products });
      } catch (strategy3Err) {
        console.warn(`[WizardProducts] Strategy 3 failed for ${clientId}:`, strategy3Err.message);
      }
    }

    // All strategies failed
    console.error(`[WizardProducts] ❌ All strategies failed for ${clientId}`);
    return res.json({ 
      success: false, 
      products: [], 
      isAuthError: true,
      message: 'Shopify authentication failed on all attempts. Your Admin API token may be invalid or have insufficient scopes (needs read_products). Please reconnect from Hub Settings → Store Connection.' 
    });

  } catch (err) {
    console.error(`[WizardProducts] Unexpected error for ${clientId}:`, err.message);
    res.json({ success: false, products: [], message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wizard/:clientId/debug-shopify  (SUPER_ADMIN only)
// Returns safe debug info about stored Shopify credentials
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:clientId/debug-shopify", protect, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'SUPER_ADMIN only' });
  const { clientId } = req.params;
  const { decrypt } = require("../utils/encryption");
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });
    const rawToken = client.shopifyAccessToken || '';
    const decrypted = decrypt(rawToken);
    res.json({
      shopDomain: client.shopDomain,
      connectionStatus: client.shopifyConnectionStatus,
      lastError: client.lastShopifyError,
      tokenStored: rawToken ? `${rawToken.substring(0,8)}...${rawToken.slice(-4)} (${rawToken.length} chars)` : 'NONE',
      tokenDecrypted: decrypted ? `${decrypted.substring(0,8)}...${decrypted.slice(-4)} (${decrypted.length} chars)` : 'NONE',
      tokenLooksEncrypted: rawToken.includes(':') && rawToken.length > 40,
      hasStorefrontToken: !!(client.storefrontAccessToken || client.shopifyStorefrontToken),
      apiVersion: client.shopifyApiVersion || '2023-10'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
