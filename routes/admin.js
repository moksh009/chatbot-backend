const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const log = require('../utils/logger')('AdminAPI');
const { getDefaultFlowForNiche } = require('../utils/defaultFlowNodes');
const { generateFlowForClient } = require('../utils/flowAutogen');
const { convertLegacyToVisual } = require('../utils/legacyConverter');
const { runFullMigration } = require('../scripts/phase9MigrationLogic');
const { getGeminiModel } = require('../utils/gemini');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { encrypt } = require('../utils/encryption');
const { sanitizeMiddleware } = require('../utils/sanitize');

router.post('/shopify/force-sync', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const { refreshShopifyToken } = require('../utils/shopifyHelper');
    const result = await refreshShopifyToken(client);

    if (result.success) {
      res.json({ success: true, message: 'Shopify connection re-synchronized' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to re-synchronize Shopify connection', error: result.error });
    }
  } catch (err) {
    log.error('Error forcing Shopify sync', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

const CLIENT_CODE_DIR = path.join(__dirname, 'clientcodes');

// Middleware to check if user is a Super Admin
const isSuperAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (user && user.role === 'SUPER_ADMIN') {
      next();
    } else {
      res.status(403).json({ message: 'Access denied: Super Admin only' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// --- GET ALL CLIENTS ---
router.get('/clients', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const filter = { isActive: { $ne: false } };
    if (req.query.search) {
      filter.$or = [
        { businessName: { $regex: req.query.search, $options: 'i' } },
        { clientId: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const clients = await Client.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const total = await Client.countDocuments(filter);

    res.json({
      success: true,
      data: clients,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    log.error('Error fetching clients', { error: err.message });
    res.status(500).json({ message: 'Server error' });
  }
});

// --- RUN AUTOMATION MIGRATION (Super Admin) ---
// Temporarily public for easy browser execution (Add basic secret key param for safety)
router.get('/run-migration', async (req, res) => {
  try {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    const defaultAutomationFlows = [
      { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
      { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
      { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
    ];

    const defaultMessageTemplates = [
      {
        id: "cod_to_prepaid",
        body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
        buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
      },
      {
        id: "review_request",
        body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
        buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
      }
    ];

    const clients = await Client.find({});
    let updated = 0;

    for (const client of clients) {
        let isModified = false;

        // Seed default flow nodes if not already set
        if (!client.flowNodes || client.flowNodes.length === 0) {
          const niche = client.niche || client.businessType || 'other';
          const defaultFlow = getDefaultFlowForNiche(niche);
          client.flowNodes = defaultFlow.nodes;
          client.flowEdges = defaultFlow.edges;
          isModified = true;
        }

        if (!client.automationFlows || client.automationFlows.length === 0) {
            client.automationFlows = defaultAutomationFlows;
            isModified = true;
        } else {
             for (const defaultFlow of defaultAutomationFlows) {
                 if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                     client.automationFlows.push(defaultFlow);
                     isModified = true;
                 }
             }
        }

        if (!client.messageTemplates || client.messageTemplates.length === 0) {
             client.messageTemplates = defaultMessageTemplates;
             isModified = true;
        } else {
             for (const defaultTemp of defaultMessageTemplates) {
                 if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                     client.messageTemplates.push(defaultTemp);
                     isModified = true;
                 }
             }
        }

        if (isModified) {
            const setFields = {};
            if (client.flowNodes) setFields.flowNodes = client.flowNodes;
            if (client.flowEdges) setFields.flowEdges = client.flowEdges;
            if (client.automationFlows) setFields.automationFlows = client.automationFlows;
            if (client.messageTemplates) setFields.messageTemplates = client.messageTemplates;

            await Client.updateOne(
              { _id: client._id },
              { $set: setFields },
              { runValidators: false }
            );
            updated++;
        }
    }

    res.json({ success: true, message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROLE PROMOTION (EMERGENCY DEBUG) ---
router.get('/promote-me', async (req, res) => {
  try {
    const { email, role, secret } = req.query;
    if (secret !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?secret=topedge_secure_admin_123' });
    }
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.role = role || 'SUPER_ADMIN';
    await user.save();
    res.json({ success: true, message: `User ${email} promoted to ${user.role}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- RUN DELITECH MIGRATION (URL RUNNABLE) ---
router.get('/run-delitech-migration', async (req, res) => {
  try {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    const IMAGES = {
        hero_3mp: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
        hero_5mp: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346',
        hero_2mp: 'https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png?v=1770617818&width=1346',
        features: 'https://delitechsmarthome.in/cdn/shop/files/image241.png?v=1762148394&width=1346'
    };

    const DELITECH_NODES = [
      // ─── FOLDERS (Containers) ───────────────────────────────────────────
      { id: "f_welcome", type: "folder", position: { x: 400, y: 0 }, data: { label: "🏠 Welcome & Menu" } },
      { id: "f_catalog", type: "folder", position: { x: 0, y: 300 }, data: { label: "🛍️ Product Catalog" } },
      { id: "f_support", type: "folder", position: { x: 400, y: 300 }, data: { label: "🛠️ Technical Support" } },
      { id: "f_orders",  type: "folder", position: { x: 800, y: 300 }, data: { label: "📞 Order Desk" } },

      // ─── WELCOME FOLDER NODES ───────────────────────────────────────────
      { id: "trigger_start", type: "trigger", parentId: "f_welcome", position: { x: 100, y: 50 }, 
        data: { label: "Main Entry Trigger", keyword: "hi,hello,hey,hola,details,price,doorbell,catalogue,info" } 
      },
      { id: "menu_main", type: "interactive", parentId: "f_welcome", position: { x: 100, y: 200 }, data: { 
        label: "Welcome Concierge", 
        interactiveType: "list",
        header: "Delitech Smart Home",
        body: "Welcome to Delitech! 🏠\nInvest in your family's safety. Select a model below to view exclusive photos and pricing:\n\n*(Tip: Over 80% of our customers choose the 3MP Pro for absolute clarity)*",
        listButtonTitle: "Explore Options",
        sections: [
          { title: "Premium Security", rows: [
              { id: "sel_5mp", title: "Doorbell Pro (5MP)", description: "Ultimate Clarity & Smart AI" },
              { id: "sel_3mp", title: "Doorbell Plus (3MP)", description: "2K Video & Color Night Vision" }
            ]
          },
          { title: "Essential Security", rows: [
              { id: "sel_2mp", title: "Doorbell (2MP)", description: "Standard HD & 2-Way Talk" }
            ]
          },
          { title: "Support & Help", rows: [
              { id: "menu_agent", title: "Consult an Expert", description: "Get a free security callback" },
              { id: "menu_faqs", title: "Setup & FAQ", description: "Installation & Battery info" }
            ]
          }
        ]
      }},

      // ─── CATALOG FOLDER NODES ───────────────────────────────────────────
      { id: "card_5mp", type: "interactive", parentId: "f_catalog", position: { x: 50, y: 50 }, data: { 
        label: "5MP Pro Card", 
        interactiveType: "button",
        imageUrl: IMAGES.hero_5mp,
        body: "🛡️ *Delitech Smart Video Doorbell Pro (5MP)*\n\nThe ultimate peace-of-mind solution. Unmatched clarity and premium security.\n\n💎 *5MP Crystal-Clear Resolution*\n👀 *Ultra-Wide View*\n🌈 *Color Night Vision*\n\n💰 *Offer Price:* ₹6,999\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
        buttonsList: [
          { id: "buy_5mp_node", title: "🛒 Buy Now" },
          { id: "agent_5mp", title: "📞 Call Me" },
          { id: "back_main", title: "View Other" }
        ]
      }},
      { id: "card_3mp", type: "interactive", parentId: "f_catalog", position: { x: 450, y: 50 }, data: { 
        label: "3MP Plus Card", 
        interactiveType: "button",
        imageUrl: IMAGES.hero_3mp,
        body: "🛡️ *Delitech Smart Video Doorbell Plus (3MP)*\n\nThe perfect balance of affordability and HD security.\n\n📹 *2K Crisp Video*\n🌈 *Color Night Vision*\n🗣️ *Real-Time 2-Way Audio*\n\n💰 *Offer Price:* ₹6,499\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
        buttonsList: [
          { id: "buy_3mp_node", title: "🛒 Buy Now" },
          { id: "agent_3mp", title: "📞 Call Me" },
          { id: "back_main_2", title: "View Other" }
        ]
      }},
      { id: "card_2mp", type: "interactive", parentId: "f_catalog", position: { x: 850, y: 50 }, data: { 
        label: "2MP Standard Card", 
        interactiveType: "button",
        imageUrl: IMAGES.hero_2mp,
        body: "🛡️ *Delitech Smart Video Doorbell (2MP)*\n\nEssential home security made simple.\n\n📹 *1080p HD Video*\n🌙 *Night Vision*\n🗣️ *2-Way Audio*\n\n💰 *Offer Price:* ₹5,499\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
        buttonsList: [
          { id: "buy_2mp_node", title: "🛒 Buy Now" },
          { id: "agent_2mp", title: "📞 Call Me" },
          { id: "back_main_3", title: "View Other" }
        ]
      }},
      
      // Node Actions for Purchasing (Variable Injector handled)
      { id: "act_buy_5mp", type: "action", parentId: "f_catalog", position: { x: 50, y: 350 }, data: {
          label: "Send 5MP Link",
          actionType: "SEND_PURCHASE_LINK",
          productType: "5mp",
          message: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_5mp}}\n\n_Cash on Delivery Available_"
      }},
      { id: "act_buy_3mp", type: "action", parentId: "f_catalog", position: { x: 450, y: 350 }, data: {
          label: "Send 3MP Link",
          actionType: "SEND_PURCHASE_LINK",
          productType: "3mp",
          message: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_3mp}}\n\n_Cash on Delivery Available_"
      }},
      { id: "act_buy_2mp", type: "action", parentId: "f_catalog", position: { x: 850, y: 350 }, data: {
          label: "Send 2MP Link",
          actionType: "SEND_PURCHASE_LINK",
          productType: "2mp",
          message: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_2mp}}\n\n_Cash on Delivery Available_"
      }},

      // ─── SUPPORT FOLDER NODES ───────────────────────────────────────────
      { id: "ans_install", type: "message", parentId: "f_support", position: { x: 50, y: 50 }, data: { 
        label: "Installation FAQ", 
        body: "🛠️ *Is it hard to install?*\nNot at all! It's *100% Wireless DIY*. Installation takes exactly 2 minutes. You can stick it or screw it to the wall instantly." 
      }},
      { id: "ans_battery", type: "message", parentId: "f_support", position: { x: 450, y: 50 }, data: { 
        label: "Battery FAQ", 
        body: "🔋 *How long does the battery last?*\nThe IP65 weatherproof battery lasts *up to 6 months* on a single charge! Simply recharge it via the included USB cable." 
      }},
      { id: "ans_warranty", type: "message", parentId: "f_support", position: { x: 850, y: 50 }, data: { 
        label: "Warranty FAQ", 
        body: "🛡️ *What about Warranty?*\nEnjoy complete peace of mind with our *1-Year Replacement Warranty* on any manufacturing defects." 
      }},
      { id: "trig_waterproof", type: "trigger", parentId: "f_support", position: { x: 50, y: 200 }, data: { label: "Waterproof Trigger", keyword: "waterproof,rain,weather" } },
      { id: "msg_waterproof", type: "message", parentId: "f_support", position: { x: 50, y: 350 }, data: { label: "Waterproof Info", body: "🌦️ *IP65 Weatherproof Guarantee*\n\nYes! Our Doorbells are built to withstand the heaviest Indian monsoons and intense summer heat." } },

      // ─── ORDERS FOLDER NODES ───────────────────────────────────────────
      { id: "track_order_msg", type: "message", parentId: "f_orders", position: { x: 100, y: 50 }, data: { label: "Track System", body: "📦 *Tracking your order...*\nPlease provide your Order ID (e.g. #1234) and I will fetch the live status for you!" } },
      { id: "agent_handover", type: "livechat", parentId: "f_orders", position: { x: 100, y: 200 }, data: { 
        label: "Talk to Expert", 
        body: "✅ *Request Received!*\n\nOur security expert has been notified. They will call you shortly on this number to assist you." 
      }}
    ];

    const DELITECH_EDGES = [
      // Welcome Folder Edges
      { id: "e_start_menu", source: "trigger_start", target: "menu_main" },
      { id: "e_menu_5mp", source: "menu_main", target: "f_catalog", sourceHandle: "sel_5mp" },
      { id: "e_menu_3mp", source: "menu_main", target: "f_catalog", sourceHandle: "sel_3mp" },
      { id: "e_menu_2mp", source: "menu_main", target: "f_catalog", sourceHandle: "sel_2mp" },
      { id: "e_menu_agent", source: "menu_main", target: "f_orders", sourceHandle: "menu_agent" },
      { id: "e_menu_faqs", source: "menu_main", target: "f_support", sourceHandle: "menu_faqs" },
      
      // Catalog Folder Internal Edges
      { id: "e_card_5mp_buy", source: "card_5mp", target: "act_buy_5mp", sourceHandle: "buy_5mp_node" },
      { id: "e_card_5mp_call", source: "card_5mp", target: "f_orders", sourceHandle: "agent_5mp" },
      { id: "e_card_5mp_back", source: "card_5mp", target: "f_welcome", sourceHandle: "back_main" },

      { id: "e_card_3mp_buy", source: "card_3mp", target: "act_buy_3mp", sourceHandle: "buy_3mp_node" },
      { id: "e_card_3mp_call", source: "card_3mp", target: "f_orders", sourceHandle: "agent_3mp" },
      { id: "e_card_3mp_back", source: "card_3mp", target: "f_welcome", sourceHandle: "back_main_2" },

      { id: "e_card_2mp_buy", source: "card_2mp", target: "act_buy_2mp", sourceHandle: "buy_2mp_node" },
      { id: "e_card_2mp_call", source: "card_2mp", target: "f_orders", sourceHandle: "agent_2mp" },
      { id: "e_card_2mp_back", source: "card_2mp", target: "f_welcome", sourceHandle: "back_main_3" },

      // Support Folder Internal Edges
      { id: "e_trig_wp", source: "trig_waterproof", target: "msg_waterproof" }
    ];

    await Client.findOneAndUpdate(
      { clientId: "delitech_smarthomes" },
      { $set: { 
        flowNodes: DELITECH_NODES, 
        flowEdges: DELITECH_EDGES,
        businessType: "ecommerce",
        niche: "ecommerce",
        isGenericBot: true, // Dual Brain Enabled
        plan: "CX Agent (V2)",
        "billing.plan": "CX Agent (V2)"
      }}
    );

    res.json({ success: true, message: "Delitech high-fidelity Dual-Brain flow migrated successfully!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUN GENERIC FOLDERIZATION (URL RUNNABLE) ---
router.get('/folderize-clients', async (req, res) => {
  try {
    const { key, target } = req.query;
    if (key !== 'topedge_secure_admin_123') {
      return res.status(401).json({ message: 'Unauthorized. Use ?key=topedge_secure_admin_123' });
    }

    // Default to the major ones we know lack the strict new folder structure,
    // or allow targeting a specific one via ?target=client_id
    const clientsToFix = target ? [target] : ['choice_salon', 'delitech_smarthomes'];
    const results = [];
    
    const flowTemplates = require('../data/flowTemplates');

    for (const clientId of clientsToFix) {
      const client = await Client.findOne({ clientId });
      if (!client) {
          results.push(`Skipping ${clientId}: Client not found.`);
          continue;
      }

      // Determine template to apply based on businessType or niche
      const typeKey = client.businessType === 'salon' || client.niche === 'salon' || clientId.includes('salon') 
          ? 'salon' 
          : 'ecommerce';
          
      const template = flowTemplates[typeKey];

      if (!template) {
        results.push(`Skipping ${clientId}: No template available for type ${typeKey}`);
        continue;
      }

      // Build out variables for substitution
      const brandName = client.name || clientId.replace('_', ' ');
      const nicheData = client.nicheData || {};
      const storeUrl = nicheData.storeUrl || '';
      const buyUrl = nicheData.buyUrl || storeUrl;
      const products = nicheData.products || [];
      const productList = products.length
        ? products.map((p, i) => `${i + 1}. ${p.name || p.title} — ₹${p.price}`).join('\n')
        : 'Products coming soon!';

      const substituteVars = (str = '') =>
        str
          .replace(/{{brand_name}}/g, brandName)
          .replace(/{{store_url}}/g, storeUrl)
          .replace(/{{buy_url}}/g, buyUrl)
          .replace(/{{product_list}}/g, productList);

      const personalizedNodes = template.nodes.map(n => ({
        ...n,
        data: {
          ...n.data,
          body: substituteVars(n.data?.body || ''),
          header: substituteVars(n.data?.header || ''),
          text: substituteVars(n.data?.text || '')
        }
      }));

      // Fully overwrite the flow with the best-practice folder structure
      await Client.updateOne(
        { clientId }, 
        { $set: { flowNodes: personalizedNodes, flowEdges: template.edges } }
      );
      
      results.push(`Successfully re-templated and folderized ${clientId} using ${typeKey} structure.`);
    }

    res.json({ success: true, message: "Template injection and folderization complete", results });
  } catch (err) {
    res.status(500).json({ error: 'Folderization failed: ' + err.message });
  }
});

// --- GET CLIENT BY ID ---
router.get('/clients/:id', protect, isSuperAdmin, sanitizeMiddleware, async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json(client);
  } catch (err) {
    console.error('Error fetching client details:', err);
    res.status(500).json({ message: 'Server error fetching client details' });
  }
});

// --- CREATE NEW CLIENT ---
router.post('/clients', protect, isSuperAdmin, async (req, res) => {
  try {
    const {
      clientId, businessName, businessType, tier, phoneNumberId, 
      whatsappToken, verifyToken: webhookVerifyToken, wabaId,
      adminEmail // Admin can specify client's primary email
    } = req.body;

    // 1. Mandatory Validation
    if (!clientId || !businessName || !phoneNumberId) {
      return res.status(400).json({ message: 'clientId, businessName, and phoneNumberId are required' });
    }

    const existingClient = await Client.findOne({ clientId });
    if (existingClient) {
      return res.status(400).json({ message: 'Client ID already exists' });
    }

    // 2. Auto-generate System Prompt if missing
    let systemPrompt = req.body.systemPrompt;
    if (!systemPrompt) {
      const { generateText } = require('../utils/gemini');
      systemPrompt = await generateText(`Generate a professional personality system prompt for a WhatsApp business named "${businessName}". Business type is ${businessType || 'general'}. Keep it concise, helpful, and friendly.`);
    }

    // 3. Prepare Dual-Write Payload (Tier 2.5 Parallel Run)
    // Map incoming flat fields to the new modular sub-documents
    const clientData = {
      ...req.body,
      clientId: clientId.trim(),
      businessName,
      name: businessName, // Legacy sync
      systemPrompt: systemPrompt || 'You are a helpful assistant.',
      isActive: true,
      flowNodes: [],
      flowEdges: [],
      
      // -- NEW TIER 2.5 SUB-DOCUMENTS --
      brand: {
        businessName: businessName,
        niche: req.body.niche || 'other',
        businessType: businessType || 'other',
        adminPhone: req.body.adminPhone || '',
        googleReviewUrl: req.body.googleReviewUrl || ''
      },
      whatsapp: {
        phoneNumberId: phoneNumberId,
        wabaId: req.body.wabaId || '',
        accessToken: req.body.whatsappToken || '',
        verifyToken: req.body.verifyToken || ''
      },
      commerce: {
        storeType: req.body.storeType || 'shopify',
        shopify: {
          domain: req.body.shopDomain || '',
          accessToken: req.body.shopifyAccessToken || '',
          clientId: req.body.shopifyClientId || '',
          clientSecret: req.body.shopifyClientSecret || '',
          webhookSecret: req.body.shopifyWebhookSecret || ''
        },
        woocommerce: {
          url: req.body.woocommerceUrl || '',
          key: req.body.woocommerceKey || '',
          secret: req.body.woocommerceSecret || '',
          webhookSecret: req.body.woocommerceWebhookSecret || ''
        }
      },
      ai: {
        geminiKey: req.body.geminiApiKey || '',
        openaiKey: req.body.openaiApiKey || '',
        systemPrompt: systemPrompt || 'You are a helpful assistant.',
        fallbackEnabled: req.body.isAIFallbackEnabled !== false
      },
      billing: {
        tier: req.body.tier || 'v1',
        plan: req.body.plan || 'CX Agent (V1)',
        trialActive: true,
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      social: {
        instagram: {
          pageId: req.body.instagramPageId || '',
          accessToken: req.body.instagramAccessToken || '',
          appSecret: req.body.instagramAppSecret || '',
          username: req.body.instagramUsername || ''
        },
        metaAds: {
          accountId: req.body.metaAdAccountId || '',
          accessToken: req.body.metaAdsToken || ''
        }
      }
    };

    // Note: Manual encryption loop removed. TopEdge AI Client Schema pre-save hooks 
    // now automatically encrypt all sensitive credentials (legacy + new sub-docs).
    const newClient = new Client(clientData);

    const savedClient = await newClient.save();

    // ── AUTOMATED USER PROVISIONING ──
    const crypto = require('crypto');
    const generatedPassword = crypto.randomBytes(4).toString('hex'); // 8 chars
    const loginEmail = adminEmail || `${clientId.trim().toLowerCase()}@chatbot.com`;

    const newUser = new User({
      name: businessName,
      email: loginEmail,
      password: generatedPassword,
      role: 'CLIENT_ADMIN',
      clientId: clientId.trim(),
      business_type: businessType || 'ecommerce'
    });
    
    await newUser.save();

    // ── PHASE 10: Inject pre-built flow template if available ──────────────
    const flowTemplates = require('../data/flowTemplates');
    const template      = flowTemplates[businessType] || flowTemplates[niche];

    if (template) {
      const brandName   = newClient.name || 'us';
      const storeUrl    = (nicheData && nicheData.storeUrl)  || '';
      const buyUrl      = (nicheData && nicheData.buyUrl)    || storeUrl;
      const products    = (nicheData && nicheData.products)  || [];
      const productList = products.length
        ? products.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n')
        : 'Products coming soon!';

      const substituteVars = (str = '') =>
        str
          .replace(/{{brand_name}}/g,   brandName)
          .replace(/{{store_url}}/g,    storeUrl)
          .replace(/{{buy_url}}/g,      buyUrl)
          .replace(/{{product_list}}/g, productList);

      const personalizedNodes = template.nodes.map(n => ({
        ...n,
        data: {
          ...n.data,
          body:   substituteVars(n.data?.body   || ''),
          header: substituteVars(n.data?.header || '')
        }
      }));

      await Client.findByIdAndUpdate(savedClient._id, {
        $set: { flowNodes: personalizedNodes, flowEdges: template.edges }
      });
      log.success(`Pre-built flow template injected for: ${clientId} (type: ${businessType || niche})`);
    }

    log.success(`New client provisioned: ${clientId} | Plan: ${tier || 'Growth'}`);
    res.status(201).json({ 
      ...savedClient.toObject(), 
      flowReady: !!template,
      credentials: {
        email: loginEmail,
        password: generatedPassword
      }
    });

  } catch (err) {
    log.error('Error creating client', { error: err.message });
    res.status(500).json({ message: 'Server error creating client', error: err.message });
  }
});

// --- RESET CLIENT PASSWORD ---
router.put('/clients/:clientId/reset-password', protect, isSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const crypto = require('crypto');
    const newPassword = crypto.randomBytes(4).toString('hex');

    const user = await User.findOne({ clientId, role: 'CLIENT_ADMIN' });
    if (!user) return res.status(404).json({ message: 'Client Admin user not found' });

    user.password = newPassword;
    await user.save();

    log.success(`Password reset for client: ${clientId}`);
    res.json({
      success: true,
      message: 'Password reset successful',
      credentials: {
        email: user.email,
        password: newPassword
      }
    });
  } catch (err) {
    log.error('Password reset failed', { error: err.message });
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

// --- REPAIR ACCESS (For Delitech/Enterprise manual recovery) ---
router.get('/repair-delitech', async (req, res) => {
  try {
    const clientId = 'delitech_smarthomes';
    const update = {
      plan: 'CX Agent (V2)',
      'billing.plan': 'CX Agent (V2)',
      tier: 'v2',
      'billing.tier': 'v2',
      trialActive: false,
      'billing.trialActive': false,
      trialEndsAt: null,
      'billing.trialEndsAt': null,
      isPaidAccount: true,
      'billing.isPaidAccount': true
    };

    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: update },
      { new: true, runValidators: false }
    );

    if (!client) return res.status(404).json({ message: 'Client not found' });

    log.success(`Repaired client access: ${clientId}`);
    res.json({ message: 'Account access successfully repaired and set to Enterprise Plan (V2).', client });
  } catch (err) {
    log.error('Repair failed', { error: err.message });
    res.status(500).json({ message: 'Repair failed', error: err.message });
  }
});

// --- UPDATE CLIENT ---
router.put('/clients/:id', protect, isSuperAdmin, async (req, res) => {
  try {
    log.info(`Updating client: ${req.params.id}`);
    const {
      name, businessType, niche, plan, isGenericBot, phoneNumberId, whatsappToken,
      verifyToken: webhookVerifyToken, googleCalendarId, openaiApiKey, nicheData, flowData,
      automationFlows, messageTemplates, wabaId, emailUser, emailAppPassword,
      razorpayKeyId, razorpaySecret, adminPhone,
      shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl,
      trialActive, trialEndsAt
    } = req.body;

    // Recursively strip any _id fields that are not strings (prevents CastErrors/Buffer crashes)
    const deepCleanIds = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(deepCleanIds);
      
      const newObj = { ...obj };
      if (newObj._id && typeof newObj._id !== 'string') {
        delete newObj._id;
      }
      // Also handle MongoDB Extended JSON $oid format
      if (newObj.$oid) return undefined; 

      for (const key in newObj) {
        if (typeof newObj[key] === 'object') {
          newObj[key] = deepCleanIds(newObj[key]);
        }
      }
      return newObj;
    };

    let cleanAutomationFlows = automationFlows ? deepCleanIds(automationFlows) : undefined;
    let cleanMessageTemplates = messageTemplates ? deepCleanIds(messageTemplates) : undefined;
    let cleanNicheData = nicheData ? deepCleanIds(nicheData) : undefined;
    let cleanFlowData = flowData ? deepCleanIds(flowData) : undefined;

    // --- Dual-Write Construction for Parallel Run ---
    const updateData = {
      name, businessType, niche, plan, isGenericBot, phoneNumberId,
      whatsappToken, verifyToken: webhookVerifyToken, 
      googleCalendarId, openaiApiKey, 
      nicheData: cleanNicheData, 
      flowData: cleanFlowData,
      automationFlows: cleanAutomationFlows, 
      messageTemplates: cleanMessageTemplates, 
      wabaId, emailUser, 
      emailAppPassword, razorpayKeyId, razorpaySecret, adminPhone,
      shopDomain, shopifyAccessToken, shopifyWebhookSecret, googleReviewUrl
    };

    // Tier 2.5 Sub-document dual-writes
    if (name) updateData['brand.businessName'] = name;
    if (niche) updateData['brand.niche'] = niche;
    if (businessType) updateData['brand.businessType'] = businessType;
    if (adminPhone !== undefined) updateData['brand.adminPhone'] = adminPhone;
    if (googleReviewUrl !== undefined) updateData['brand.googleReviewUrl'] = googleReviewUrl;
    
    if (phoneNumberId !== undefined) updateData['whatsapp.phoneNumberId'] = phoneNumberId;
    if (wabaId !== undefined) updateData['whatsapp.wabaId'] = wabaId;
    if (whatsappToken !== undefined) updateData['whatsapp.accessToken'] = whatsappToken;
    if (webhookVerifyToken !== undefined) updateData['whatsapp.verifyToken'] = webhookVerifyToken;
    
    if (shopDomain !== undefined) updateData['commerce.shopify.domain'] = shopDomain;
    if (shopifyAccessToken !== undefined) updateData['commerce.shopify.accessToken'] = shopifyAccessToken;
    if (shopifyWebhookSecret !== undefined) updateData['commerce.shopify.webhookSecret'] = shopifyWebhookSecret;
    
    if (openaiApiKey !== undefined) updateData['ai.openaiKey'] = openaiApiKey;
    if (plan !== undefined) {
      updateData['billing.plan'] = plan;
      // Master tier sync for UI PlanGate and Sidebar locks
      if (plan === 'CX Agent (V2)' || plan === 'enterprise') {
        updateData.tier = 'v2';
      } else if (plan === 'CX Agent (V1)' || plan === 'v1' || plan === 'starter') {
        updateData.tier = 'v1';
      }
    }

    if (trialActive !== undefined) {
      updateData.trialActive = trialActive;
      updateData['billing.trialActive'] = trialActive;
    }
    if (trialEndsAt !== undefined) {
      updateData.trialEndsAt = new Date(trialEndsAt);
      updateData['billing.trialEndsAt'] = new Date(trialEndsAt);
    }

    let query = {};
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      query = { _id: req.params.id };
    } else {
      query = { clientId: req.params.id };
    }

    const updatedClient = await Client.findOneAndUpdate(
      query,
      { $set: updateData },
      { new: true, runValidators: false }
    );

    if (!updatedClient) {
      log.warn(`Update client not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Client not found' });
    }

    log.success(`Client updated: ${updatedClient.clientId}`);
    res.json(updatedClient);
  } catch (err) {
    log.error('Error updating client', { error: err.message });
    res.status(500).json({ message: 'Server error updating client', error: err.message });
  }
});

// --- DELETE CLIENT (Soft Delete) ---
router.delete('/clients/:id', protect, isSuperAdmin, async (req, res) => {
  try {
    const deletedClient = await Client.findByIdAndUpdate(
      req.params.id, 
      { $set: { isActive: false } },
      { new: true }
    );
    if (!deletedClient) {
      return res.status(404).json({ message: 'Client not found' });
    }
    res.json({ message: 'Client deactivated successfully (Soft Deleted)' });
  } catch (err) {
    console.error('Error deleting client:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- CLIENT SELF-SERVICE: Update own nicheData/flowData ---
// Any authenticated user can update their OWN client's editable fields
router.get('/my-settings', protect, sanitizeMiddleware, async (req, res) => {
  try {
    const { clientId } = req.query;
    
    // 1. Resolve Target Client ID with Fallback
    // Priority: Query Param (SuperAdmin only) > User Object > "unknown"
    let targetClientId = (req.user?.role === 'SUPER_ADMIN' && clientId) ? clientId : req.user?.clientId;

    if (!targetClientId) {
      log.warn('Settings access attempted without clientId', { user: req.user?.email });
      return res.status(400).json({ 
        success: false, 
        message: 'Identity mismatch: No target clientId established.' 
      });
    }

    log.info('Fetching settings stream', { targetClientId, requester: req.user?.email });

    // 2. Fetch with simple retry logic (via await)
    const client = await Client.findOne({ clientId: targetClientId }).maxTimeMS(5000); // 5s timeout
    
    if (!client) {
      log.warn('Client registry missing', { targetClientId });
      return res.status(404).json({ 
        success: false, 
        message: `No configuration payload found for id: ${targetClientId}` 
      });
    }

    // 3. Return payload (sanitized via middleware)
    res.json(client);

  } catch (err) {
    log.error('Critical Settings Failure (500)', { 
      error: err.message, 
      stack: err.stack,
      user: req.user?.email 
    });

    // Handle generic server errors vs database timeouts
    const isTimeout = err.name === 'MongooseError' && err.message.includes('timeout');
    
    res.status(500).json({ 
      success: false,
      message: isTimeout ? 'Database connection timed out. Please retry.' : 'Persistent internal server error',
      error: err.message 
    });
  }
});

router.patch('/my-settings', protect, async (req, res) => {
  try {
    const { 
      nicheData, flowData, automationFlows, messageTemplates, flowNodes, flowEdges, 
      simpleSettings, clientId, isAIFallbackEnabled, flowFolders, visualFlows,
      wabaId, phoneNumberId, whatsappToken,
      shopDomain, shopifyClientId, shopifyClientSecret, shopifyAccessToken, shopifyWebhookSecret,
      woocommerceUrl, woocommerceKey, woocommerceSecret, storeType,
      instagramConnected, instagramPageId, instagramAccessToken, instagramAppSecret,
      googleReviewUrl, adminPhone, adminEmail,
      adminAlertEmail, adminAlertWhatsapp, metaAppId,
      // Phase 20: Razorpay
      razorpayKeyId, razorpaySecret,
      // Phase 20: System prompt / AI
      systemPrompt, geminiApiKey
    } = req.body;
    
    // If Super Admin and clientId provided, use that. Otherwise use user's own.
    let targetClientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && clientId) {
      targetClientId = clientId;
    }

    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }

    const updateFields = {};
    if (nicheData !== undefined) updateFields.nicheData = nicheData;
    if (flowData !== undefined) updateFields.flowData = flowData;
    if (automationFlows !== undefined) updateFields.automationFlows = automationFlows;
    if (messageTemplates !== undefined) updateFields.messageTemplates = messageTemplates;
    if (flowNodes !== undefined) updateFields.flowNodes = flowNodes;
    if (flowEdges !== undefined) updateFields.flowEdges = flowEdges;
    if (simpleSettings !== undefined) updateFields.simpleSettings = simpleSettings;
    if (isAIFallbackEnabled !== undefined) updateFields.isAIFallbackEnabled = isAIFallbackEnabled;
    if (flowFolders !== undefined) updateFields.flowFolders = flowFolders;
    if (visualFlows !== undefined) updateFields.visualFlows = visualFlows;

    // Commercial & Meta Fields
    if (wabaId !== undefined) {
      updateFields.wabaId = wabaId;
      updateFields['whatsapp.wabaId'] = wabaId;
    }
    if (phoneNumberId !== undefined) {
      updateFields.phoneNumberId = phoneNumberId;
      updateFields['whatsapp.phoneNumberId'] = phoneNumberId;
    }
    if (whatsappToken !== undefined && whatsappToken !== '••••••••' && whatsappToken.trim() !== '') {
      updateFields.whatsappToken = whatsappToken;
      updateFields['whatsapp.accessToken'] = whatsappToken;
    }
    
    if (shopDomain !== undefined) {
      updateFields.shopDomain = shopDomain;
      updateFields['commerce.shopify.domain'] = shopDomain;
    }
    if (shopifyClientId !== undefined) {
      updateFields.shopifyClientId = shopifyClientId;
      updateFields['commerce.shopify.clientId'] = shopifyClientId;
    }
    if (shopifyClientSecret !== undefined && shopifyClientSecret !== '••••••••' && shopifyClientSecret.trim() !== '') {
      updateFields.shopifyClientSecret = shopifyClientSecret;
      updateFields['commerce.shopify.clientSecret'] = shopifyClientSecret;
    }
    if (shopifyAccessToken !== undefined && shopifyAccessToken !== '••••••••' && shopifyAccessToken.trim() !== '') {
      updateFields.shopifyAccessToken = shopifyAccessToken;
      updateFields['commerce.shopify.accessToken'] = shopifyAccessToken;
    }
    if (shopifyWebhookSecret !== undefined && shopifyWebhookSecret !== '••••••••' && shopifyWebhookSecret.trim() !== '') {
      updateFields.shopifyWebhookSecret = shopifyWebhookSecret;
      updateFields['commerce.shopify.webhookSecret'] = shopifyWebhookSecret;
    }

    if (woocommerceUrl !== undefined) {
      updateFields.woocommerceUrl = woocommerceUrl;
      updateFields['commerce.woocommerce.url'] = woocommerceUrl;
    }
    if (woocommerceKey !== undefined && woocommerceKey !== '••••••••' && woocommerceKey.trim() !== '') {
      updateFields.woocommerceKey = woocommerceKey;
      updateFields['commerce.woocommerce.key'] = woocommerceKey;
    }
    if (woocommerceSecret !== undefined && woocommerceSecret !== '••••••••' && woocommerceSecret.trim() !== '') {
      updateFields.woocommerceSecret = woocommerceSecret;
      updateFields['commerce.woocommerce.secret'] = woocommerceSecret;
    }
    if (storeType !== undefined) {
      updateFields.storeType = storeType;
      updateFields['commerce.storeType'] = storeType;
    }

    if (instagramConnected !== undefined) {
      updateFields.instagramConnected = instagramConnected;
      updateFields['social.instagram.connected'] = instagramConnected;
    }
    if (instagramPageId !== undefined) {
      updateFields.instagramPageId = instagramPageId;
      updateFields['social.instagram.pageId'] = instagramPageId;
    }
    if (instagramAccessToken !== undefined && instagramAccessToken !== '••••••••' && instagramAccessToken.trim() !== '') {
      updateFields.instagramAccessToken = instagramAccessToken;
      updateFields['social.instagram.accessToken'] = instagramAccessToken;
    }
    if (instagramAppSecret !== undefined && instagramAppSecret !== '••••••••' && instagramAppSecret.trim() !== '') {
      updateFields.instagramAppSecret = instagramAppSecret;
      updateFields['social.instagram.appSecret'] = instagramAppSecret;
    }

    if (googleReviewUrl !== undefined) {
      updateFields.googleReviewUrl = googleReviewUrl;
      updateFields['brand.googleReviewUrl'] = googleReviewUrl;
    }
    if (adminPhone !== undefined) {
      updateFields.adminPhone = adminPhone;
      updateFields['brand.adminPhone'] = adminPhone;
    }
    if (adminEmail !== undefined) updateFields.adminEmail = adminEmail;
    if (adminAlertEmail !== undefined) updateFields.adminAlertEmail = adminAlertEmail;
    if (adminAlertWhatsapp !== undefined) updateFields.adminAlertWhatsapp = adminAlertWhatsapp;
    if (metaAppId !== undefined) updateFields.metaAppId = metaAppId;

    // Phase 20: Razorpay
    if (razorpayKeyId !== undefined && razorpayKeyId.trim() !== '') updateFields.razorpayKeyId = razorpayKeyId;
    if (razorpaySecret !== undefined && razorpaySecret !== '••••••••' && razorpaySecret.trim() !== '') updateFields.razorpaySecret = razorpaySecret;

    // Phase 20: AI / System Prompt
    if (systemPrompt !== undefined) {
      updateFields.systemPrompt = systemPrompt;
      updateFields['ai.systemPrompt'] = systemPrompt;
    }
    if (geminiApiKey !== undefined && geminiApiKey !== '••••••••' && geminiApiKey.trim() !== '') {
      updateFields.geminiApiKey = geminiApiKey;
      updateFields['ai.geminiKey'] = geminiApiKey;
    }

    const updated = await Client.findOneAndUpdate(
      { clientId: targetClientId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    log.success(`${req.user.role} updated settings for: ${targetClientId}`);
    res.json({ 
      success: true, 
      nicheData: updated.nicheData, 
      flowData: updated.flowData,
      automationFlows: updated.automationFlows,
      messageTemplates: updated.messageTemplates,
      flowFolders: updated.flowFolders,
      visualFlows: updated.visualFlows
    });
  } catch (err) {
    log.error('Settings update error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});
// --- GET PRESET FLOW BY BUSINESS TYPE ---
const flowPresets = require('../utils/flowPresets');

router.get('/flow/preset/:type', protect, async (req, res) => {
  const { type } = req.params;
  const preset = flowPresets.getPreset(type);
  
  if (!preset) {
    return res.status(404).json({ success: false, message: "Preset not found" });
  }
  
  return res.json({ success: true, ...preset });
});

// --- GET AND UPDATE CLIENT SPECIFIC SETTINGS (Like AI Persona) ---
router.get('/client/settings', protect, async (req, res) => {
  try {
    const targetClientId = req.user.clientId;
    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }

    const client = await Client.findOne({ clientId: targetClientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    // Send the settings required by the frontend client/settings route
    res.json({ ai: client.ai });
  } catch (err) {
    log.error('Client settings fetch error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/client/settings', protect, async (req, res) => {
  try {
    const targetClientId = req.user.clientId;
    if (!targetClientId) {
      return res.status(400).json({ message: 'No target clientId specified' });
    }
    
    // Construct deep update paths
    const updateFields = {};
    if (req.body.ai) {
       // Update specific AI sub-fields while preserving the structure
       if (req.body.ai.persona) updateFields['ai.persona'] = req.body.ai.persona;
       if (req.body.ai.fallbackEnabled !== undefined) updateFields['ai.fallbackEnabled'] = req.body.ai.fallbackEnabled;
       if (req.body.ai.languages) updateFields['ai.languages'] = req.body.ai.languages;
       if (req.body.ai.translationConfig) updateFields['ai.translationConfig'] = req.body.ai.translationConfig;
       if (req.body.ai.negotiationSettings) updateFields['ai.negotiationSettings'] = req.body.ai.negotiationSettings;
       if (req.body.ai.orderTaking) updateFields['ai.orderTaking'] = req.body.ai.orderTaking;
       if (req.body.ai.systemPrompt) updateFields['ai.systemPrompt'] = req.body.ai.systemPrompt;
       if (req.body.ai.geminiKey) updateFields['ai.geminiKey'] = req.body.ai.geminiKey;
    }

    const updated = await Client.findOneAndUpdate(
      { clientId: targetClientId },
      { $set: updateFields },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Client not found' });

    res.json({ success: true, ai: updated.ai });
  } catch (err) {
    log.error('Client settings update error', { error: err.message });
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// --- GET SETTINGS BY CLIENTID (Super Admin) ---
router.get('/settings/:clientId', protect, isSuperAdmin, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    
    res.json({
      clientId: client.clientId,
      businessType: client.businessType,
      niche: client.niche,
      nicheData: client.nicheData,
      flowData: client.flowData,
      automationFlows: client.automationFlows,
      messageTemplates: client.messageTemplates,
      flowNodes: client.flowNodes || [],
      flowEdges: client.flowEdges || [],
      plan: client.plan,
      isAIFallbackEnabled: client.isAIFallbackEnabled,
      flowFolders: client.flowFolders || [],
      visualFlows: client.visualFlows || []
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
// --- RUN AUTOMATION MIGRATION (Super Admin) ---
router.get('/run-automation-migration', protect, isSuperAdmin, async (req, res) => {
  try {
      const defaultAutomationFlows = [
        { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
        { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
        { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
      ];

      const defaultMessageTemplates = [
        {
          id: "cod_to_prepaid",
          body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
          buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
        },
        {
          id: "review_request",
          body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
          buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
        }
      ];

      const clients = await Client.find({});
      let updated = 0;

      for (const client of clients) {
          let isModified = false;

          if (!client.automationFlows || client.automationFlows.length === 0) {
              client.automationFlows = defaultAutomationFlows;
              isModified = true;
          } else {
               for (const defaultFlow of defaultAutomationFlows) {
                   if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                       client.automationFlows.push(defaultFlow);
                       isModified = true;
                   }
               }
          }

          if (!client.messageTemplates || client.messageTemplates.length === 0) {
               client.messageTemplates = defaultMessageTemplates;
               isModified = true;
          } else {
               for (const defaultTemp of defaultMessageTemplates) {
                   if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                       client.messageTemplates.push(defaultTemp);
                       isModified = true;
                   }
               }
          }

          if (isModified) {
              const setFields = {};
              if (client.automationFlows) setFields.automationFlows = client.automationFlows;
              if (client.messageTemplates) setFields.messageTemplates = client.messageTemplates;
              await Client.updateOne(
                { _id: client._id },
                { $set: setFields },
                { runValidators: false }
              );
              updated++;
          }
      }

      res.json({ message: `Migration Complete: ${updated} clients were updated with the new Automation & Template features.` });
  } catch (err) {
      log.error('Migration failed via API', { error: err.message });
      res.status(500).json({ message: 'Migration Failed', error: err.message });
  }
});

// --- AI FLOW GENERATION (Gemini) ---
router.post('/generate-flow', protect, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    let model = getGeminiModel(apiKey);

    const systemPrompt = `You are a WhatsApp chatbot flow designer. Given a business description, generate a JSON object with "nodes" and "edges" arrays for a ReactFlow diagram.
    
    The flow must ALWAYS start with a "trigger" node (id: "node_0").
    Connect nodes logically. For interactive buttons/lists, use source handles that match the item ID (e.g. "opt_1", "opt_2").
    
    Node Types and Schema (all data must be inside the 'data' object of the node):
    1. "trigger": { id: "...", type: "trigger", position: {x: 0, y: 0}, data: { label: "Start", keyword: "hi" } }
    2. "message": { id: "...", type: "message", position: {x: 0, y: 0}, data: { label: "Msg", body: "Hello!", imageUrl: "", footer: "" } }
    3. "interactive": { 
         id: "...", type: "interactive", position: {x: 0, y: 0}, 
         data: { 
           label: "Menu",
           interactiveType: "button", 
           header: "Welcome", 
           body: "Choose an option", 
           buttonsList: [{id: "opt_1", title: "Option 1"}],
           imageUrl: "", 
           footer: "" 
         }
       }
    4. "image": { id: "...", type: "image", position: {x: 0, y: 0}, data: { label: "Img", imageUrl: "...", body: "caption" } }
    5. "template": { id: "...", type: "template", position: {x: 0, y: 0}, data: { label: "Tpl", metaTemplateName: "...", languageCode: "en" } }
    
    Visual Layout:
    Position nodes logically with enough spacing (dx=350, dy=250) roughly in a tree left-to-right.
    
    Business description: ${prompt}
    
    Return ONLY valid JSON. No markdown. Start with { and end with }.`;

    console.log('[generate-flow] Calling Gemini API...');
    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      console.error('[generate-flow] Flash failed, falling back to Pro:', apiErr.message);
      model = getGeminiModel(apiKey);
      result = await model.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    console.log('[generate-flow] Gemini raw response (first 500 chars):', rawText.slice(0, 500));

    // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Extract the outermost JSON object
    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[generate-flow] No JSON found in response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'AI did not return valid JSON', raw: rawText.slice(0, 300) });
    }

    let flow;
    try {
      flow = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[generate-flow] JSON parse error:', parseErr.message, '| raw:', jsonMatch[0].slice(0, 300));
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message, raw: jsonMatch[0].slice(0, 200) });
    }

    if (!flow.nodes || !flow.edges) {
      return res.status(500).json({ error: 'AI response missing nodes or edges', flow });
    }

    console.log('[generate-flow] Success — nodes:', flow.nodes.length, '| edges:', flow.edges.length);
    res.json({ success: true, nodes: flow.nodes, edges: flow.edges });
  } catch (err) {
    console.error('[generate-flow] FATAL:', err.message, err.stack?.slice(0, 500));
    res.status(500).json({ 
      error: 'AI Generation Failed: ' + err.message,
      suggestion: 'Check your GEMINI_API_KEY or try again.' 
    });
  }
});

// --- AI SMART FIX AUTOMATION ---
router.post('/flow/fix', protect, async (req, res) => {
  try {
    const { diagnostics, nodes, edges } = req.body;
    if (!diagnostics || !nodes || !edges) return res.status(400).json({ error: 'Missing diagnostic or graph data' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });

    let model = getGeminiModel(apiKey);

    const systemPrompt = `You are a WhatsApp chatbot flow engineer debugging a ReactFlow JSON graph.
    You will receive the current graph (nodes and edges) and a list of diagnostic errors.
    Your task is to fix the errors by intelligently modifying the "nodes" or "edges" array.
    
    Diagnostics:
    ${JSON.stringify(diagnostics, null, 2)}
    
    Current Nodes:
    ${JSON.stringify(nodes, null, 2)}
    
    Current Edges:
    ${JSON.stringify(edges, null, 2)}
    
    Return ONLY valid JSON with exactly two properties: "nodes" and "edges".
    DO NOT DELETE nodes unless absolutely necessary. Just fix the broken edges or properties.
    The response MUST be a valid JSON object. Do not add markdown formatting or explanations.`;

    console.log('[flow/fix] Calling Gemini API for smart fix...');
    let result;
    try {
      result = await model.generateContent(systemPrompt);
    } catch (apiErr) {
      console.warn('[flow/fix] Flash failed, falling back to Pro:', apiErr.message);
      model = getGeminiModel(apiKey);
      result = await model.generateContent(systemPrompt);
    }

    const rawText = result.response.text().trim();
    
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const startIdx = cleaned.indexOf('{');
    const endIdx = cleaned.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[flow/fix] No JSON found in response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'AI did not return valid JSON' });
    }

    let fixedGraph;
    try {
      fixedGraph = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse AI JSON: ' + parseErr.message });
    }

    if (!fixedGraph.nodes || !fixedGraph.edges) {
      return res.status(500).json({ error: 'AI output missing nodes/edges' });
    }

    console.log('[flow/fix] Success - Returning fixed graph.');
    res.json({ success: true, nodes: fixedGraph.nodes, edges: fixedGraph.edges });
  } catch (err) {
    console.error('[flow/fix] FATAL:', err.message);
    res.status(500).json({ error: 'AI Auto-Fix Failed: ' + err.message });
  }
});

// --- GEMINI KEY PROBE (no auth — for diagnostics) ---
router.get('/test-gemini', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not set' });
  try {
    let model = getGeminiModel(apiKey);
    let result;
    try {
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    } catch (apiErr) {
        console.warn('[test-gemini] Flash failed, testing Pro:', apiErr.message);
        model = getGeminiModel(apiKey);
        result = await model.generateContent('Say "ok" in JSON like {"status":"ok"}');
    }
    const text = result.response.text().trim();
    res.json({ ok: true, raw: text.slice(0, 200) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- MANUAL SEEDING ROUTE (Admin Only) ---
router.post('/seed-niche-data', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            const defaults = (client.businessType === 'ecommerce' || client.niche === 'ecommerce') ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
            let wasUpdated = false;

            if (!client.nicheData) {
                client.nicheData = { ...defaults };
                wasUpdated = true;
            } else {
                // Merge missing fields
                for (const [k, v] of Object.entries(defaults)) {
                    if (client.nicheData[k] === undefined || client.nicheData[k] === "") {
                        client.nicheData[k] = v;
                        wasUpdated = true;
                    }
                }
            }

            if (wasUpdated) {
                client.markModified('nicheData');
                await client.save();
                updated++;
            }
        }
        res.json({ success: true, message: `${updated} clients seeded with default data.` });
    } catch (err) {
        res.status(500).json({ error: 'Seeding failed: ' + err.message });
    }
});

// --- REVENUE STATS AGGREGATION ---
router.get('/revenue-stats/:clientId?', protect, async (req, res) => {
  try {
    const DailyStat = require('../models/DailyStat');
    const targetClientId = req.params.clientId || req.user.clientId;
    const stats = await DailyStat.find({ clientId: targetClientId });
    
    const totals = stats.reduce((acc, s) => ({
        browseRecovered: acc.browseRecovered + (s.browseAbandonedCount || 0),
        cartMessages: acc.cartMessages + (s.cartRecoveryMessagesSent || 0),
        cartRevenue: acc.cartRevenue + (s.cartRevenueRecovered || 0),
        upsellCount: acc.upsellCount + (s.upsellConvertedCount || 0),
        upsellRevenue: acc.upsellRevenue + (s.upsellRevenue || 0),
        codConverted: acc.codConverted + (s.codConvertedCount || 0)
    }), { browseRecovered: 0, cartMessages: 0, cartRevenue: 0, upsellCount: 0, upsellRevenue: 0, codConverted: 0 });

    res.json({
        success: true,
        stats: [
            { label: 'Browse Recovery', value: totals.browseRecovered > 0 ? "12%" : "0%", sub: `${totals.browseRecovered} nudges sent`, color: 'blue' },
            { label: 'Cart Recovery', value: totals.cartRevenue > 0 ? "18%" : "0%", sub: `₹${totals.cartRevenue.toLocaleString()} recovered`, color: 'emerald' },
            { label: 'AI Upsell Rate', value: totals.upsellCount > 0 ? '4%' : '0%', sub: `${totals.upsellCount} conversions`, color: 'amber' },
            { label: 'COD Converted', value: totals.codConverted > 0 ? '22%' : '0%', sub: `₹${(totals.codConverted * 800).toLocaleString()} saved`, color: 'violet' }
          ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BROWSER-BASED SEEDING (GET) ---
// Paste this in browser: [BACKEND_URL]/api/admin/seed-now
router.get('/seed-now', protect, async (req, res) => {
    try {
        const clients = await Client.find({});
        let updated = 0;
        const DEFAULT_ECOMMERCE = {
            welcomeMessage: "Hi! 👋 Welcome to our store. We're here to help you find the best products. How can we assist you today?",
            bannerImage: "https://images.unsplash.com/photo-1558002038-1055907df827?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Shop Now 🛍️",
            supportReply: "Our AI assistant is ready! You can check product availability, track orders, or talk to our team.",
            orderConfirmMsg: "Hi {name}, your order for {items} worth ₹{total} is confirmed! Payment: {payment}. We'll ship soon! 📦",
            abandonedMsg1: "Hi {name}! 👋 You left some items in your cart. Would you like to complete your order?",
            abandonedMsg2: "Last chance, {name}! 🎁 Your cart is still waiting. Complete your purchase now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review"
        };
        const DEFAULT_SALON = {
            welcomeMessage: "Hey! 💇‍♀️ Welcome to our Salon. Treat yourself to our premium services. How can we pamper you today?",
            bannerImage: "https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=800&q=80",
            flowButtonText: "Book Appointment 📅",
            supportReply: "We provide professional hair and beauty services. Our team is expert in advanced treatments and cuts.",
            orderConfirmMsg: "Hi {name}, your booking for {items} on {date} at {time} is confirmed! See you soon! ✨",
            abandonedMsg1: "Hi {name}! 👋 We saw you looking at our services. Would you like to book a slot?",
            abandonedMsg2: "Still thinking about that makeover, {name}? 💅 Book now!",
            websiteUrl: "https://google.com",
            googleReviewUrl: "https://g.page/review",
            calendars: { "Main Stylist": "" },
            services: [{ name: "Haircut", price: "500", duration: "30" }]
        };

        for (const client of clients) {
            if (!client.nicheData || Object.keys(client.nicheData).length === 0) {
                client.nicheData = (client.businessType === 'ecommerce' || client.clientId.includes('smarthomes')) ? DEFAULT_ECOMMERCE : DEFAULT_SALON;
                await client.save();
                updated++;
            }
        }
        res.send(`<h1>Seeding Complete</h1><p>${updated} clients were updated with default niche data.</p><a href="/admin/settings">Back to Dashboard</a>`);
    } catch (err) {
        res.status(500).send(`<h1>Seeding Failed</h1><p>${err.message}</p>`);
    }
});

// --- PHASE 9: META TEMPLATE SYNC ---
router.get('/templates/sync/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        const { key } = req.query;

        // Robustness: strip leading colon if user copy-pasted literally
        if (clientId.startsWith(':')) clientId = clientId.substring(1);

        // Allow bypass with secure key or regular auth
        const isSecureKey = key === 'topedge_secure_admin_123';
        if (!isSecureKey && !req.user) {
            // If not secure key and not logged in (protect middleware would have run if we used it)
            // But since we want browser access, we'll manually check for key first.
            return res.status(401).json({ message: "Not authorized. Provide key or login." });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });
        
        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing templates for ${clientId} via Meta API...`);
        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/message_templates?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${client.whatsappToken}` } });
        
        const approvedTemplates = response.data.data.filter(t => t.status === 'APPROVED');
        client.syncedMetaTemplates = approvedTemplates;
        await client.save();
        
        res.json({ success: true, count: approvedTemplates.length, data: approvedTemplates });
    } catch (err) {
        log.error('Template Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYNC META FLOWS ---
router.get('/flows/sync/:clientId', protect, async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        if (!client.wabaId || !client.whatsappToken) {
            return res.status(400).json({ error: 'WABA ID or WhatsApp Token missing.' });
        }

        log.info(`Syncing flows for ${clientId}...`);
        const url = `https://graph.facebook.com/v18.0/${client.wabaId}/flows?limit=100`;
        const response = await axios.get(url, { headers: { Authorization: `Bearer ${client.whatsappToken}` } });
        
        const flows = response.data.data || [];
        client.syncedMetaFlows = flows;
        await client.save();
        
        res.json({ success: true, count: flows.length, flows });
    } catch (err) {
        log.error('Flow Sync Failed', { error: err.message });
        res.status(500).json({ error: 'Sync Failed: ' + (err.response?.data?.error?.message || err.message) });
    }
});

// --- SYSTEM MIGRATION (BROWSER-READY) ---
router.get('/run-full-migration', async (req, res) => {
    const { key } = req.query;
    if (key !== 'topedge_secure_admin_123') {
        return res.status(401).send('<h1>Access Denied</h1><p>Invalid migration key.</p>');
    }

    try {
        const clients = await Client.find({});
        let updated = 0;
        
        // Define missing defaults
        const defaultAutomationFlows = [
            { id: 'abandoned_cart', isActive: false },
            { id: 'cod_to_prepaid', isActive: false },
            { id: 'review_collection', isActive: false }
        ];

        for (const client of clients) {
            let isModified = false;
            
            // 1. Ensure automationFlows exists
            if (!client.automationFlows || client.automationFlows.length === 0) {
                client.automationFlows = defaultAutomationFlows;
                isModified = true;
            }

            // 2. Ensure simpleSettings exists
            if (!client.simpleSettings) {
                client.simpleSettings = { keywordFallbacks: [], variableMap: {}, welcomeStartNodeId: 'node_1' };
                isModified = true;
            }

            if (isModified) {
                await client.save();
                updated++;
            }
        }
        
        res.send(`<h1>Migration Successful</h1><p>Processed ${clients.length} clients. Updated ${updated} clients with new features.</p>`);
    } catch (err) {
        log.error('Migration failed', err.message);
        res.status(500).send(`<h1>Migration Error</h1><p>${err.message}</p>`);
    }
});


// --- PHASE 9/10: AI FLOW AUTO-GENERATION ---
router.post('/flow/autogen/:clientId', protect, async (req, res) => {
    try {
        const { prompt, flowNodes, flowEdges } = req.body;
        const client = await Client.findOne({ clientId: req.params.clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const existingFlow = (flowNodes && flowNodes.length > 0) ? { nodes: flowNodes, edges: flowEdges } : null;
        const aiFlow = await generateFlowForClient(client, prompt, existingFlow);
        if (!aiFlow) return res.status(500).json({ error: 'Failed to generate flow with AI. Please try again or provide more details.' });

        client.flowNodes = aiFlow.nodes;
        client.flowEdges = aiFlow.edges;
        if (prompt) client.systemPrompt = prompt;

        await client.save();
        res.json({ success: true, nodes: aiFlow.nodes, edges: aiFlow.edges });
    } catch (err) {
        log.error('Manual Auto-gen failed', { error: err.message });
        res.status(500).json({ error: 'Failed to generate flow: ' + err.message });
    }
});

// --- CONVERT LEGACY JS FLOW TO VISUAL FLOW (AI) ---
router.post('/flow/convert-legacy/:clientId', async (req, res) => {
    try {
        let { clientId } = req.params;
        if (clientId.startsWith(':')) clientId = clientId.substring(1);
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Map clientId to legacy file
        let fileName = '';
        if (clientId === 'delitech_smarthomes' || clientId === 'ved') fileName = 'delitech_smarthomes.js';
        else if (clientId === 'choice_salon_holi' || clientId === 'choice_salon') fileName = 'choice_salon_holi.js';
        else if (clientId === 'turf') fileName = 'turf.js';
        else {
             // Try common patterns if not found
             fileName = `${clientId}.js`;
        }

        const filePath = path.join(CLIENT_CODE_DIR, fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(400).json({ error: `Legacy file not found: ${fileName}` });
        }

        const fileCode = fs.readFileSync(filePath, 'utf8');
        log.info(`Converting legacy flow for ${clientId}...`);

        const flowJson = await convertLegacyToVisual(clientId, fileCode);
        
        client.flowNodes = flowJson.nodes || [];
        client.flowEdges = flowJson.edges || [];
        client.isGenericBot = true; // Switch to generic hub engine after conversion
        await client.save();

        res.json({ success: true, message: `Migrated ${flowJson.nodes.length} nodes from legacy file.` });
    } catch (err) {
        log.error('Conversion Error', err.message);
        res.status(500).json({ error: 'Conversion failed: ' + err.message });
    }
});

// --- PHASE 13: MASTER MIGRATION (URL RUNNABLE) ---
/**
 * URL: [BASE_URL]/api/admin/phase13-migration?key=topedge_phase13_secure_99
 * Purpose: Transition all records to Phase 13 (Omnichannel + Gemini + Stability)
 */
router.get('/phase13-migration', async (req, res) => {
  const { key } = req.query;
  if (key !== 'topedge_phase13_secure_99') {
    return res.status(401).send("Unauthorized. Use ?key=topedge_phase13_secure_99");
  }

  const Conversation = require('../models/Conversation');
  const Message = require('../models/Message');
  const Order = require('../models/Order');

  const report = {
    clients: { total: 0, updated: 0 },
    conversations: { total: 0, updated: 0, lastStepFixed: 0 },
    messages: { total: 0, updated: 0 },
    orders: { total: 0, updated: 0 }
  };

  try {
    // 1. Update Clients
    const clients = await Client.find({});
    report.clients.total = clients.length;
    for (const client of clients) {
      let changed = false;
      
      // Default storeType to shopify for legacy
      if (!client.storeType) {
        client.storeType = "shopify";
        changed = true;
      }
      
      // Sync geminiApiKey from openaiApiKey if missing
      if (!client.geminiApiKey && client.openaiApiKey) {
        client.geminiApiKey = client.openaiApiKey;
        changed = true;
      }

      if (changed) {
        await client.save({ validateBeforeSave: false });
        report.clients.updated++;
      }
    }

    // 2. Update Conversations (Bulk)
    // - Add channel: whatsapp
    // - Fix lastStepId (if it's a phone number, set to null)
    const allConvs = await Conversation.find({});
    report.conversations.total = allConvs.length;
    
    // Check for phone numbers in lastStepId (crude regex check for 10+ digits)
    const phoneRegex = /^\+?[0-9]{10,15}$/;
    
    // We do sequential for lastStepId fix to be safe, or use updateMany for channel
    await Conversation.updateMany(
      { channel: { $exists: false } },
      { $set: { channel: "whatsapp" } }
    );
    
    for (const conv of allConvs) {
      if (conv.lastStepId && phoneRegex.test(conv.lastStepId)) {
        conv.lastStepId = null;
        await conv.save();
        report.conversations.lastStepFixed++;
      }
    }
    report.conversations.updated = await Conversation.countDocuments({ channel: "whatsapp" });

    // 3. Update Messages (Bulk)
    const msgResult = await Message.updateMany(
      { channel: { $exists: false } },
      { $set: { channel: "whatsapp" } }
    );
    report.messages.updated = msgResult.nModified;

    // 4. Update Orders
    // Ensure all existing orders have a source and handle codNudgePendingAt
    const orderResult = await Order.updateMany(
      { source: { $exists: false } },
      { $set: { source: "shopify" } }
    );
    report.orders.updated = orderResult.nModified;

    const resultMsg = `
      <h1>🚀 Phase 13 Migration Complete</h1>
      <pre>${JSON.stringify(report, null, 2)}</pre>
      <p><b>Clients:</b> ${report.clients.updated}/${report.clients.total} updated (StoreType & Gemini Keys)</p>
      <p><b>Conversations:</b> fixed ${report.conversations.lastStepFixed} corrupted states.</p>
      <p><b>Messages:</b> ${report.messages.updated} records moved to 'whatsapp' channel.</p>
      <p>Status: SUCCESS</p>
    `;
    res.send(resultMsg);

  } catch (err) {
    console.error("[Migration P13] ERROR:", err);
    res.status(500).send(`<h1>❌ Migration Failed</h1><pre>${err.message}</pre>`);
  }
});
// --- PHASE 18: PUBLISH FLOW (Sync draft to live) ---
router.post('/flow/publish/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { nodes, edges, note } = req.body;
    let nodesToPublish = nodes;
    let edgesToPublish = edges;

    if (!nodesToPublish || !edgesToPublish) {
       const activeFlow = client.visualFlows?.find(f => f.isActive) || client.visualFlows?.[0];
       if (activeFlow) {
           nodesToPublish = activeFlow.nodes;
           edgesToPublish = activeFlow.edges;
       } else {
           return res.status(400).json({ error: 'No flow data provided to publish.' });
       }
    }

    if (!client.flowHistory) client.flowHistory = [];
    client.flowHistory.push({
      version: client.flowHistory.length + 1,
      nodes: client.flowNodes,
      edges: client.flowEdges,
      savedAt: new Date(),
      note: note || 'Auto-backup before publish'
    });

    client.flowNodes = nodesToPublish;
    client.flowEdges = edgesToPublish;

    await client.save();
    res.json({ success: true, message: 'Flow published to live engine.', version: client.flowHistory.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish flow: ' + err.message });
  }
});

// --- PHASE 18: UNANSWERED QUESTIONS ---
router.get('/unanswered-questions/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ success: true, unansweredQuestions: client.unansweredQuestions || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
