const mongoose = require('mongoose');
const Client = require('../models/Client');
const WhatsAppFlow = require('../models/WhatsAppFlow');
const { clearTriggerCache } = require('../utils/triggerEngine');

const CLIENT_ID = 'shubhampatelsbusiness_1cfb2b';
const FLOW_ID = 'flow_apex_owner_support_hub_v1';

function buildFlow() {
  const nodes = [
    {
      id: 'n_trigger',
      type: 'trigger',
      position: { x: 80, y: 80 },
      data: {
        label: 'Apex support entry',
        triggerType: 'first_message',
        trigger: { type: 'first_message', channel: 'whatsapp' },
      },
    },
    {
      id: 'n_main_menu',
      type: 'interactive',
      position: { x: 380, y: 80 },
      data: {
        label: 'Main support hub',
        interactiveType: 'button',
        text: 'Welcome to Apex Light Support. Choose what you need:',
        buttonsList: [
          { id: 'products', title: 'My Products' },
          { id: 'warranty', title: 'Warranty Status' },
          { id: 'install', title: 'Help to Install' },
          { id: 'troubleshoot', title: 'Troubleshoot' },
          { id: 'human', title: 'Talk to Human' },
          { id: 'order', title: 'Order Help' },
        ],
      },
    },
    { id: 'n_catalog', type: 'catalog', position: { x: 760, y: -220 }, data: { label: 'Products catalog' } },
    { id: 'n_warranty', type: 'warranty_check', position: { x: 760, y: -20 }, data: { label: 'Warranty lookup', action: 'WARRANTY_CHECK' } },
    {
      id: 'n_warranty_active',
      type: 'message',
      position: { x: 1090, y: -120 },
      data: {
        label: 'Warranty active response',
        text: 'Warranty is active for {{_warranty_product_name|your product}}. Expires on {{_warranty_expires_display|N/A}}. Order: {{_warranty_order_ref|-}}.',
      },
    },
    {
      id: 'n_warranty_expired',
      type: 'message',
      position: { x: 1090, y: -20 },
      data: {
        label: 'Warranty expired response',
        text: 'Warranty has expired for {{_warranty_product_name|this product}}. Expiry date: {{_warranty_expires_display|N/A}}.',
      },
    },
    {
      id: 'n_warranty_none',
      type: 'message',
      position: { x: 1090, y: 80 },
      data: {
        label: 'Warranty not found response',
        text: 'No warranty found for this number yet. Share your order ID and we will help immediately.',
      },
    },
    {
      id: 'n_install_lookup',
      type: 'shopify_call',
      position: { x: 760, y: 220 },
      data: {
        label: 'Fetch latest purchase',
        action: 'CHECK_ORDER_STATUS',
        silent: true,
        variable: 'latest_order_ctx',
      },
    },
    {
      id: 'n_install_confirm',
      type: 'interactive',
      position: { x: 1090, y: 220 },
      data: {
        label: 'Install product confirmation',
        interactiveType: 'button',
        text: 'We found your recent product: {{first_product_title|latest order product}}. Need install help for this?',
        buttonsList: [
          { id: 'yes_this', title: 'Yes for this product' },
          { id: 'no_other', title: 'No, another product' },
          { id: 'main_menu', title: 'Back to Main Menu' },
        ],
      },
    },
    {
      id: 'n_install_yes_21',
      type: 'logic',
      position: { x: 1420, y: 130 },
      data: { label: 'Is HDMI 2.1?', variable: 'metadata.first_product_title', operator: 'contains', value: '2.1' },
    },
    {
      id: 'n_install_yes_20',
      type: 'logic',
      position: { x: 1740, y: 130 },
      data: { label: 'Is HDMI 2.0?', variable: 'metadata.first_product_title', operator: 'contains', value: '2.0' },
    },
    {
      id: 'n_pack_21',
      type: 'message',
      position: { x: 2060, y: 40 },
      data: {
        label: 'HDMI 2.1 install pack',
        text: 'Apex HDMI 2.1 install video: https://youtu.be/b82bLHryIxM?feature=shared\nApp: Smart Life\nCut only on white dotted lines and connect via HDMI input -> sync box -> HDMI OUT to TV.',
      },
    },
    {
      id: 'n_pack_20',
      type: 'message',
      position: { x: 2060, y: 150 },
      data: {
        label: 'HDMI 2.0 install pack',
        text: 'Apex HDMI 2.0 install video: https://youtu.be/iPyzkp_guTA?feature=shared\nApp: Smart Life\nStart from bottom-left (back of TV), follow clockwise, and cut only at dotted lines.',
      },
    },
    {
      id: 'n_ask_product_name',
      type: 'message',
      position: { x: 1420, y: 300 },
      data: {
        label: 'Ask full product name',
        text: 'Please type the full product name exactly as on your order so I can guide you correctly.',
      },
    },
    {
      id: 'n_capture_product_name',
      type: 'capture_input',
      position: { x: 1740, y: 300 },
      data: {
        label: 'Capture requested product',
        question: 'Enter full product name',
        text: 'Enter full product name',
        variable: 'install_product_query',
      },
    },
    {
      id: 'n_query_is_21',
      type: 'logic',
      position: { x: 2060, y: 250 },
      data: { label: 'Typed HDMI 2.1?', variable: 'metadata.install_product_query', operator: 'contains', value: '2.1' },
    },
    {
      id: 'n_query_is_20',
      type: 'logic',
      position: { x: 2380, y: 250 },
      data: { label: 'Typed HDMI 2.0?', variable: 'metadata.install_product_query', operator: 'contains', value: '2.0' },
    },
    {
      id: 'n_no_pack',
      type: 'message',
      position: { x: 2700, y: 320 },
      data: {
        label: 'No support pack matched',
        text: 'I could not auto-match that product yet. I am connecting you to support for manual guidance.',
        action: 'ESCALATE_HUMAN',
      },
    },
    {
      id: 'n_troubleshoot_menu',
      type: 'interactive',
      position: { x: 760, y: 520 },
      data: {
        label: 'Troubleshoot menu',
        interactiveType: 'button',
        text: 'Choose your issue:',
        buttonsList: [
          { id: 'no_sync', title: 'Not syncing' },
          { id: 'half_glow', title: 'Half strip glowing' },
          { id: 'app_issue', title: 'App not connecting' },
          { id: 'flicker', title: 'Screen flickering' },
          { id: 'main_menu', title: 'Back to Main Menu' },
        ],
      },
    },
    {
      id: 'n_issue_answer',
      type: 'message',
      position: { x: 1090, y: 520 },
      data: {
        label: 'Issue guidance',
        text: 'Quick fixes: use 2.4GHz for Smart Life app, restart sync box (hold button 10s), reconnect cables in sequence, and ensure HDMI source is external device (not built-in TV apps).',
      },
    },
    {
      id: 'n_order_help',
      type: 'order_action',
      position: { x: 760, y: 700 },
      data: { label: 'Order status helper', actionType: 'CHECK_ORDER_STATUS', action: 'CHECK_ORDER_STATUS' },
    },
    {
      id: 'n_human',
      type: 'message',
      position: { x: 760, y: 860 },
      data: {
        label: 'Human handoff',
        text: 'Connecting you to Apex support now. Please share photos/video for faster diagnosis.',
        action: 'ESCALATE_HUMAN',
      },
    },
    {
      id: 'n_back_menu',
      type: 'interactive',
      position: { x: 3020, y: 140 },
      data: {
        label: 'Need more help?',
        interactiveType: 'button',
        text: 'Need anything else?',
        buttonsList: [
          { id: 'menu', title: 'Main Menu' },
          { id: 'human', title: 'Talk to Human' },
        ],
      },
    },
  ];

  const edges = [
    { id: 'e_1', source: 'n_trigger', target: 'n_main_menu' },
    { id: 'e_products', source: 'n_main_menu', sourceHandle: 'products', target: 'n_catalog' },
    { id: 'e_warranty', source: 'n_main_menu', sourceHandle: 'warranty', target: 'n_warranty' },
    { id: 'e_install', source: 'n_main_menu', sourceHandle: 'install', target: 'n_install_lookup' },
    { id: 'e_trouble', source: 'n_main_menu', sourceHandle: 'troubleshoot', target: 'n_troubleshoot_menu' },
    { id: 'e_human', source: 'n_main_menu', sourceHandle: 'human', target: 'n_human' },
    { id: 'e_order', source: 'n_main_menu', sourceHandle: 'order', target: 'n_order_help' },

    { id: 'e_w_active', source: 'n_warranty', sourceHandle: 'active', target: 'n_warranty_active' },
    { id: 'e_w_expired', source: 'n_warranty', sourceHandle: 'expired', target: 'n_warranty_expired' },
    { id: 'e_w_none', source: 'n_warranty', sourceHandle: 'none', target: 'n_warranty_none' },

    { id: 'e_lookup_default', source: 'n_install_lookup', target: 'n_install_confirm' },
    { id: 'e_lookup_no_order', source: 'n_install_lookup', sourceHandle: 'no_order', target: 'n_ask_product_name' },
    { id: 'e_yes_this', source: 'n_install_confirm', sourceHandle: 'yes_this', target: 'n_install_yes_21' },
    { id: 'e_no_other', source: 'n_install_confirm', sourceHandle: 'no_other', target: 'n_ask_product_name' },
    { id: 'e_yes_menu', source: 'n_install_confirm', sourceHandle: 'main_menu', target: 'n_main_menu' },
    { id: 'e_yes21_t', source: 'n_install_yes_21', sourceHandle: 'true', target: 'n_pack_21' },
    { id: 'e_yes21_f', source: 'n_install_yes_21', sourceHandle: 'false', target: 'n_install_yes_20' },
    { id: 'e_yes20_t', source: 'n_install_yes_20', sourceHandle: 'true', target: 'n_pack_20' },
    { id: 'e_yes20_f', source: 'n_install_yes_20', sourceHandle: 'false', target: 'n_ask_product_name' },

    { id: 'e_ask_capture', source: 'n_ask_product_name', target: 'n_capture_product_name' },
    { id: 'e_capture_logic1', source: 'n_capture_product_name', target: 'n_query_is_21' },
    { id: 'e_q21_t', source: 'n_query_is_21', sourceHandle: 'true', target: 'n_pack_21' },
    { id: 'e_q21_f', source: 'n_query_is_21', sourceHandle: 'false', target: 'n_query_is_20' },
    { id: 'e_q20_t', source: 'n_query_is_20', sourceHandle: 'true', target: 'n_pack_20' },
    { id: 'e_q20_f', source: 'n_query_is_20', sourceHandle: 'false', target: 'n_no_pack' },

    { id: 'e_trouble_no_sync', source: 'n_troubleshoot_menu', sourceHandle: 'no_sync', target: 'n_issue_answer' },
    { id: 'e_trouble_half', source: 'n_troubleshoot_menu', sourceHandle: 'half_glow', target: 'n_issue_answer' },
    { id: 'e_trouble_app', source: 'n_troubleshoot_menu', sourceHandle: 'app_issue', target: 'n_issue_answer' },
    { id: 'e_trouble_flicker', source: 'n_troubleshoot_menu', sourceHandle: 'flicker', target: 'n_issue_answer' },
    { id: 'e_trouble_menu', source: 'n_troubleshoot_menu', sourceHandle: 'main_menu', target: 'n_main_menu' },

    { id: 'e_pack21_footer', source: 'n_pack_21', target: 'n_back_menu' },
    { id: 'e_pack20_footer', source: 'n_pack_20', target: 'n_back_menu' },
    { id: 'e_issue_footer', source: 'n_issue_answer', target: 'n_back_menu' },
    { id: 'e_wactive_footer', source: 'n_warranty_active', target: 'n_back_menu' },
    { id: 'e_wexpired_footer', source: 'n_warranty_expired', target: 'n_back_menu' },
    { id: 'e_wnone_footer', source: 'n_warranty_none', target: 'n_back_menu' },
    { id: 'e_order_footer', source: 'n_order_help', target: 'n_back_menu' },
    { id: 'e_footer_menu', source: 'n_back_menu', sourceHandle: 'menu', target: 'n_main_menu' },
    { id: 'e_footer_human', source: 'n_back_menu', sourceHandle: 'human', target: 'n_human' },
  ];

  return { nodes, edges };
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });
  const client = await Client.findOne({ clientId: CLIENT_ID });
  if (!client) throw new Error(`Client not found: ${CLIENT_ID}`);

  const { nodes, edges } = buildFlow();

  await WhatsAppFlow.updateMany(
    { clientId: CLIENT_ID, platform: 'whatsapp', flowId: { $ne: FLOW_ID } },
    { $set: { status: 'DRAFT' } }
  );

  const update = {
    clientId: CLIENT_ID,
    flowId: FLOW_ID,
    name: 'Apex Owner Support Hub',
    platform: 'whatsapp',
    status: 'PUBLISHED',
    version: 1,
    nodes,
    edges,
    publishedNodes: nodes,
    publishedEdges: edges,
    triggerConfig: { type: 'KEYWORD' },
    description: 'Owner-focused support hub: products, warranty, install, troubleshooting, human handoff, order help',
    categories: ['support', 'warranty', 'installation', 'owner_experience'],
    lastSyncedAt: new Date(),
  };

  const flowDoc = await WhatsAppFlow.findOneAndUpdate(
    { clientId: CLIENT_ID, flowId: FLOW_ID },
    { $set: update, $setOnInsert: { createdAt: new Date() } },
    { new: true, upsert: true }
  );

  const visualEntry = {
    id: FLOW_ID,
    name: 'Apex Owner Support Hub',
    platform: 'whatsapp',
    folderId: '',
    isActive: true,
    nodes,
    edges,
    updatedAt: new Date(),
  };

  await Client.updateOne(
    { clientId: CLIENT_ID },
    {
      $set: {
        plan: 'CX Agent (V2)',
        tier: 'v2',
        isPaidAccount: true,
        trialActive: false,
        'billing.plan': 'CX Agent (V2)',
        'billing.tier': 'v2',
        'billing.isPaidAccount': true,
        'config.serviceMode': 'done_for_you',
        'config.dfyEnabled': true,
      },
      $pull: { visualFlows: { id: FLOW_ID } },
    }
  );
  await Client.updateOne({ clientId: CLIENT_ID }, { $push: { visualFlows: visualEntry } });

  clearTriggerCache(CLIENT_ID);

  console.log(
    JSON.stringify(
      {
        success: true,
        clientId: CLIENT_ID,
        flowId: FLOW_ID,
        flowDbId: String(flowDoc._id),
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
      null,
      2
    )
  );
}

run()
  .catch((err) => {
    console.error('[setupApexOwnerSupportFlow] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
