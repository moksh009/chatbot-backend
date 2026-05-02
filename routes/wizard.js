"use strict";

const express = require("express");
const router  = express.Router();
const Client  = require("../models/Client");
const { protect } = require("../middleware/auth");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates } = require("../utils/flowGenerator");
const { withShopifyRetry } = require("../utils/shopifyHelper");
const { generateText, generateTextFast } = require("../utils/gemini");
const log = require("../utils/logger")("Wizard");

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
    checked += 1;
    const merged = { ...tpl, status, lastCheckedAt: new Date() };
    updatedMessage.push(merged);

    const pendingMeta = pendingMap.get(tpl.name) || {};
    if (status === "APPROVED") {
      approvedCount += 1;
      syncedMap.set(tpl.name, {
        name: tpl.name,
        status: "APPROVED",
        productHandle: pendingMeta.productHandle || tpl.productHandle || "",
        productId: pendingMeta.productId || tpl.productId || "",
        metaId: pendingMeta.metaId || tpl.id || "",
        approvedAt: new Date(),
        submittedAt: pendingMeta.submittedAt || tpl.createdAt || null
      });
      continue;
    }
    if (status === "REJECTED") rejectedCount += 1;

    // Keep not-yet-approved templates in pending state for later polling.
    updatedPending.push({
      ...pendingMeta,
      name: tpl.name,
      status,
      productHandle: pendingMeta.productHandle || tpl.productHandle || "",
      productId: pendingMeta.productId || tpl.productId || "",
      metaId: pendingMeta.metaId || tpl.id || "",
      submittedAt: pendingMeta.submittedAt || tpl.createdAt || null,
      lastCheckedAt: new Date()
    });
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

    // ✅ GAP-GEN-3: Isolate Commerce Automation Flows
    // Identify trigger nodes for commerce events
    const triggerTypes = ['order_placed', 'abandoned_cart', 'order_fulfilled'];
    const automationTriggers = nodes.filter(n => 
      n.type === 'trigger' && triggerTypes.includes(n.data?.triggerType)
    );

    let automationNodeIds = new Set();
    let automationEdgeIds = new Set();
    let automationFlows = [];

    // Helper to find all downstream nodes using BFS
    const extractSubgraph = (startNodeId) => {
      const subgraphNodeIds = new Set([startNodeId]);
      const subgraphEdgeIds = new Set();
      const queue = [startNodeId];

      while (queue.length > 0) {
        const currentId = queue.shift();
        // Find all outgoing edges from currentId
        const outgoingEdges = edges.filter(e => e.source === currentId);
        outgoingEdges.forEach(e => {
          subgraphEdgeIds.add(e.id);
          if (!subgraphNodeIds.has(e.target)) {
            subgraphNodeIds.add(e.target);
            queue.push(e.target);
          }
        });
      }
      return { nodes: subgraphNodeIds, edges: subgraphEdgeIds };
    };

    // Extract each automation flow
    for (const trig of automationTriggers) {
      const sub = extractSubgraph(trig.id);
      sub.nodes.forEach(id => automationNodeIds.add(id));
      sub.edges.forEach(id => automationEdgeIds.add(id));

      const subNodes = nodes.filter(n => sub.nodes.has(n.id));
      const subEdges = edges.filter(e => sub.edges.has(e.id));

      const autoFlowId = `auto_${trig.data.triggerType}_${Date.now()}`;
      const autoFlow = await WhatsAppFlow.create({
        clientId,
        flowId: autoFlowId,
        name: `Automation: ${trig.data.triggerType}`,
        platform: 'whatsapp',
        nodes: subNodes,
        edges: subEdges,
        status: 'PUBLISHED',
        isAutomation: true,
        automationTrigger: trig.data.triggerType
      });
      automationFlows.push(autoFlow);
      console.log(`[Wizard] Extracted automation flow: ${trig.data.triggerType} (${subNodes.length} nodes)`);
    }

    // Filter main flow to exclude automation nodes
    const mainNodes = nodes.filter(n => !automationNodeIds.has(n.id));
    const mainEdges = edges.filter(e => !automationEdgeIds.has(e.id));

    // Update newFlow to use filtered main nodes
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
        status:   'PUBLISHED'
      });
      newFlow.flowModelId = storedFlow._id;
      console.log(`[Wizard] Main flow offloaded to WhatsAppFlow model: ${storedFlow._id} (${mainNodes.length} nodes)`);
    }

    // Update the client document:
    // 1. Mark wizard as complete
    // 2. SET the business/bot settings (last-one-wins from wizard)
    // 3. PUSH the new flow into visualFlows (so they keeping growing a list)
    // 4. SET flowNodes/flowEdges to the newest one (for legacy engine support)
    
    const settingsUpdate = {
      wizardCompleted:    true,
      wizardCompletedAt:  new Date(),
      isAIFallbackEnabled: true,
      // Phase R4 Fix: use full nodes/edges arrays for dual-brain engine
      // (not newFlow.nodes which is intentionally empty when > 20 nodes)
      ...(wizardData.replaceExisting !== false && { 
        flowNodes: mainNodes, 
        flowEdges: mainEdges
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
      ...(wizardData.systemPrompt               && { 
        systemPrompt,
        'ai.systemPrompt': systemPrompt
      }),
      ...(wizardData.currency && { "brand.currency": wizardData.currency }),
      ...(wizardData.shippingTime && { "config.shippingTime": wizardData.shippingTime }),
      // Platform Vars
      'platformVars.brandName': wizardData.businessName,
      'platformVars.agentName': wizardData.botName,
      'platformVars.baseCurrency': wizardData.currency || '₹',
      'platformVars.shippingTime': wizardData.shippingTime,
      'platformVars.adminWhatsappNumber': wizardData.adminPhone,
      'platformVars.checkoutUrl': wizardData.checkoutUrl || (client.shopDomain ? `https://${client.shopDomain}/checkout` : ''),
      'platformVars.businessDescription': wizardData.businessDescription,
      'platformVars.openTime': wizardData.openTime,
      'platformVars.closeTime': wizardData.closeTime,
      'platformVars.warrantyDuration': wizardData.warrantyDuration,
      'platformVars.defaultLanguage': wizardData.botLanguage,
      'platformVars.defaultTone': wizardData.tone,

      ...(wizardData.faqText && { "faq": [{ question: 'About Us / General', answer: wizardData.faqText, order: 1 }] }),
      
      // Gemini key powers bot fallback. Also mirror into openaiApiKey for legacy engine paths.
      ...(wizardData.geminiApiKey && { geminiApiKey: wizardData.geminiApiKey, openaiApiKey: wizardData.geminiApiKey }),
      // Product display mode: 'template' | 'manual'
      ...(wizardData.productMode && { 'config.productMode': wizardData.productMode }),
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
              nudge1_offset_ms: (wizardData.cartTiming.msg1 || 15) * 60 * 1000,
              nudge2_offset_ms: (wizardData.cartTiming.msg2 || 2) * 60 * 60 * 1000,
              nudge3_offset_ms: (wizardData.cartTiming.msg3 || 24) * 60 * 60 * 1000,
              timing_mode: 'absolute'
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
      ...(wizardData.referralPoints && { 
        "brand.referralPoints": wizardData.referralPoints,
        "loyaltyConfig.pointsPerCurrency": wizardData.referralPoints,
        "loyaltyConfig.pointsPerUnit": wizardData.referralPoints,
        "loyaltyConfig.isEnabled": true
      }),
      ...(wizardData.signupPoints   && { 
        "brand.signupPoints": wizardData.signupPoints,
        "loyaltyConfig.welcomeBonus": wizardData.signupPoints
      }),
      ...(wizardData.is247 !== undefined && { "config.businessHours.is247": wizardData.is247 }),
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
      ...(wizardData.warrantyPolicy && { "brand.warrantyPolicy": wizardData.warrantyPolicy }),
      ...(wizardData.warrantySupportPhone && { 
        "brand.warrantySupportPhone": wizardData.warrantySupportPhone,
        "warrantyConfig.supportPhone": wizardData.warrantySupportPhone 
      }),
      ...(wizardData.warrantyClaimUrl && { 
        "brand.warrantyClaimUrl": wizardData.warrantyClaimUrl,
        "warrantyConfig.claimUrl": wizardData.warrantyClaimUrl 
      }),
      ...(wizardData.warrantyEmailEnabled !== undefined && { 
        "warrantyConfig.emailEnabled": wizardData.warrantyEmailEnabled 
      }),
      ...(wizardData.warrantyWhatsappEnabled !== undefined && { 
        "warrantyConfig.whatsappEnabled": wizardData.warrantyWhatsappEnabled 
      }),
      ...(wizardData.autoAssignWarranty !== undefined && { 
        "warrantyConfig.autoAssign": wizardData.autoAssignWarranty 
      })
    };

    // Handle customTemplates (push them separately after main update)
    const customTemplatesPush = (wizardData.customTemplates && wizardData.customTemplates.length > 0)
      ? wizardData.customTemplates.map(t => ({ ...t, status: 'PENDING', source: 'wizard_custom', createdAt: new Date() }))
      : [];

    // If replaceExisting, update the active main flow's nodes instead of always pushing
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
          nodes: newFlow.nodes,
          edges: newFlow.edges,
          flowModelId: newFlow.flowModelId,
          updatedAt: new Date(),
          generatedBy: 'wizard'
        };
        updateQuery = { $set: { ...settingsUpdate, visualFlows: existingFlows } };
      } else {
        newFlow.isActive = true;
        updateQuery = { $set: settingsUpdate, $push: { visualFlows: newFlow } };
      }
    } else {
      // Add as new flow (keep existing active ones)
      updateQuery = {
        $set: settingsUpdate,
        $push: { visualFlows: newFlow }
      };
    }

    // Final update with all settings + the new flow
    const updatedClient = await Client.findByIdAndUpdate(client._id, updateQuery, { new: true, runValidators: true });
    
    console.log(`[Wizard] Completed successfully for ${clientId}. wizardCompleted: ${updatedClient.wizardCompleted}`);
    
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
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json" } });
    
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

    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
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
    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
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
    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
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

    if (req.user.role !== "SUPER_ADMIN" && req.user.clientId !== clientId) {
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
            if (v.includes('name')) return wizardData.businessName || 'Elite Store';
            if (v.includes('order_id')) return '#89201';
            if (v.includes('total')) return '1,499';
            if (v.includes('items')) return 'Blue Denim Jacket, Cotton Tee';
            if (v.includes('url')) return 'https://topedgeai.com/demo';
            if (v.includes('phone')) return '+91 98765 43210';
            if (v.includes('context')) return 'Customer asked about shipping delay.';
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/wizard/:clientId/generate-from-url
// Scrapes the provided URL and generates a robust AI system prompt + FAQs
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:clientId/generate-from-url", protect, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    // 1. Scrape the URL
    const axios = require('axios');
    let rawData = "";
    try {
      const resp = await axios.get(url, { timeout: 10000 });
      // Simple HTML to text extraction
      rawData = resp.data.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                         .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim()
                         .substring(0, 15000); // 15k char limits
      if (!rawData) throw new Error("No text found");
    } catch (e) {
      return res.status(400).json({ error: "Failed to scrape URL: " + e.message });
    }

    // 2. Fetch Gemini API key (Priorities: 1. Request Body, 2. Stored Client Key, 3. Server Fallback)
    const client = await Client.findOne({ clientId: req.params.clientId });
    const apiKey = req.body.geminiApiKey || client?.geminiApiKey || process.env.GEMINI_API_KEY;

    // 3. Build Prompt for Gemini
    const prompt = `As an expert AI architect, extract core business intelligence from the following website text:
---
${rawData}
---
Generate a highly structured JSON object with two fields:
1. "systemPrompt": A comprehensive system prompt instructing how an AI Assistant should represent this business on WhatsApp. Include their tone, policies, core offerings, and rules.
2. "faqText": A concise string of 3-5 of the most important frequently asked questions and their answers based ONLY on the text above.

Output strictly valid JSON exactly in this format: { "systemPrompt": "...", "faqText": "..." }`;

    // 4. Generate with Gemini
    const generated = await generateText(prompt, apiKey);
    
    // Parse the JSON output
    let parsedData = { systemPrompt: "Failed to generate prompt.", faqText: "" };
    try {
      const jsonStr = generated.replace(/```json|```/g, "").trim();
      parsedData = JSON.parse(jsonStr);
    } catch(e) {
      console.warn("Failed to parse Gemini output as JSON. Output:", generated);
      parsedData.systemPrompt = generated; // Fallback to raw text
    }

    res.json({ success: true, data: parsedData });
  } catch (err) {
    console.error("URL Prompt Gen Error:", err);
    res.status(500).json({ error: "Failed to generate AI brain from URL." });
  }
});

router.syncPendingTemplatesForClient = syncPendingTemplatesForClient;
module.exports = router;
