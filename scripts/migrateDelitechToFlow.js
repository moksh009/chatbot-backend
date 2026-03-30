const mongoose = require("mongoose");
const Client   = require("../models/Client");
const path     = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// ─────────────────────────────────────────────────────────────────────────────
// DELITECH FLOW DEFINITIONS (Extracted from ved.js)
// ─────────────────────────────────────────────────────────────────────────────

const DELITECH_NODES = [
  // NODE GROUP 1: Entry Points
  {
    id: "trigger_greeting",
    type: "trigger",
    position: { x: 400, y: 0 },
    data: {
      label: "Greeting Trigger",
      keyword: "hi", // primary keyword for the node label
      keywords: "hi,hello,hey,hola,start,menu,kem cho",
      role: "welcome"
    }
  },
  {
    id: "trigger_intent",
    type: "trigger",
    position: { x: 700, y: 0 },
    data: {
      label: "Product Intent Trigger",
      keyword: "details",
      keywords: "details,know,about,price,info,interested,catalogue,catalog,cost,doorbell",
      role: "product_intent"
    }
  },

  // NODE GROUP 2: Main Menu (Product Selection)
  {
    id: "product_selection_menu",
    type: "interactive",
    position: { x: 400, y: 140 },
    data: {
      label: "Product Selection Menu",
      role: "main_menu",
      interactiveType: "list",
      header: "Select a Model",
      body: "Invest in your family's safety. Select a model below to view exclusive photos and pricing:\n\n*(Tip: Over 80% of our customers choose the 3MP Pro for absolute clarity)*",
      buttonText: "View Doorbells",
      buttonsList: [
        { id: "sel_5mp", title: "Doorbell Pro (5MP)" },
        { id: "sel_3mp", title: "Doorbell Plus (3MP)" },
        { id: "sel_2mp", title: "Doorbell (2MP)" },
        { id: "menu_agent", title: "Consult an Expert" }
      ]
    }
  },

  // NODE GROUP 3: Product Cards
  {
    id: "product_5mp",
    type: "template",
    position: { x: 100, y: 360 },
    data: {
      label: "5MP Doorbell Pro",
      role: "product_detail_5mp",
      metaTemplateName: "5mp_final",
      headerImageUrl: "https://delitechsmarthome.in/cdn/shop/files/my1.png",
      buttonUrlParam: "LEAD_ID",
      instagramFallback: "5MP Doorbell Pro - ₹6,999 | 5MP Ultra HD, Color Night Vision, Anti-Theft Siren, IP65 Weatherproof. Order: https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp"
    }
  },
  {
    id: "product_3mp",
    type: "template",
    position: { x: 400, y: 360 },
    data: {
      label: "3MP Doorbell Plus",
      role: "product_detail_3mp",
      metaTemplateName: "3mp_final",
      headerImageUrl: "https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png",
      buttonUrlParam: "LEAD_ID",
      instagramFallback: "3MP Doorbell Plus - ₹6,499 | 2K HD Video, Color Night Vision, 2-Way Audio. Order: https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp"
    }
  },
  {
    id: "product_2mp",
    type: "interactive",
    position: { x: 700, y: 360 },
    data: {
      label: "2MP Doorbell",
      role: "product_detail_2mp",
      imageUrl: "https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png",
      body: "🛡️ *Delitech Smart Video Doorbell (2MP)*\n\nEssential home security made simple.\n\n📹 *1080p HD Video*\n🌙 *Night Vision* (Clear up to 15ft)\n🗣️ *2-Way Audio* (Talk from your phone)\n🔋 *100% Wireless* (No drilling required)\n🔔 *Free Chime Included*\n\n💰 *Offer Price:* ₹5,499\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation\n\n🎁 *SPECIAL OFFER:* Free Shipping + Free Installation",
      buttonsList: [
        { id: "buy_2mp", title: "🛒 Buy Now" },
        { id: "agent_2mp", title: "📞 Call Me" },
        { id: "menu_products", title: "View Other" }
      ]
    }
  },

  // NODE GROUP 4: Purchase Link Nodes
  {
    id: "purchase_5mp",
    type: "message",
    position: { x: 100, y: 560 },
    data: {
      label: "Buy 5MP Link",
      role: "purchase_5mp",
      body: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_5mp}}\n\n_Cash on Delivery Available_\n_🚚 Free Shipping & 🛠️ Free Installation Included_",
      action: "SEND_PURCHASE_LINK",
      productKey: "5mp",
      baseUrl: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp"
    }
  },
  {
    id: "purchase_3mp",
    type: "message",
    position: { x: 400, y: 560 },
    data: {
      label: "Buy 3MP Link",
      role: "purchase_3mp",
      body: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_3mp}}\n\n_Cash on Delivery Available_\n_🚚 Free Shipping & 🛠️ Free Installation Included_",
      action: "SEND_PURCHASE_LINK",
      productKey: "3mp",
      baseUrl: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp"
    }
  },
  {
    id: "purchase_2mp",
    type: "message",
    position: { x: 700, y: 560 },
    data: {
      label: "Buy 2MP Link",
      role: "purchase_2mp",
      body: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 {{buy_url_2mp}}\n\n_Cash on Delivery Available_\n_🚚 Free Shipping & 🛠️ Free Installation Included_",
      action: "SEND_PURCHASE_LINK",
      productKey: "2mp",
      baseUrl: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-2mp"
    }
  },

  // NODE GROUP 5: Objections
  {
    id: "objection_waterproof",
    type: "interactive",
    position: { x: 1000, y: 200 },
    data: {
      label: "Waterproof Objection",
      role: "objection_waterproof",
      keywords: "waterproof,rain,weather",
      body: "🌦️ *IP65 Weatherproof Guarantee*\n\nYes! Our Doorbells are built to withstand the heaviest Indian monsoons and intense summer heat. You never have to worry about water damage.\n\nReady to secure your home?",
      buttonsList: [
        { id: "buy_5mp", title: "Get 5MP Pro" },
        { id: "menu_products", title: "View All" }
      ]
    }
  },
  {
    id: "objection_install",
    type: "interactive",
    position: { x: 1000, y: 360 },
    data: {
      label: "Installation Objection",
      role: "objection_install",
      keywords: "wire,drill,install",
      body: "⚡ *100% Wireless DIY Setup*\n\nNo drilling, no electricians, and no messy wires! Installation takes exactly 2 minutes. You can screw it in or use the heavy-duty adhesive.\n\nWhich model are you looking for?",
      buttonsList: [
        { id: "menu_products", title: "View Doorbells" },
        { id: "buy_5mp", title: "Buy 5MP Pro" }
      ]
    }
  },
  {
    id: "objection_battery",
    type: "interactive",
    position: { x: 1000, y: 520 },
    data: {
      label: "Battery Objection",
      role: "objection_battery",
      keywords: "battery,charge",
      body: "🔋 *Massive 6-Month Battery*\n\nDelitech Doorbells run on an ultra-capacity rechargeable battery that lasts up to 6 months on a single charge! Just plug it in overnight when low.",
      buttonsList: [
        { id: "menu_products", title: "View Doorbells" }
      ]
    }
  },

  // NODE GROUP 6: Features
  {
    id: "feature_comparison",
    type: "interactive",
    position: { x: 700, y: 560 },
    data: {
      label: "Why Delitech",
      role: "features",
      imageUrl: "https://delitechsmarthome.in/cdn/shop/files/image241.png",
      body: "🌟 *Why Delitech is India's Top Choice*\n\n✅ *100% Wireless DIY*\nNo electricians. No drilling. 2-minute setup.\n\n👁️ *See Everything*\nCrystal clear Ultra-HD video and Color Night Vision.\n\n🗣️ *Stop Intruders Instantly*\nUse 2-Way Talk and the Built-In Siren from anywhere in the world.\n\n🌦️ *IP65 Weatherproof*\nWithstands heavy Indian monsoons and intense heat.",
      buttonsList: [
        { id: "menu_products", title: "Shop Doorbells" },
        { id: "btn_back_menu", title: "Main Menu" }
      ]
    }
  },

  // NODE GROUP 7: FAQ System
  {
    id: "faq_menu",
    type: "interactive",
    position: { x: 400, y: 700 },
    data: {
      label: "FAQ Menu",
      role: "faqs",
      interactiveType: "list",
      header: "Common Questions",
      body: "🤖 *Smart Assistant FAQ*\nGot questions? I've got answers. Select a topic below:",
      buttonText: "View Guides",
      buttonsList: [
        { id: "faq_install", title: "How to install?" },
        { id: "faq_battery", title: "Battery Life" },
        { id: "faq_warranty", title: "Warranty Policy" },
        { id: "menu_agent", title: "Speak to a Human" }
      ]
    }
  },
  {
    id: "faq_install_answer",
    type: "interactive",
    position: { x: 100, y: 860 },
    data: {
      label: "Install FAQ Answer",
      body: "🛠️ *Is it hard to install?*\nNot at all! It's *100% Wireless DIY*. No electricians or wiring needed. You can stick it or screw it to the wall in under 2 minutes. Setup through the CloudEdge App is instant.",
      buttonsList: [
        { id: "menu_products", title: "Yes, Buy Now" },
        { id: "menu_agent", title: "No, Talk to Agent" }
      ]
    }
  },
  {
    id: "faq_battery_answer",
    type: "interactive",
    position: { x: 400, y: 860 },
    data: {
      label: "Battery FAQ Answer",
      body: "🔋 *How long does the battery last?*\nThe IP65 weatherproof battery lasts *up to 6 months* on a single charge (depending on motion alerts). Simply recharge it via the included USB cable.",
      buttonsList: [
        { id: "menu_products", title: "View Products" },
        { id: "menu_agent", title: "Talk to Agent" }
      ]
    }
  },
  {
    id: "faq_warranty_answer",
    type: "interactive",
    position: { x: 700, y: 860 },
    data: {
      label: "Warranty FAQ Answer",
      body: "🛡️ *What about Warranty & Support?*\nEnjoy complete peace of mind with our *1-Year Replacement Warranty* on any manufacturing defects, plus free premium technical support.",
      buttonsList: [
        { id: "menu_products", title: "Shop Now" },
        { id: "menu_agent", title: "Help Me" }
      ]
    }
  },

  // NODE GROUP 8: Human Agent / Escalation
  {
    id: "agent_escalation",
    type: "livechat",
    position: { x: 1300, y: 400 },
    data: {
      label: "Connect to Agent",
      role: "agent_request",
      text: "✅ *Request Received!*\n\nOur security expert has been notified. They will call you shortly on this number to assist you.\n\nIn the meantime, feel free to browse our features!",
      action: "ESCALATE_HUMAN",
      adminNotification: true,
      adminMessageTemplate: "🚨 *HOT LEAD*\n*Customer Phone:* +{{phone}}\n💭 *User Action:* {{context}}\n\n👇 *Tap the link below to chat with them immediately:*\nhttps://wa.me/{{phone}}\n\nTry to close the sale while they are still online!",
      trackStat: "agentRequests"
    }
  }
];

const DELITECH_EDGES = [
  // Triggers → Main Menu
  { id: "e_greeting_menu", source: "trigger_greeting", target: "product_selection_menu", trigger: { type: "auto" } },
  { id: "e_intent_menu",   source: "trigger_intent",   target: "product_selection_menu", trigger: { type: "auto" } },

  // Main Menu → Products
  { id: "e_sel5mp",    source: "product_selection_menu", target: "product_5mp",     sourceHandle: "sel_5mp" },
  { id: "e_sel3mp",    source: "product_selection_menu", target: "product_3mp",     sourceHandle: "sel_3mp" },
  { id: "e_sel2mp",    source: "product_selection_menu", target: "product_2mp",     sourceHandle: "sel_2mp" },
  { id: "e_selagent",  source: "product_selection_menu", target: "agent_escalation",sourceHandle: "menu_agent" },

  // Products → Purchase or Back
  { id: "e_buy5mp",    source: "product_5mp",  target: "purchase_5mp",           sourceHandle: "buy_5mp" },
  { id: "e_buy3mp",    source: "product_3mp",  target: "purchase_3mp",           sourceHandle: "buy_3mp" },
  { id: "e_buy2mp",    source: "product_2mp",  target: "purchase_2mp",           sourceHandle: "buy_2mp" },
  { id: "e_back5mp",   source: "product_5mp",  target: "product_selection_menu", sourceHandle: "menu_products" },
  { id: "e_back3mp",   source: "product_3mp",  target: "product_selection_menu", sourceHandle: "menu_products" },
  { id: "e_back2mp",   source: "product_2mp",  target: "product_selection_menu", sourceHandle: "menu_products" },
  { id: "e_agent5mp",  source: "product_2mp",  target: "agent_escalation",       sourceHandle: "agent_2mp" },

  // Objections (keyword triggers)
  { id: "e_waterproof",source: "trigger_greeting", target: "objection_waterproof", trigger: { type: "keyword", value: "waterproof" } },
  { id: "e_rain",      source: "trigger_greeting", target: "objection_waterproof", trigger: { type: "keyword", value: "rain" } },
  { id: "e_wire",      source: "trigger_greeting", target: "objection_install",    trigger: { type: "keyword", value: "wire" } },
  { id: "e_drill",     source: "trigger_greeting", target: "objection_install",    trigger: { type: "keyword", value: "drill" } },
  { id: "e_battery",   source: "trigger_greeting", target: "objection_battery",    trigger: { type: "keyword", value: "battery" } },

  // FAQ
  { id: "e_menu_faq",  source: "product_selection_menu", target: "faq_menu", trigger: { type: "keyword", value: "faq" } },
  { id: "e_faqinst",   source: "faq_menu",  target: "faq_install_answer",  sourceHandle: "faq_install" },
  { id: "e_faqbat",    source: "faq_menu",  target: "faq_battery_answer",  sourceHandle: "faq_battery" },
  { id: "e_faqwar",    source: "faq_menu",  target: "faq_warranty_answer", sourceHandle: "faq_warranty" },
  { id: "e_faqagent",  source: "faq_menu",  target: "agent_escalation",    sourceHandle: "menu_agent" },

  // After FAQ answer → back to products or agent
  { id: "e_faqbuynow", source: "faq_install_answer", target: "product_selection_menu", sourceHandle: "menu_products" },
  { id: "e_faqagent2", source: "faq_install_answer", target: "agent_escalation",       sourceHandle: "menu_agent" },
];

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION LOGIC
// ─────────────────────────────────────────────────────────────────────────────

async function migrate() {
  try {
    console.log("🚀 Starting Delitech Flow Migration...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("📦 Connected to MongoDB");

    const client = await Client.findOne({ clientId: "delitech_smarthomes" });
    if (!client) {
      console.error("❌ Delitech client not found. Check clientId.");
      await mongoose.disconnect();
      return;
    }

    // SAFETY: Save existing flow to history before overwriting
    if (client.flowNodes?.length) {
      console.log("💾 Backing up current flow to history...");
      const history = client.flowHistory || [];
      history.push({
        version: history.length + 1,
        nodes:   client.flowNodes,
        edges:   client.flowEdges,
        savedAt: new Date(),
        note:    "Auto-backup before Phase 15 ved.js migration"
      });
      if (history.length > 20) history.shift();
      client.flowHistory = history;
      client.markModified("flowHistory");
    }

    console.log("🔄 Updating nodes and edges...");
    client.flowNodes = DELITECH_NODES;
    client.flowEdges = DELITECH_EDGES;
    client.isGenericBot = true; // IMPORTANT: Switches to dualBrainEngine
    
    console.log("📦 Updating nicheData with product & FAQ context...");
    client.nicheData = {
      ...client.nicheData,
      storeUrl: "https://delitechsmarthome.in",
      products: [
        {
          id: "2mp", name: "Delitech Smart Video Doorbell (2MP)",
          price: 5499, 
          description: "1080p HD Video, Night Vision, 2-Way Audio, 100% Wireless",
          image: "https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png",
          url: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-2mp"
        },
        {
          id: "3mp", name: "Delitech Smart Video Doorbell Plus (3MP)",
          price: 6499,
          description: "2048×1536 3MP HD, Color Night Vision, Real-Time 2-Way Audio",
          image: "https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png",
          url: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-3mp"
        },
        {
          id: "5mp", name: "Delitech Smart Video Doorbell Pro (5MP)",
          price: 6999,
          description: "5MP Crystal Clear, 130° Wide View, AI Smart Visitor Log, Anti-Theft Siren, IP65",
          image: "https://delitechsmarthome.in/cdn/shop/files/my1.png",
          url: "https://delitechsmarthome.in/products/delitech-smart-wireless-video-doorbell-5mp"
        }
      ],
      faqs: [
        { question: "Is it hard to install?", answer: "Not at all! It's 100% Wireless DIY. No electricians or wiring needed. Setup takes under 2 minutes." },
        { question: "How long does the battery last?", answer: "Up to 6 months on a single charge. Recharge via USB cable." },
        { question: "What about warranty?", answer: "1-Year Replacement Warranty on manufacturing defects + free premium technical support." }
      ],
      businessHours: "Mon-Sat 9AM-7PM IST"
    };

    client.markModified("flowNodes");
    client.markModified("flowEdges");
    client.markModified("nicheData");

    await client.save();
    console.log(`✅ Delitech flow migrated. ${DELITECH_NODES.length} nodes, ${DELITECH_EDGES.length} edges.`);
    console.log("👉 Open Flow Builder in Dashboard to verify visual layout.");
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

migrate();
