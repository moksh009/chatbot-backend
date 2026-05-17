const mongoose = require("mongoose");
const Client   = require("../models/Client");
const log      = require("../utils/logger")("MigrationDelitech");
require("dotenv").config();

// --- 1. COORDINATES & ASSETS ---
const IMAGES = {
    hero_3mp: 'https://delitechsmarthome.in/cdn/shop/files/Delitech_Main_photoswq.png?v=1760635732&width=1346',
    hero_5mp: 'https://delitechsmarthome.in/cdn/shop/files/my1.png?v=1759746759&width=1346',
    hero_2mp: 'https://delitechsmarthome.in/cdn/shop/files/DelitechMainphotos7i.png?v=1770617818&width=1346',
    features: 'https://delitechsmarthome.in/cdn/shop/files/image241.png?v=1762148394&width=1346'
};

const DELITECH_NODES = [
  // --- Folder: Entry ---
  { id: "trigger_all", type: "trigger", position: { x: 400, y: 0 },
    data: { label: "Main Trigger", keywords: ["hi", "hello", "details", "price", "doorbell", "info", "menu"] }
  },
  
  // --- Main Menu (List) ---
  { id: "menu_main", type: "interactive", position: { x: 400, y: 150 },
    data: {
      label: "Main Product Menu",
      body: "Invest in your family's safety. Select a model below to view exclusive photos and pricing:\n\n*(Tip: Over 80% of our customers choose the 3MP Pro for absolute clarity)*",
      interactiveType: "list",
      listButtonTitle: "View Doorbells",
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
        { title: "Need Help?", rows: [
            { id: "menu_agent", title: "Consult an Expert", description: "Get a free security callback" },
            { id: "menu_faqs", title: "Setup & FAQ", description: "Installation & Battery info" }
          ]
        }
      ]
    }
  },

  // --- Product Cards (Interactive Buttons) ---
  { id: "card_5mp", type: "message", position: { x: 0, y: 450 },
    data: {
      label: "5MP Product Card",
      text: "🛡️ *Delitech Smart Video Doorbell Pro (5MP)*\n\nThe ultimate peace-of-mind solution. Unmatched clarity and premium security.\n\n💎 *5MP Crystal-Clear Resolution*\n👀 *Ultra-Wide View*\n🌈 *Color Night Vision*\n\n💰 *Offer Price:* ₹6,999\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
      headerType: "image",
      headerUrl: IMAGES.hero_5mp,
      buttons: [
        { id: "buy_5mp", label: "🛒 Buy Now" },
        { id: "agent_5mp", label: "📞 Call Me" },
        { id: "menu_main_back", label: "View Other" }
      ]
    }
  },
  { id: "card_3mp", type: "message", position: { x: 400, y: 450 },
    data: {
      label: "3MP Product Card",
      text: "🛡️ *Delitech Smart Video Doorbell Plus (3MP)*\n\nThe perfect balance of affordability and HD security.\n\n📹 *2K Crisp Video*\n🌈 *Color Night Vision*\n🗣️ *Real-Time 2-Way Audio*\n\n💰 *Offer Price:* ₹6,499\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
      headerType: "image",
      headerUrl: IMAGES.hero_3mp,
      buttons: [
        { id: "buy_3mp", label: "🛒 Buy Now" },
        { id: "agent_3mp", label: "📞 Call Me" },
        { id: "menu_main_back_2", label: "View Other" }
      ]
    }
  },
  { id: "card_2mp", type: "message", position: { x: 800, y: 450 },
    data: {
      label: "2MP Product Card",
      text: "🛡️ *Delitech Smart Video Doorbell (2MP)*\n\nEssential home security made simple.\n\n📹 *1080p HD Video*\n🌙 *Night Vision*\n🗣️ *2-Way Audio*\n\n💰 *Offer Price:* ₹5,499\n✅ 1 Year Warranty | 🚚 Free Shipping | 🛠️ Free Installation",
      headerType: "image",
      headerUrl: IMAGES.hero_2mp,
      buttons: [
        { id: "buy_2mp", label: "🛒 Buy Now" },
        { id: "agent_2mp", label: "📞 Call Me" },
        { id: "menu_main_back_3", label: "View Other" }
      ]
    }
  },

  // --- Purchase Links ---
  { id: "link_5mp", type: "message", position: { x: -200, y: 700 },
    data: { label: "Checkout 5MP", text: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 https://delitechsmarthome.in/cart/prod_5mp:1?utm_source=whatsapp&utm_medium=chatbot\n\n_Cash on Delivery Available_" }
  },
  { id: "link_3mp", type: "message", position: { x: 400, y: 700 },
    data: { label: "Checkout 3MP", text: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 https://delitechsmarthome.in/cart/prod_3mp:1?utm_source=whatsapp&utm_medium=chatbot\n\n_Cash on Delivery Available_" }
  },
  { id: "link_2mp", type: "message", position: { x: 1000, y: 700 },
    data: { label: "Checkout 2MP", text: "⚡ *Excellent Choice!* ⚡\n\nClick the link below to verify your address and complete your order:\n\n👉 https://delitechsmarthome.in/cart/prod_2mp:1?utm_source=whatsapp&utm_medium=chatbot\n\n_Cash on Delivery Available_" }
  },

  // --- FAQs (List & Answers) ---
  { id: "faq_list", type: "interactive", position: { x: 1200, y: 150 },
    data: {
      label: "FAQ Menu",
      body: "🤖 Got questions? I've got answers. Select a topic below:",
      interactiveType: "list",
      listButtonTitle: "View Guides",
      sections: [
        { title: "Setup", rows: [
            { id: "faq_install", title: "How to install?", description: "100% Wireless DIY details" },
            { id: "faq_battery", title: "Battery Life", description: "Recharging & Weatherproofing" }
          ]
        },
        { title: "Peace of Mind", rows: [
            { id: "faq_warranty", title: "Warranty Policy", description: "1-Year coverage guarantee" }
          ]
        }
      ]
    }
  },
  { id: "ans_install", type: "message", position: { x: 1400, y: 350 },
    data: { label: "Installation Info", text: "🛠️ *Is it hard to install?*\nNot at all! It's *100% Wireless DIY*. No electricians or wiring needed. Setup through the CloudEdge App is instant." }
  },
  { id: "ans_battery", type: "message", position: { x: 1400, y: 450 },
    data: { label: "Battery Info", text: "🔋 *How long does the battery last?*\nThe IP65 weatherproof battery lasts *up to 6 months* on a single charge. Simply recharge it via USB." }
  },
  { id: "ans_warranty", type: "message", position: { x: 1400, y: 550 },
    data: { label: "Warranty Info", text: "🛡️ *What about Warranty & Support?*\nEnjoy complete peace of mind with our *1-Year Replacement Warranty* on any manufacturing defects." }
  },

  // --- Human Handover ---
  { id: "agent_handover", type: "livechat", position: { x: 100, y: 200 },
    data: { label: "Agent Callback", text: "✅ *Request Received!*\nOur security expert has been notified. They will call you shortly on this number.\n\nIn the meantime, feel free to browse our features!" }
  }
];

const DELITECH_EDGES = [
  // Trigger to Main Menu
  { id: "e_start", source: "trigger_all", target: "menu_main" },
  
  // List Menu to Cards
  { id: "em_5mp", source: "menu_main", target: "card_5mp", sourceHandle: "sel_5mp" },
  { id: "em_3mp", source: "menu_main", target: "card_3mp", sourceHandle: "sel_3mp" },
  { id: "em_2mp", source: "menu_main", target: "card_2mp", sourceHandle: "sel_2mp" },
  { id: "em_agent", source: "menu_main", target: "agent_handover", sourceHandle: "menu_agent" },
  { id: "em_faq", source: "menu_main", target: "faq_list", sourceHandle: "menu_faqs" },

  // Cards to Purchase/Agent/Back
  { id: "eb_5mp_buy", source: "card_5mp", target: "link_5mp", sourceHandle: "buy_5mp" },
  { id: "eb_5mp_call", source: "card_5mp", target: "agent_handover", sourceHandle: "agent_5mp" },
  { id: "eb_5mp_back", source: "card_5mp", target: "menu_main", sourceHandle: "menu_main_back" },

  { id: "eb_3mp_buy", source: "card_3mp", target: "link_3mp", sourceHandle: "buy_3mp" },
  { id: "eb_3mp_call", source: "card_3mp", target: "agent_handover", sourceHandle: "agent_3mp" },
  { id: "eb_3mp_back", source: "card_3mp", target: "menu_main", sourceHandle: "menu_main_back_2" },

  { id: "eb_2mp_buy", source: "card_2mp", target: "link_2mp", sourceHandle: "buy_2mp" },
  { id: "eb_2mp_call", source: "card_2mp", target: "agent_handover", sourceHandle: "agent_2mp" },
  { id: "eb_2mp_back", source: "card_2mp", target: "menu_main", sourceHandle: "menu_main_back_3" },

  // FAQ List to Answers
  { id: "ef_install", source: "faq_list", target: "ans_install", sourceHandle: "faq_install" },
  { id: "ef_battery", source: "faq_list", target: "ans_battery", sourceHandle: "faq_battery" },
  { id: "ef_warranty", source: "faq_list", target: "ans_warranty", sourceHandle: "faq_warranty" }
];

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB for Delitech Smart Home migration.");

    const update = {
      $set: {
        flowNodes: DELITECH_NODES,
        flowEdges: DELITECH_EDGES,
        businessType: "other",
        isActive: true,
        isGenericBot: false
      }
    };

    const client = await Client.findOneAndUpdate(
      { clientId: "delitech_smarthomes" },
      update,
      { new: true, upsert: true }
    );

    if (client) {
      console.log(`✅ SUCCESS: Delitech Smart Home flow successfully migrated and injected.`);
      console.log(`Total Nodes: ${DELITECH_NODES.length}`);
      console.log(`Total Edges: ${DELITECH_EDGES.length}`);
    } else {
      console.error("❌ ERROR: Failed to update client record.");
    }

  } catch (error) {
    console.error("❌ MIGRATION FAILED:", error.message);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB.");
    process.exit(0);
  }
}

migrate();
