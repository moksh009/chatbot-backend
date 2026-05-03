"use strict";

const express = require("express");
const router  = express.Router();
const Client  = require("../models/Client");
const { protect } = require("../middleware/auth");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates } = require("../utils/flowGenerator");
const { clearTriggerCache } = require("../utils/triggerEngine");
const { syncPlatformVarsToFlows } = require("../utils/platformVarsSync");
const { withShopifyRetry } = require("../utils/shopifyHelper");
const { generateText, generateTextFast } = require("../utils/gemini");
const { mapWizardToClient, mapFeatureToggle, pullPersonaBundleFromSet } = require("../utils/wizardMapper");
const { emitToClient } = require("../utils/socket");
const log = require("../utils/logger")("Wizard");
const { tenantClientId } = require("../utils/queryHelpers");
const { hydrateProductTemplateRecord } = require("../utils/templateImageHydrate");

async function syncPendingTemplatesForClient(client) {
  const axios = require("axios");
  const { decrypt } = require("../utils/encryption");

  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  let token = client.whatsappToken || client.whatsapp?.accessToken;
  if (!wabaId || !token) {
    return { checked: 0, approved: 0, rejected: 0, pendingRemaining: 0, error: "Missing WABA credentials" };
  }
  try {
    token = decrypt(token) || token;
  } catch (_) {}

  let remoteTemplates = [];
  try {
    const resp = await axios.get(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
      params: { limit: 250, fields: "name,status,category,language,id" },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    remoteTemplates = resp.data?.data || [];
  } catch (err) {
    return { checked: 0, approved: 0, rejected: 0, pendingRemaining: 0, error: err.response?.data?.error?.message || err.message };
  }

  const remoteMap = new Map(remoteTemplates.map((t) => [t.name, String(t.status || "PENDING").toUpperCase()]));
  const pendingTemplates = Array.isArray(client.pendingTemplates) ? client.pendingTemplates : [];
  const messageTemplates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
  const syncedMap = new Map((client.syncedMetaTemplates || []).map((t) => [t.name, t]));
  const pendingMap = new Map(pendingTemplates.map((t) => [t.name, t]));
  const updatedPending = [];
  const updatedMessage = [];
  let approvedCount = 0;
  let rejectedCount = 0;
  let checked = 0;

  for (const tpl of messageTemplates) {
    const remoteStatus = remoteMap.get(tpl.name);
    const status = String(remoteStatus || tpl.status || "PENDING").toUpperCase();
    const prevStatus = String(tpl.status || "PENDING").toUpperCase();
    checked += 1;
    const pendingMeta = pendingMap.get(tpl.name) || {};
    const merged = {
      ...tpl,
      status,
      lastCheckedAt: new Date(),
      productHandle: tpl.productHandle || pendingMeta.productHandle || "",
      productId: tpl.productId || pendingMeta.productId || "",
    };

    if (status === "APPROVED") {
      approvedCount += 1;
      try {
        const hydrated = await hydrateProductTemplateRecord(client.clientId, merged, {
          force: prevStatus !== "APPROVED",
          maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        });
        Object.assign(merged, hydrated);
      } catch (hErr) {
        log.warn(`[TemplateSync] Product image hydrate skipped for ${tpl.name}: ${hErr.message}`);
      }
      syncedMap.set(tpl.name, {
        name: tpl.name,
        status: "APPROVED",
        productHandle: pendingMeta.productHandle || merged.productHandle || "",
        productId: pendingMeta.productId || merged.productId || "",
        metaId: pendingMeta.metaId || tpl.id || "",
        approvedAt: new Date(),
        submittedAt: pendingMeta.submittedAt || tpl.createdAt || null,
      });
    } else {
      if (status === "REJECTED") rejectedCount += 1;
      updatedPending.push({
        ...pendingMeta,
        name: tpl.name,
        status,
        productHandle: pendingMeta.productHandle || tpl.productHandle || "",
        productId: pendingMeta.productId || tpl.productId || "",
        metaId: pendingMeta.metaId || tpl.id || "",
        submittedAt: pendingMeta.submittedAt || tpl.createdAt || null,
        lastCheckedAt: new Date(),
      });
    }
    updatedMessage.push(merged);
  }

  // Preserve pending templates that don't have messageTemplates entry yet.
  for (const pending of pendingTemplates) {
    if (!pending?.name) continue;
    if (updatedPending.find((u) => u.name === pending.name)) continue;
    const status = String(remoteMap.get(pending.name) || pending.status || "PENDING").toUpperCase();
    if (status === "APPROVED") {
      approvedCount += 1;
      syncedMap.set(pending.name, {
        name: pending.name,
        status: "APPROVED",
        productHandle: pending.productHandle || "",
        productId: pending.productId || "",
        metaId: pending.metaId || "",
        approvedAt: new Date(),
        submittedAt: pending.submittedAt || null
      });
    } else {
      updatedPending.push({ ...pending, status, lastCheckedAt: new Date() });
    }
  }

  await Client.findByIdAndUpdate(client._id, {
    $set: {
      pendingTemplates: updatedPending,
      messageTemplates: updatedMessage,
      syncedMetaTemplates: Array.from(syncedMap.values())
    }
  });

  return { checked, approved: approvedCount, rejected: rejectedCount, pendingRemaining: updatedPending.length, updatedPending };
}

// GET /api/wizard/:clientId/setup-checklist
router.get("/:clientId/setup-checklist", protect, async (req, res) => {
  const { clientId } = req.params;
  try {
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }
    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ success: false, error: "Client not found" });

    const checklist = [];
    const shopifyConnected = !!(client.shopDomain && client.shopifyAccessToken);

    if (shopifyConnected && client.wizardFeatures?.enableAbandonedCart) {
      checklist.push({
        category: "Shopify",
        item: "Enable abandoned checkout webhook",
        status: client.shopifyWebhooks?.checkouts_create ? "done" : "pending",
        action: "In Shopify Admin → Settings → Notifications → Webhooks → Add: checkouts/create",
        critical: true
      });
    }
    if (shopifyConnected) {
      checklist.push({
        category: "Shopify",
        item: "Add customer phone number to orders",
        status: client.platformVars?.shopifyPhoneField ? "done" : "pending",
        action: "Ensure checkout collects phone so order tracking by WhatsApp number works",
        critical: true
      });
    }

    const approvedTemplates = (client.syncedMetaTemplates || []).filter(
      (t) => String(t.status || "").toUpperCase() === "APPROVED"
    );
    const pendingTemplates = (client.messageTemplates || []).filter(
      (t) => String(t.status || "").toUpperCase() === "PENDING"
    );
    const welcomeApproved = approvedTemplates.some((t) => t.name === "welcome_with_logo");
    if (!welcomeApproved) {
      checklist.push({
        category: "Meta Templates",
        item: "Welcome template approval",
        status: pendingTemplates.some((t) => t.name === "welcome_with_logo") ? "pending" : "not_submitted",
        action: "Submit the 'welcome_with_logo' template from the Templates tab and wait for Meta approval",
        critical: false
      });
    }

    checklist.push({
      category: "WhatsApp",
      item: "Set business display name in Meta Business Manager",
      status: client.wabaDisplayName ? "done" : "pending",
      action: "Meta Business Manager → WhatsApp Accounts → verify display name matches your brand",
      critical: false
    });

    if (client.wizardFeatures?.enableLoyalty) {
      checklist.push({
        category: "Loyalty Program",
        item: "Configure points earning rules",
        status: client.loyaltyConfig?.enabled ? "done" : "pending",
        action: "Settings → Loyalty Program → set points per purchase",
        critical: false
      });
    }

    checklist.push({
      category: "Testing",
      item: "Send test message to your WhatsApp number",
      status: client.testMessageSent ? "done" : "pending",
      action: "Send 'hi' to your WhatsApp Business number to verify the welcome flow",
      critical: true
    });

    res.json({
      success: true,
      checklist,
      doneCount: checklist.filter((c) => c.status === "done").length
    });
  } catch (err) {
    log.error("setup-checklist failed", err);
    res.status(500).json({ success: false, error: err.message || "Failed" });
  }
});

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

    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    console.log(`[Wizard] Starting flow generation for ${clientId}...`);
    
    // Get pre-built templates based on user's wizard data (like business name, cart timing)
    const templates = getPrebuiltTemplates(wizardData);
    
    // Generate the complete flow (passing templates so nodes can use them)
    const generated = await generateEcommerceFlow(client, { ...wizardData, templates });
    const { nodes, edges, automationFlows = [] } = generated;

    // Replace mode: Flow Builder lists `WhatsAppFlow` documents. Older wizard runs only
    // updated `Client.visualFlows` / deleted one `flowModelId`, so stale main + automation
    // rows stayed in the collection — remove all wizard-generated flows before inserting new ones.
    if (wizardData.replaceExisting !== false) {
      const delResult = await WhatsAppFlow.deleteMany({
        clientId,
        $or: [
          { flowId: { $regex: "^flow_wizard_" } },
          { flowId: { $regex: "^auto_" } },
          { generatedBy: "wizard" },
          { isAutomation: true },
          { name: { $regex: "^Automation:" } },
        ],
      });
      log.info(
        `[Wizard] Replace mode: removed ${delResult.deletedCount} prior WhatsAppFlow document(s) for ${clientId}`
      );
    }

    // Generate system prompt
    const systemPrompt = await generateSystemPrompt(client, wizardData);

    // Build the new flow object
    // Phase R4 Fix: nodes/edges always stored empty here (full data in WhatsAppFlow model)
    // nodeCount is stored so FlowBuilder card displays correct count without loading all nodes
    const flowId = `flow_wizard_${Date.now()}`;
    const newFlow = {
      id:          flowId,
      name:        `${wizardData.businessName || client.name} — Main Flow`,
      platform:    "whatsapp",
      isActive:    true,
      folderId:    "",
      nodes:       nodes.length > 20 ? [] : nodes,
      edges:       nodes.length > 20 ? [] : edges,
      nodeCount:   nodes.length,   // Always stored for card display
      edgeCount:   edges.length,   // Always stored for card display
      flowModelId: null,            // Populated if > 20 nodes
      createdAt:   new Date(),
      updatedAt:   new Date(),
      generatedBy: "wizard"
    };

    // Commerce automations live in the same flow as the main journey (use Flow folders / layout).
    // Runtime: triggerEngine scans all trigger nodes and starts from the matching commerce trigger.
    const mainNodes = nodes;
    const mainEdges = edges;

    // Update newFlow to use full graph (main + automations)
    newFlow.nodes = mainNodes.length > 20 ? [] : mainNodes;
    newFlow.edges = mainNodes.length > 20 ? [] : mainEdges;
    newFlow.nodeCount = mainNodes.length;
    newFlow.edgeCount = mainEdges.length;

    // ✅ Phase R4: Smart Flow Storage — always offload to WhatsAppFlow model when > 20 nodes
    if (mainNodes.length > 20) {
      const storedFlow = await WhatsAppFlow.create({
        clientId,
        flowId,
        name:     newFlow.name,
        platform: 'whatsapp',
        nodes:    mainNodes,
        edges:    mainEdges,
        status:   'PUBLISHED',
        generatedBy: 'wizard',
      });
      newFlow.flowModelId = storedFlow._id;
      console.log(`[Wizard] Main flow offloaded to WhatsAppFlow model: ${storedFlow._id} (${mainNodes.length} nodes)`);
    }

    // ─── Build the canonical wizard → DB update via the central mapper ───────
    // All field-mapping rules live in utils/wizardMapper.js so we have ONE
    // source of truth instead of 150 lines of brittle inline spreads.
    const mapped = mapWizardToClient(wizardData, client, { systemPrompt });
    const $set = mapped.$set;
    const { persona: personaPatch, systemPrompt: personaSystemPrompt } =
      pullPersonaBundleFromSet($set);

    // Persist legacy flow arrays for the dual-brain engine when replacing.
    if (wizardData.replaceExisting !== false) {
      $set.flowNodes = mainNodes;
      $set.flowEdges = mainEdges;
    }

    // Decide visualFlows mutation: replace existing active flow OR push new one.
    let updateQuery;
    if (wizardData.replaceExisting !== false) {
      const existingFlows = client.visualFlows || [];
      const activeFlowIdx = existingFlows.findIndex(f => f.isActive && f.platform === 'whatsapp');

      if (activeFlowIdx !== -1) {
        if (existingFlows[activeFlowIdx].flowModelId) {
          await WhatsAppFlow.findByIdAndDelete(existingFlows[activeFlowIdx].flowModelId);
          log.info(`Deleted old stranded WhatsAppFlow record: ${existingFlows[activeFlowIdx].flowModelId}`);
        }
        existingFlows[activeFlowIdx] = {
          ...existingFlows[activeFlowIdx],
          nodes:       newFlow.nodes,
          edges:       newFlow.edges,
          flowModelId: newFlow.flowModelId,
          updatedAt:   new Date(),
          generatedBy: 'wizard'
        };
        updateQuery = { $set: { ...$set, visualFlows: existingFlows } };
      } else {
        newFlow.isActive = true;
        updateQuery = { $set, $push: { visualFlows: newFlow } };
      }
    } else {
      updateQuery = { $set, $push: { visualFlows: newFlow } };
    }

    // Final update.
    const updatedClient = await Client.findByIdAndUpdate(
      client._id, updateQuery, { new: true, runValidators: true }
    );

    // Commerce triggers (cart, order_placed, fulfilled, etc.) are embedded in the main graph
    // (`automationFlows` from generator is always empty). Legacy per-trigger docs are removed
    // by the deleteMany filter above when replaceExisting is true.
    clearTriggerCache(clientId);
    await syncPlatformVarsToFlows(clientId);

    const { syncPersonaAcrossSystem } = require("../utils/personaEngine");
    await syncPersonaAcrossSystem(clientId, personaPatch, {
      systemPrompt: personaSystemPrompt,
    });

    console.log(`[Wizard] Completed for ${clientId}. wizardCompleted=${updatedClient.wizardCompleted}`);

    // Custom Meta templates are pushed separately so they don't conflict with
    // the visualFlows $push above (Mongo allows only one $push per array per op).
    if (mapped.$push?.messageTemplates) {
      await Client.findByIdAndUpdate(client._id, { $push: { messageTemplates: mapped.$push.messageTemplates } });
    }

    // Notify any open dashboard tabs that the flow regenerated (FlowBuilder
    // listens for this and refetches without a hard refresh).
    try {
      emitToClient(clientId, 'wizard:flow-regenerated', {
        clientId,
        flowId: newFlow.id,
        nodeCount: mainNodes.length,
        edgeCount: mainEdges.length,
        source: 'wizard_complete',
        generatedAt: new Date()
      });
    } catch (_) { /* socket optional */ }

    const action = wizardData.replaceExisting !== false ? 'replaced' : 'added';
    console.log(`[Wizard] ✅ Complete! Flow ${action} with ${nodes.length} nodes for ${clientId}`);

    res.json({
      success:        true,
      flowId:         newFlow.id,
      nodesGenerated: nodes.length,
      edgesGenerated: edges.length,
      action,
      message:        `Your bot is live! ${nodes.length} nodes generated and ${action} successfully.`
    });

  } catch (err) {
    console.error(`[Wizard] Error completing wizard for ${clientId}:`, err.message);
    res.status(500).json({ error: err.message || "Wizard completion failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/generate-from-url
// Scrapes a website URL to generate an AI Core system prompt and FAQ
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/generate-from-url", protect, async (req, res) => {
  const { clientId } = req.params;
  const { url, geminiApiKey } = req.body;

  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const cheerio = require('cheerio');
    const axios = require('axios');

    // 1. Scrape the website
    let scrapedText = "";
    try {
      const resp = await axios.get(url, { timeout: 10000 });
      const $ = cheerio.load(resp.data);
      // Remove scripts, styles, and other non-content
      $('script, style, noscript, iframe, img, svg').remove();
      scrapedText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 10000); // Limit to 10k chars
    } catch (scrapeErr) {
      log.error(`[WizardScraper] Failed to scrape ${url}`, scrapeErr.message);
      return res.status(400).json({ error: "Failed to read the provided URL. Please check the link and try again." });
    }

    // 2. Format the prompt for the AI to extract a system prompt and FAQ
    const aiPrompt = `
You are an expert e-commerce copywriter and AI persona designer.
I have scraped the content of a business's website: ${url}.

Website Content:
${scrapedText}

Based on this content, generate two things in valid JSON format:
1. A concise, professional system prompt (3-5 sentences) that an AI assistant should use when talking to customers. It should mention what the business sells, the tone (friendly, professional, etc.), and key value propositions found in the text.
2. A short "About Us / General FAQ" text (3-4 sentences max) that summarizes the core business, origin, and general info that customers might ask.

Respond ONLY with a JSON object in this exact format:
{
  "systemPrompt": "You are the AI assistant for [Brand]. You help customers with...",
  "faqText": "[Brand] was founded in... We specialize in..."
}`;

    // 3. Call Gemini (use provided key or fallback to environment)
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY || process.env.GEMINI_STUDIO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "No AI API Key available for generation" });
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const model = genAI.getGenerativeModel({ model: geminiModel, generationConfig: { responseMimeType: "application/json" } });
    
    const result = await model.generateContent(aiPrompt);
    const responseText = result.response.text();
    const generatedData = JSON.parse(responseText);

    res.json({
      success: true,
      data: {
        systemPrompt: generatedData.systemPrompt || "",
        faqText: generatedData.faqText || ""
      }
    });

  } catch (err) {
    log.error(`[WizardGenURL] Error for ${clientId}:`, err.message);
    res.status(500).json({ error: "Failed to generate AI Core from URL" });
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
  const { clientId } = req.params;
  const { wizardData } = req.body;
  try {
    const client = await Client.findOne({ clientId }).lean();
    const templates = getPrebuiltTemplates(wizardData || {});
    const pendingMap = new Map((client?.pendingTemplates || []).map((t) => [t.name, String(t.status || "PENDING").toUpperCase()]));
    const syncedMap = new Map((client?.syncedMetaTemplates || []).map((t) => [t.name, String(t.status || "APPROVED").toUpperCase()]));
    const msgMap = new Map((client?.messageTemplates || []).map((t) => [t.name, String(t.status || "").toUpperCase()]));

    const hydrated = templates.map((tpl) => {
      const status = syncedMap.get(tpl.name) || pendingMap.get(tpl.name) || msgMap.get(tpl.name) || tpl.status || "not_submitted";
      return { ...tpl, status };
    });
    res.json({ success: true, templates: hydrated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/submit-product-templates
// Submit product Meta templates to WhatsApp Business API for approval.
// Each product in wizardData.products gets its own IMAGE header template.
// Returns { submitted: N, alreadyApproved: N, errors: [] }
// ────────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/submit-product-templates", protect, async (req, res) => {
  const { clientId } = req.params;
  const { wizardData } = req.body;
  const axios = require("axios");

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const wabaId  = client.wabaId || client.whatsapp?.wabaId;
    const token   = client.whatsappToken || client.whatsapp?.accessToken;
    const products = (wizardData?.products || []).slice(0, 25); // Increased limit to 25
    const shopDomain = client.shopDomain || wizardData?.shopDomain || '';
    const storeBase  = shopDomain ? `https://${shopDomain.replace(/^https?:\/\//, '')}` : '';
    const currency   = client.brand?.currency || wizardData?.currency || '₹';
    const biz        = client.businessName || wizardData?.businessName || 'Our Brand';

    if (!wabaId || !token) {
      return res.status(422).json({
        success: false,
        error: 'WhatsApp WABA ID and Access Token are required for template submission. Connect WhatsApp first in Step 3.'
      });
    }

    const submitted     = [];
    const alreadyDone   = [];
    const errors        = [];

    for (const prod of products) {
      const handle = (prod.handle || prod.name || `product_${Date.now()}`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const templateName = `prod_${handle}`.substring(0, 50);
      const price  = prod.price || prod.variants?.[0]?.price || '0';
      const buyUrl = storeBase ? `${storeBase}/products/${handle}` : '';

      // Check if already submitted or approved
      const existing = (client.messageTemplates || []).find(t => t.name === templateName);
      if (existing && ['APPROVED', 'PENDING', 'IN_APPEAL'].includes(existing.status)) {
        alreadyDone.push(templateName);
        continue;
      }

      // Build Meta-compliant template payload
      const templatePayload = {
        name: templateName,
        language: 'en',
        category: 'MARKETING',
        components: [
          {
            type: 'HEADER',
            format: 'IMAGE',
            // Meta REQUIRES a sample image handle or a public link for approval.
            example: { 
              header_handle: [
                prod.imageUrl || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=800'
              ] 
            }
          },
          {
            type: 'BODY',
            text: `Product: *{{1}}*\n\n💰 Price: ${currency}{{2}}\n\n*Key Features:*\n{{3}}\n\nClick below to view more details!`,
            example: { 
              body_text: [[
                (prod.name || prod.title || 'Premium Product').substring(0, 30), 
                price, 
                (prod.description || 'Exclusive quality materials, perfect for daily use, highly durable and stylish.').replace(/<[^>]+>/g, '').substring(0, 100)
              ]] 
            }
          },
          {
            type: 'FOOTER',
            text: biz.substring(0, 60)
          },
          {
            type: 'BUTTONS',
            buttons: [
              ...(buyUrl ? [{ type: 'URL', text: 'Buy Now', url: buyUrl }] : [{ type: 'QUICK_REPLY', text: 'Buy Now' }]),
              { type: 'QUICK_REPLY', text: 'Main Menu' },
            ]
          }
        ]
      };

      try {
        let accessToken = token;
        try {
          const { decrypt } = require('../utils/encryption');
          accessToken = decrypt(token) || token;
        } catch (_) {}

        const metaRes = await axios.post(
          `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
          templatePayload,
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );

        const newTemplate = {
          id:          metaRes.data.id || `pending_${templateName}`,
          name:        templateName,
          status:      'PENDING',
          category:    'MARKETING',
          language:    'en',
          components:  JSON.parse(JSON.stringify(templatePayload.components || [])),
          source:      'wizard_product',
          imageUrl:    prod.imageUrl || '',
          createdAt:   new Date()
        };

        const pendingTemplate = {
          name: templateName,
          productHandle: handle,
          productId: String(prod.id || prod.shopifyId || ""),
          status: "PENDING",
          metaId: metaRes.data.id || "",
          submittedAt: new Date()
        };

        await Client.findByIdAndUpdate(client._id, {
          $pull:  { messageTemplates: { name: templateName } },
        });
        await Client.findByIdAndUpdate(client._id, {
          $push:  { messageTemplates: newTemplate, pendingTemplates: pendingTemplate },
        });

        submitted.push(templateName);
        log.info(`[TemplateSubmit] ✅ ${templateName} submitted to Meta for ${clientId}`);
      } catch (metaErr) {
        const errMsg = metaErr.response?.data?.error?.message || metaErr.message;
        const alreadyExists = /already exists|duplicate/i.test(String(errMsg));
        if (alreadyExists) {
          const existingTemplate = {
            id: `existing_${templateName}`,
            name: templateName,
            status: 'PENDING',
            category: 'MARKETING',
            language: 'en',
            components: JSON.parse(JSON.stringify(templatePayload.components || [])),
            source: 'wizard_product',
            imageUrl: prod.imageUrl || '',
            createdAt: new Date()
          };
          await Client.findByIdAndUpdate(client._id, {
            $pull: { messageTemplates: { name: templateName }, pendingTemplates: { name: templateName } }
          });
          await Client.findByIdAndUpdate(client._id, {
            $push: {
              messageTemplates: existingTemplate,
              pendingTemplates: {
                name: templateName,
                productHandle: handle,
                productId: String(prod.id || prod.shopifyId || ""),
                status: "PENDING",
                metaId: "",
                submittedAt: new Date()
              }
            }
          });
          alreadyDone.push(templateName);
        } else {
          log.error(`[TemplateSubmit] ❌ ${templateName} failed:`, errMsg);
          errors.push({ template: templateName, error: errMsg });
        }
      }
    }

    res.json({
      success:        errors.length === 0,
      submitted:      submitted.length,
      alreadyApproved: alreadyDone.length,
      submittedNames: submitted,
      errors,
      message: submitted.length > 0
        ? `${submitted.length} product template(s) submitted to Meta.`
        : (errors.length > 0 ? 'Submission failed. Check details.' : 'No new product templates to submit.')
    });

  } catch (err) {
    log.error(`[TemplateSubmit] Error for ${clientId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/sync-template-status
// Manually check pending template statuses and move APPROVED → syncedMetaTemplates
// ────────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/sync-template-status", protect, async (req, res) => {
  const { clientId } = req.params;
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, error: "Client not found" });
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const result = await syncPendingTemplatesForClient(client);
    return res.json({
      success: true,
      checked: result.checked,
      approvedNow: result.approved,
      rejectedNow: result.rejected || 0,
      pendingRemaining: result.pendingRemaining ?? (result.updatedPending || []).length
    });
  } catch (err) {
    log.error(`[TemplateSync] Manual sync failed for ${clientId}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Canonical status sync endpoint (new contract)
router.post("/:clientId/template-status/sync", protect, async (req, res) => {
  const { clientId } = req.params;
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, error: "Client not found" });
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const result = await syncPendingTemplatesForClient(client);
    return res.json({
      success: true,
      source: "wizard",
      checkedTotal: result.checked || 0,
      approvedNow: result.approved || 0,
      rejectedNow: result.rejected || 0,
      pendingCount: result.pendingRemaining || 0
    });
  } catch (err) {
    log.error(`[TemplateSync] Canonical sync failed for ${clientId}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ────────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/submit-automation-templates
// Submits core bot templates (Welcome, Order Conf, Recovery, Admin Alerts)
// ────────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/submit-automation-templates", protect, async (req, res) => {
  const { clientId } = req.params;
  const { wizardData } = req.body;
  const axios = require("axios");

  try {
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const wabaId  = client.wabaId || client.whatsapp?.wabaId;
    const token   = client.whatsappToken || client.whatsapp?.accessToken;
    
    if (!wabaId || !token) {
      return res.status(422).json({ success: false, error: 'WhatsApp connection missing.' });
    }

    const allTemplates = getPrebuiltTemplates(wizardData || {});
    const automationTemplates = allTemplates.filter(t => !t.name.startsWith('prod_'));

    const submitted = [];
    const errors = [];

    for (const tpl of automationTemplates) {
      const components = tpl.components.map(c => {
        const comp = { ...c };
        delete comp._imageUrl;

        if (c.type === 'HEADER' && c.format === 'IMAGE') {
          comp.example = { header_handle: [tpl._imageUrl || wizardData.businessLogo || 'https://via.placeholder.com/800x400.png?text=Welcome+to+Our+Store'] };
        }

        if (c.type === 'BODY') {
          const samples = (tpl.variables || []).map(v => {
            const key = String(v || '').toLowerCase();
            if (key.includes('first_name') || key.includes('customer_first')) return wizardData.ownerName?.split(' ')?.[0] || 'Priya';
            if (key.includes('name')) return wizardData.businessName || 'Elite Store';
            if (key.includes('order_id')) return '#1030';
            if (key.includes('product_line')) return 'Smart Wireless Video Doorbell Plus (3MP)';
            if (key.includes('total_formatted') || key.includes('order_total')) return `${wizardData.currency || '₹'}6,499`;
            if (key.includes('total')) return '1,499';
            if (key.includes('items')) return 'Blue Denim Jacket, Cotton Tee';
            if (key.includes('cashback') || key.includes('incentive_cashback')) return `${wizardData.currency || '₹'}50 cashback`;
            if (key.includes('shipping') || key.includes('incentive_shipping')) return 'Priority shipping';
            if (key.includes('urgency')) return '2 hours';
            if (key.includes('url')) return 'https://topedgeai.com/demo';
            if (key.includes('phone')) return '+91 98765 43210';
            if (key.includes('context')) return 'Customer asked about shipping delay.';
            return 'Sample Value';
          });
          if (samples.length > 0) {
            comp.example = { body_text: [samples] };
          }
        }
        return comp;
      });

      const templatePayload = {
        name:     tpl.name,
        language: tpl.language || 'en',
        category: tpl.category || 'MARKETING',
        components
      };

      try {
        let accessToken = token;
        try {
          const { decrypt } = require('../utils/encryption');
          accessToken = decrypt(token) || token;
        } catch (_) {}

        const metaRes = await axios.post(
          `https://graph.facebook.com/v21.0/${wabaId}/message_templates`,
          templatePayload,
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );

        const newTemplate = {
          id:          metaRes.data.id || `pending_${tpl.name}`,
          name:        tpl.name,
          status:      'PENDING',
          category:    tpl.category,
          language:    tpl.language || 'en',
          components: JSON.parse(JSON.stringify(tpl.components || [])),
          variables:  tpl.variables,
          source:      'wizard_automation',
          createdAt:   new Date()
        };

        await Client.findByIdAndUpdate(client._id, {
          $pull:  { messageTemplates: { name: tpl.name }, pendingTemplates: { name: tpl.name } },
        });
        await Client.findByIdAndUpdate(client._id, {
          $push:  {
            messageTemplates: newTemplate,
            pendingTemplates: {
              name: tpl.name,
              status: "PENDING",
              metaId: metaRes.data.id || "",
              submittedAt: new Date()
            }
          },
        });

        submitted.push(tpl.name);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        if (/already exists|duplicate/i.test(String(msg))) {
          await Client.findByIdAndUpdate(client._id, {
            $pull: { messageTemplates: { name: tpl.name }, pendingTemplates: { name: tpl.name } }
          });
          await Client.findByIdAndUpdate(client._id, {
            $push: {
              messageTemplates: {
                id: `existing_${tpl.name}`,
                name: tpl.name,
                status: 'PENDING',
                category: tpl.category,
                language: tpl.language || 'en',
                components: JSON.parse(JSON.stringify(tpl.components || [])),
                variables: tpl.variables,
                source: 'wizard_automation',
                createdAt: new Date()
              },
              pendingTemplates: {
                name: tpl.name,
                status: "PENDING",
                metaId: "",
                submittedAt: new Date()
              }
            }
          });
          submitted.push(tpl.name);
        } else {
          errors.push({ template: tpl.name, error: msg });
        }
      }
    }

    res.json({
      success: errors.length === 0,
      submitted_count: submitted.length,
      submitted_names: submitted,
      errors,
      message: `${submitted.length} automation templates submitted. Ready for enterprise logic.`
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:clientId/verify-gemini", protect, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ success: false, error: "API Key is required" });

  try {
    // Phase 30: Use Fast wrapper with decrypt support
    let finalKey = apiKey;
    try {
        const { decrypt } = require('../utils/encryption');
        finalKey = decrypt(apiKey) || apiKey;
    } catch (_) {}

    log.info(`[Wizard] Verifying Gemini Key: ${finalKey.substring(0, 6)}...`);
    const result = await generateTextFast("Reply with 'OK'", finalKey, { maxTokens: 5, timeout: 3500 });
    
    if (result) {
      res.json({ success: true, message: "API Key is valid!" });
    } else {
      res.status(400).json({ success: false, error: "API Key check failed. Gemini returned no response (Check permissions/quota)." });
    }
  } catch (err) {
    log.error("[Wizard] Gemini Verification Error:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/wizard/:clientId/features
// Settings → Features panel calls this whenever a toggle flips. It updates
// `wizardFeatures.*` (canonical) + the legacy mirror fields, then kicks off
// a background flow regeneration so the change appears in FlowBuilder
// without a page reload.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:clientId/features", protect, async (req, res) => {
  const { clientId } = req.params;
  const { features = {}, profile = {}, regenerate = true } = req.body || {};

  try {
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const $set = mapFeatureToggle(features);

    // Additional profile fields that merchants need in the same UX surface.
    if (profile.supportEmail !== undefined)          $set["platformVars.supportEmail"] = profile.supportEmail || "";
    if (profile.warrantySupportPhone !== undefined)  $set["brand.warrantySupportPhone"] = profile.warrantySupportPhone || "";
    if (profile.warrantyClaimUrl !== undefined)      $set["brand.warrantyClaimUrl"] = profile.warrantyClaimUrl || "";
    if (profile.warrantyDuration !== undefined)      $set["brand.warrantyDefaultDuration"] = profile.warrantyDuration || "1 Year";
    if (profile.warrantyPolicy !== undefined)        $set["policies.warrantyPolicy"] = profile.warrantyPolicy || "";
    if (profile.loyaltySilverThreshold !== undefined) $set["loyaltyConfig.tierThresholds.silver"] = Number(profile.loyaltySilverThreshold) || 0;
    if (profile.loyaltyGoldThreshold !== undefined)   $set["loyaltyConfig.tierThresholds.gold"] = Number(profile.loyaltyGoldThreshold) || 0;

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: "No valid feature/profile fields supplied" });
    }

    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set },
      { new: true, runValidators: true }
    );
    if (!client) return res.status(404).json({ error: "Client not found" });

    let regenSummary = null;
    if (regenerate) {
      try {
        const wizardData = {
          businessName:       client.platformVars?.brandName || client.businessName,
          botName:            client.platformVars?.agentName || client.ai?.persona?.name,
          tone:               client.platformVars?.defaultTone || client.ai?.persona?.tone,
          botLanguage:        client.platformVars?.defaultLanguage || client.ai?.persona?.language,
          businessDescription:client.platformVars?.businessDescription,
          adminPhone:         client.platformVars?.adminWhatsappNumber || client.adminPhone,
          checkoutUrl:        client.platformVars?.checkoutUrl,
          googleReviewUrl:    client.platformVars?.googleReviewUrl,
          openTime:           client.platformVars?.openTime,
          closeTime:          client.platformVars?.closeTime,
          warrantyDuration:   client.wizardFeatures?.warrantyDuration || client.platformVars?.warrantyDuration,
          warrantySupportPhone: client.wizardFeatures?.warrantySupportPhone || client.brand?.warrantySupportPhone,
          warrantySupportEmail: client.wizardFeatures?.warrantySupportEmail || client.platformVars?.supportEmail,
          warrantyClaimUrl:   client.wizardFeatures?.warrantyClaimUrl || client.brand?.warrantyClaimUrl,
          currency:           client.platformVars?.baseCurrency,
          features:           (client.wizardFeatures && client.wizardFeatures.toObject) ? client.wizardFeatures.toObject() : client.wizardFeatures,
          replaceExisting:    true,
          preserveNodeIds:    true   // keeps active conversations alive on regen
        };
        const genOut = await generateEcommerceFlow(client, wizardData);
        const { nodes, edges } = genOut;

        clearTriggerCache(clientId);

        // Update client with the regenerated flow (legacy + visualFlows[active]).
        const visualFlows = client.visualFlows || [];
        const activeIdx = visualFlows.findIndex(f => f.isActive && f.platform === 'whatsapp');
        if (activeIdx !== -1) {
          visualFlows[activeIdx] = {
            ...visualFlows[activeIdx],
            nodes:       nodes.length > 20 ? [] : nodes,
            edges:       nodes.length > 20 ? [] : edges,
            nodeCount:   nodes.length,
            edgeCount:   edges.length,
            updatedAt:   new Date(),
            generatedBy: 'settings_features'
          };
        }
        await Client.findByIdAndUpdate(client._id, {
          $set: {
            flowNodes: nodes,
            flowEdges: edges,
            visualFlows
          }
        });

        // Live-notify dashboards.
        try {
          emitToClient(clientId, 'wizard:flow-regenerated', {
            clientId,
            source: 'feature_toggle',
            nodeCount: nodes.length,
            edgeCount: edges.length,
            generatedAt: new Date()
          });
        } catch (_) {}

        regenSummary = { nodes: nodes.length, edges: edges.length };
      } catch (genErr) {
        log.error(`[Features] Regen failed for ${clientId}: ${genErr.message}`);
        regenSummary = { error: genErr.message };
      }
    }

    res.json({
      success: true,
      features: client.wizardFeatures,
      profile: {
        supportEmail: client.platformVars?.supportEmail || "",
        warrantySupportPhone: client.brand?.warrantySupportPhone || "",
        warrantyClaimUrl: client.brand?.warrantyClaimUrl || "",
        warrantyDuration: client.brand?.warrantyDefaultDuration || client.wizardFeatures?.warrantyDuration || "1 Year",
        warrantyPolicy: client.policies?.warrantyPolicy || "",
        loyaltySilverThreshold: client.loyaltyConfig?.tierThresholds?.silver || client.wizardFeatures?.loyaltySilverThreshold || 0,
        loyaltyGoldThreshold: client.loyaltyConfig?.tierThresholds?.gold || client.wizardFeatures?.loyaltyGoldThreshold || 0
      },
      regen: regenSummary
    });
  } catch (err) {
    log.error(`[Features] PATCH failed for ${clientId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/wizard/:clientId/features  — used by Settings to hydrate the panel
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:clientId/features", protect, async (req, res) => {
  const { clientId } = req.params;
  try {
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const client = await Client.findOne({ clientId }).select('wizardFeatures policies platformVars brand loyaltyConfig wizardCompleted ai.persona').lean();
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json({
      success: true,
      wizardCompleted: client.wizardCompleted,
      features: client.wizardFeatures || {},
      profile: {
        supportEmail: client.platformVars?.supportEmail || "",
        warrantySupportPhone: client.brand?.warrantySupportPhone || "",
        warrantyClaimUrl: client.brand?.warrantyClaimUrl || "",
        warrantyDuration: client.brand?.warrantyDefaultDuration || client.wizardFeatures?.warrantyDuration || "1 Year",
        warrantyPolicy: client.policies?.warrantyPolicy || "",
        loyaltySilverThreshold: client.loyaltyConfig?.tierThresholds?.silver || client.wizardFeatures?.loyaltySilverThreshold || 0,
        loyaltyGoldThreshold: client.loyaltyConfig?.tierThresholds?.gold || client.wizardFeatures?.loyaltyGoldThreshold || 0
      },
      policies: client.policies || {},
      platformVars: client.platformVars || {},
      persona: client.ai?.persona || {}
    });
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
    const tenantId = tenantClientId(req);
    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    await Client.findOneAndUpdate({ clientId }, { $set: { wizardCompleted: false } });
    res.json({ success: true, message: "Wizard reset. Will show on next login." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NOTE: A duplicate `POST /:clientId/generate-from-url` handler used to live
// here. Express registers both but only the first one ever runs, so the
// second was dead code. Removed in Batch A.

router.syncPendingTemplatesForClient = syncPendingTemplatesForClient;
module.exports = router;
