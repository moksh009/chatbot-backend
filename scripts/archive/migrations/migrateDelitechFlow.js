const mongoose = require("mongoose");
const Client   = require("../models/Client");
require("dotenv").config();

const DELITECH_NODES = [
  // Entry trigger
  { id: "trigger_start", type: "TriggerNode",
    position: { x: 350, y: 0 },
    data: { label: "Greeting Trigger", keyword: "hi" }
  },
  // Welcome template
  { id: "welcome_node", type: "TemplateNode",
    position: { x: 350, y: 120 },
    data: {
      label:           "Welcome Message",
      metaTemplateName:"delitech_welcome",
      headerImageUrl:  "",  // fill in actual image URL
      templateParams:  []
    }
  },
  // Doorbell options
  { id: "doorbell_menu", type: "InteractiveNode",
    position: { x: 350, y: 280 },
    data: {
      label: "Product Menu",
      body:  "Which doorbell are you interested in? 🏠",
      buttons: [
        { id: "btn_3mp", label: "📷 3MP Doorbell" },
        { id: "btn_5mp", label: "📷 5MP Doorbell" },
        { id: "btn_website", label: "🌐 Visit Website" }
      ]
    }
  },
  // 3MP Product
  { id: "product_3mp", type: "TemplateNode",
    position: { x: 100, y: 460 },
    data: {
      label:            "3MP Doorbell",
      metaTemplateName: "3mp_final",
      headerImageUrl:   "",
      templateParams:   []
    }
  },
  // 5MP Product  
  { id: "product_5mp", type: "TemplateNode",
    position: { x: 350, y: 460 },
    data: {
      label:            "5MP Doorbell",
      metaTemplateName: "5mp_final",
      headerImageUrl:   "",
      templateParams:   [{ key: "price", value: "₹6,999" }]
    }
  },
  // Website redirect
  { id: "website_node", type: "MessageNode",
    position: { x: 600, y: 460 },
    data: {
      label: "Website",
      body:  "Visit our website for all products and offers! 🌐\n\nhttps://delitechsmarthome.in"
    }
  },
  // FAQ node
  { id: "faq_node", type: "MessageNode",
    position: { x: 600, y: 280 },
    data: {
      label: "Setup & FAQ",
      body:  "Here are answers to common questions:\n\n📦 Shipping: 3-5 business days pan India\n🔧 Installation: Free guide included\n💧 Waterproof: IP65 rated\n🔋 Battery: 6-month life\n✅ Warranty: 1 year\n\nAny other questions? Just ask!",
      action: "AI_FALLBACK"  // engine uses Gemini for follow-up
    }
  },
  // Back to menu
  { id: "back_menu", type: "InteractiveNode",
    position: { x: 350, y: 640 },
    data: {
      label: "Back to Menu",
      body:  "What else can I help you with?",
      buttons: [
        { id: "btn_3mp_2",  label: "3MP Doorbell" },
        { id: "btn_5mp_2",  label: "5MP Doorbell" },
        { id: "btn_faq_2",  label: "FAQ & Setup"  }
      ]
    }
  }
];

const DELITECH_EDGES = [
  { id: "e_trigger_welcome",  source: "trigger_start",  target: "welcome_node",   trigger: { type: "auto" } },
  { id: "e_welcome_menu",     source: "welcome_node",   target: "doorbell_menu",  trigger: { type: "auto" } },
  { id: "e_menu_3mp",         source: "doorbell_menu",  target: "product_3mp",    sourceHandle: "btn_3mp"  },
  { id: "e_menu_5mp",         source: "doorbell_menu",  target: "product_5mp",    sourceHandle: "btn_5mp"  },
  { id: "e_menu_website",     source: "doorbell_menu",  target: "website_node",   sourceHandle: "btn_website" },
  { id: "e_menu_faq",         source: "doorbell_menu",  target: "faq_node",       trigger: { type: "keyword", value: "faq" } },
  { id: "e_3mp_back",         source: "product_3mp",    target: "back_menu",      trigger: { type: "auto" } },
  { id: "e_5mp_back",         source: "product_5mp",    target: "back_menu",      trigger: { type: "auto" } },
  { id: "e_back_3mp",         source: "back_menu",      target: "product_3mp",    sourceHandle: "btn_3mp_2" },
  { id: "e_back_5mp",         source: "back_menu",      target: "product_5mp",    sourceHandle: "btn_5mp_2" },
  { id: "e_back_faq",         source: "back_menu",      target: "faq_node",       sourceHandle: "btn_faq_2" }
];

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  
  await Client.findOneAndUpdate(
    { clientId: "delitech_smarthomes" },
    { $set: { flowNodes: DELITECH_NODES, flowEdges: DELITECH_EDGES } }
  );
  
  console.log("Delitech flow migrated to visual builder.");
  await mongoose.disconnect();
}

migrate().catch(console.error);
