/**
 * scripts/migrateDelitechFlow.js
 *
 * Run ONCE to convert the hardcoded Delitech flow to visual flow builder nodes.
 *
 * Usage:
 *   node scripts/migrateDelitechFlow.js
 */

const mongoose = require("mongoose");
const Client   = require("../models/Client");
require("dotenv").config();

const DELITECH_NODES = [
  // ── Entry trigger ────────────────────────────────────────────────
  {
    id:       "trigger_start",
    type:     "TriggerNode",
    position: { x: 350, y: 0 },
    data:     { label: "Greeting Trigger", keyword: "hi" }
  },
  // ── Welcome template ─────────────────────────────────────────────
  {
    id:       "welcome_node",
    type:     "TemplateNode",
    position: { x: 350, y: 120 },
    data: {
      label:            "Welcome Message",
      templateName:     "delitech_welcome",
      headerImageUrl:   "",   // fill in actual image URL in the flow builder
      variables:        ""
    }
  },
  // ── Doorbell product menu ─────────────────────────────────────────
  {
    id:       "doorbell_menu",
    type:     "InteractiveNode",
    position: { x: 350, y: 280 },
    data: {
      label: "Product Menu",
      body:  "Which doorbell are you interested in? 🏠",
      buttonsList: [
        { id: "btn_3mp",     title: "📷 3MP Doorbell" },
        { id: "btn_5mp",     title: "📷 5MP Doorbell" },
        { id: "btn_website", title: "🌐 Visit Website" }
      ]
    }
  },
  // ── 3MP Product ──────────────────────────────────────────────────
  {
    id:       "product_3mp",
    type:     "TemplateNode",
    position: { x: 100, y: 460 },
    data: {
      label:          "3MP Doorbell",
      templateName:   "3mp_final",
      headerImageUrl: "",
      variables:      ""
    }
  },
  // ── 5MP Product ──────────────────────────────────────────────────
  {
    id:       "product_5mp",
    type:     "TemplateNode",
    position: { x: 350, y: 460 },
    data: {
      label:          "5MP Doorbell",
      templateName:   "5mp_final",
      headerImageUrl: "",
      variables:      "₹6,999"
    }
  },
  // ── Website redirect ─────────────────────────────────────────────
  {
    id:       "website_node",
    type:     "MessageNode",
    position: { x: 600, y: 460 },
    data: {
      label: "Website",
      body:  "Visit our website for all products and offers! 🌐\n\nhttps://delitechsmarthome.in"
    }
  },
  // ── FAQ node (AI enabled) ─────────────────────────────────────────
  {
    id:       "faq_node",
    type:     "MessageNode",
    position: { x: 600, y: 280 },
    data: {
      label:  "Setup & FAQ",
      body:   "Here are answers to common questions:\n\n📦 Shipping: 3-5 business days pan India\n🔧 Installation: Free guide included\n💧 Waterproof: IP65 rated\n🔋 Battery: 6-month life\n✅ Warranty: 1 year\n\nAny other questions? Just ask!",
      action: "AI_FALLBACK"
    }
  },
  // ── Back to menu ─────────────────────────────────────────────────
  {
    id:       "back_menu",
    type:     "InteractiveNode",
    position: { x: 350, y: 640 },
    data: {
      label: "Back to Menu",
      body:  "What else can I help you with?",
      buttonsList: [
        { id: "btn_3mp_2",  title: "3MP Doorbell" },
        { id: "btn_5mp_2",  title: "5MP Doorbell" },
        { id: "btn_faq_2",  title: "FAQ & Setup"  }
      ]
    }
  }
];

const DELITECH_EDGES = [
  { id: "e_trigger_welcome", source: "trigger_start",  target: "welcome_node",   trigger: { type: "auto" }                          },
  { id: "e_welcome_menu",    source: "welcome_node",   target: "doorbell_menu",  trigger: { type: "auto" }                          },
  { id: "e_menu_3mp",        source: "doorbell_menu",  target: "product_3mp",    sourceHandle: "btn_3mp"                            },
  { id: "e_menu_5mp",        source: "doorbell_menu",  target: "product_5mp",    sourceHandle: "btn_5mp"                            },
  { id: "e_menu_website",    source: "doorbell_menu",  target: "website_node",   sourceHandle: "btn_website"                        },
  { id: "e_menu_faq",        source: "doorbell_menu",  target: "faq_node",       trigger: { type: "keyword", value: "faq" }         },
  { id: "e_3mp_back",        source: "product_3mp",    target: "back_menu",      trigger: { type: "auto" }                          },
  { id: "e_5mp_back",        source: "product_5mp",    target: "back_menu",      trigger: { type: "auto" }                          },
  { id: "e_back_3mp",        source: "back_menu",      target: "product_3mp",    sourceHandle: "btn_3mp_2"                          },
  { id: "e_back_5mp",        source: "back_menu",      target: "product_5mp",    sourceHandle: "btn_5mp_2"                          },
  { id: "e_back_faq",        source: "back_menu",      target: "faq_node",       sourceHandle: "btn_faq_2"                          }
];

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const result = await Client.findOneAndUpdate(
    { clientId: "delitech_smarthomes" },
    { $set: { flowNodes: DELITECH_NODES, flowEdges: DELITECH_EDGES } },
    { new: true }
  );

  if (!result) {
    console.error("❌ Client 'delitech_smarthomes' not found. Check clientId.");
  } else {
    console.log(`✅ Delitech flow migrated to visual builder (${DELITECH_NODES.length} nodes, ${DELITECH_EDGES.length} edges).`);
  }

  await mongoose.disconnect();
  console.log("✅ Disconnected from MongoDB");
}

migrate().catch(err => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
