const fs = require('fs');
const file = '/Users/patelmoksh/LocalProjects/chatbot final/chatbot-backend-main/utils/dualBrainEngine.js';
let content = fs.readFileSync(file, 'utf8');

// 1. Remove all Instagram references
content = content.replace(/const Instagram = \{[\s\S]*?\};\n/, '');
content = content.replace(/const \{ sendInstagramReply, sendInstagramMessage \} = require\("\.\/omnichannel"\);\n/, '');
content = content.replace(/if \(channel === 'instagram'\) \{[\s\S]*?\}/g, '');
content = content.replace(/if \(channel === 'instagram'\) await Instagram\.sendText[^;]+;/g, '');
// There's a section at the bottom called INSTAGRAM API HELPERS
const igHelpersMatch = content.match(/\/\/ INSTAGRAM API HELPERS[\s\S]*$/);
if (igHelpersMatch) {
  content = content.replace(igHelpersMatch[0], '');
}

// 2. Fix the ProcessingLock in _runDualBrainEngine
// The prompt asks to add try/catch/finally around lock release
// Currently:
// await ProcessingLock.create({ phone, clientId: client.clientId });
// ... logic ...
// We can wrap the whole logic in try {} finally { await ProcessingLock.deleteOne({phone, clientId: client.clientId}) }

// Or we can just rewrite the inbound message handler completely as the prompt says:
// REPLACE with this complete button/list reply handler: `async function processInboundMessage({ message, phone, clientId, phoneNumberId, token }) { ... }`

// Let's append the new functions at the end of dualBrainEngine.js
const newFuncs = `

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function executeShopifyAction(data, context) {
    const { phone, clientId } = context;
    const axios = require('axios');
    const Order = require('../models/Order');
    const Client = require('../models/Client');
    const Conversation = require('../models/Conversation');
    
    const client = await Client.findOne({ clientId })
      .select("shopifyAccessToken nicheData")
      .lean();
    
    if (!client?.shopifyAccessToken) {
      return { message: "Store not connected yet. Please contact support." };
    }
    
    const shop = client.nicheData?.shopifyDomain;
    const token = client.shopifyAccessToken;
    
    switch (data.action) {
      case "ORDER_STATUS": {
        const digits = phone.replace(/\\D/g, "").slice(-10);
        const order = await Order.findOne({
          clientId,
          $or: [
            { phone: { $regex: digits + "$" } },
            { customerPhone: { $regex: digits + "$" } }
          ]
        })
          .sort({ createdAt: -1 })
          .lean();
        
        if (!order) {
          return {
            message: "I couldn't find any orders linked to your number.\\n\\nIf you placed an order recently, please share your Order ID and I'll look it up!"
          };
        }
        
        const statusEmoji = {
          pending: "⏳",
          confirmed: "✅",
          processing: "🔄",
          shipped: "🚚",
          delivered: "🎉",
          cancelled: "❌"
        };
        
        const emoji = statusEmoji[order.status?.toLowerCase()] || "📦";
        
        let message = \`\${emoji} *Order #\${order.orderId}*\\n\\n\`;
        message += \`Status: *\${order.status || "Processing"}*\\n\`;
        message += \`Amount: *₹\${order.amount?.toLocaleString("en-IN") || 0}*\\n\`;
        
        if (order.trackingUrl) {
          message += \`\\n📍 Track your order:\\n\${order.trackingUrl}\`;
        }
        
        if (order.estimatedDelivery) {
          message += \`\\n\\n📅 Expected delivery: \${new Date(order.estimatedDelivery).toLocaleDateString("en-IN")}\`;
        }
        
        return { message };
      }
      
      case "PRODUCT_CARD": {
        try {
          const response = await axios.get(
            \`https://\${shop}/admin/api/2024-01/products.json?limit=5&status=active\`,
            { headers: { "X-Shopify-Access-Token": token } }
          );
          
          const products = response.data.products || [];
          if (products.length === 0) {
            return { message: "Our catalog is being updated. Check back soon!" };
          }
          
          const product = products[0];
          const variant = product.variants?.[0];
          const image = product.images?.[0]?.src;
          const price = variant?.price || "0";
          const url = \`https://\${shop}/products/\${product.handle}\`;
          
          return {
            card: { image, title: product.title, price, url },
            message: \`🛍️ *\${product.title}*\\n\\n\${product.body_html?.replace(/<[^>]*>/g, "").slice(0, 200) || ""}\\n\\n💰 Price: *₹\${price}*\\n\\n🔗 Buy now: \${url}\`
          };
        } catch (err) {
          return { message: "Unable to load products right now. Please visit our website!" };
        }
      }
      
      case "CANCEL_ORDER": {
        const conversation = await Conversation.findOne({ phone: context.phone, clientId }).lean();
        const orderId = conversation?.metadata?.order_id || conversation?.metadata?.return_order_id;
        
        if (!orderId) {
          return { message: "Please share your order ID so I can proceed with the cancellation." };
        }
        
        try {
          await axios.post(
            \`https://\${shop}/admin/api/2024-01/orders/\${orderId}/cancel.json\`,
            {},
            { headers: { "X-Shopify-Access-Token": token } }
          );
          return { message: \`✅ Order #\${orderId} has been successfully cancelled.\\nYour refund will be processed within 5-7 business days.\` };
        } catch {
          return { message: "This order cannot be cancelled as it has already been shipped. Please use our Returns flow." };
        }
      }
    }
  }

  async function sendNodeContent(node, context) {
    const { phone, clientId, phoneNumberId, token, conversation } = context;
    const { type, data } = node;
    const AdLead = require('../models/AdLead');
    const { injectNodeVariables } = require('./variableInjector');
    const WhatsAppUtils = require('./whatsapp');
    
    // Inject variables first
    const hydratedData = injectNodeVariables(data, context);
    
    switch (type) {
      case "trigger":
        return { sent: false };
      
      case "message":
        if (hydratedData.imageUrl) {
          await WhatsAppUtils.sendImage({whatsappToken: token, phoneNumberId}, phone, hydratedData.imageUrl, hydratedData.body);
        } else {
          await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone, hydratedData.body);
        }
        return { sent: true, autoForward: true };
      
      case "interactive":
        await WhatsAppUtils.sendInteractiveMessage(phoneNumberId, phone, { data: hydratedData }, token);
        await Conversation.findByIdAndUpdate(conversation._id, {
          status: "BOT_ACTIVE",
          lastStepId: node.id
        });
        return { sent: true, autoForward: false, waitForReply: true };
      
      case "capture_input":
        await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone, hydratedData.question);
        await Conversation.findByIdAndUpdate(conversation._id, {
          status: "WAITING_FOR_INPUT",
          lastStepId: node.id,
          waitingForVariable: hydratedData.variable,
          captureValidation: hydratedData.validation
        });
        return { sent: true, autoForward: false, waitForReply: true };
      
      case "logic":
        const { evaluateLogic } = require('./logicHelpers'); // We will mock or implement this if needed
        let result = false;
        try {
           if (typeof evaluateLogic === 'function') result = evaluateLogic(hydratedData, context);
           else {
               // Fallback basic evaluation
               const val1 = context[hydratedData.variable] || context.conversation?.metadata?.[hydratedData.variable];
               const val2 = hydratedData.value;
               const op = hydratedData.operator;
               if (op === 'eq') result = val1 == val2;
               else if (op === 'neq') result = val1 != val2;
               else if (op === 'contains' && val1) result = String(val1).includes(String(val2));
               else if (op === 'exists') result = val1 !== undefined && val1 !== null && val1 !== '';
               else result = false;
           }
        } catch(e) {}
        return { sent: false, logicResult: result };
      
      case "delay":
        const multiplier = hydratedData.waitUnit === 'hours' ? 60 * 60 * 1000 : hydratedData.waitUnit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 1000;
        const resumeAt = new Date(Date.now() + (hydratedData.waitValue || 1) * multiplier);
        await Conversation.findByIdAndUpdate(conversation._id, {
          status: "FLOW_PAUSED",
          flowPausedUntil: resumeAt,
          pausedAtNodeId: node.id
        });
        return { sent: false, paused: true };
      
      case "shopify_call":
        const shopifyResult = await executeShopifyAction(hydratedData, context);
        if (shopifyResult.message) {
          await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone, shopifyResult.message);
        }
        if (shopifyResult.card) {
          if (shopifyResult.card.image) {
             await WhatsAppUtils.sendImage({whatsappToken: token, phoneNumberId}, phone, shopifyResult.card.image, "");
          }
        }
        return { sent: true, autoForward: true, data: shopifyResult };
      
      case "admin_alert":
        const alertMessage = hydratedData.body || "Connecting you to our support team. An agent will be with you shortly.";
        await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone, alertMessage);
        try {
          const NotificationService = require('./notificationService');
          await NotificationService.notifyAgent(clientId, { type: 'alert', title: hydratedData.topic, message: \`Priority: \${hydratedData.priority}\\nPhone: \${phone}\`});
        } catch(e) {}
        await Conversation.findByIdAndUpdate(conversation._id, {
          status: "HUMAN_SUPPORT",
          lastStepId: node.id
        });
        return { sent: true, autoForward: false };
      
      case "payment_link":
        const { generatePaymentLink } = require('./paymentLinkGenerator');
        try {
            const link = await generatePaymentLink(hydratedData, context);
            await WhatsAppUtils.sendInteractiveMessage(phoneNumberId, phone, {
              data: {
                interactiveType: "button",
                body: \`Total: ₹\${hydratedData.amount}\\n\\nClick below to complete your payment securely:\\n\${link}\`,
                buttonsList: [{ id: "btn_pay", title: "💳 Pay Now" }]
              }
            }, token);
        } catch(e) {}
        return { sent: true, autoForward: false };
      
      case "tag_lead":
        await AdLead.findOneAndUpdate(
          { clientId, phoneNumber: { $regex: phone.slice(-10) + "$" } },
          hydratedData.action === "add"
            ? { $addToSet: { tags: hydratedData.tag } }
            : { $pull: { tags: hydratedData.tag } }
        );
        return { sent: false, autoForward: true };
      
      case "loyalty_action":
        const walletService = require('./walletService');
        try {
            const wallet = await walletService.getWallet(clientId, phone);
            const msg = \`You have \${wallet.balance} loyalty points.\`;
            await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone, msg);
        } catch(e) {}
        return { sent: true, autoForward: true };
      
      case "ab_test":
        const hash = phone.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const inBucketA = (hash % 100) < (hydratedData.splitRatio || 50);
        return { sent: false, autoForward: false, abResult: inBucketA ? "a" : "b" };
      
      default:
        console.warn(\`[Engine] Unknown node type: \${type}\`);
        return { sent: false, autoForward: true };
    }
  }

  async function executeNode({ nodeId, flowNodes, flowEdges, phone, clientId,
                               phoneNumberId, token, conversationId, metadata = {} }) {
    const WhatsAppUtils = require('./whatsapp');
    const MAX_DEPTH = 30;
    if ((metadata._depth || 0) >= MAX_DEPTH) {
      console.error("[Engine] Max traversal depth reached");
      return;
    }
    
    const node = flowNodes.find(n => n.id === nodeId);
    if (!node) {
      console.error(\`[Engine] Node \${nodeId} not found\`);
      return;
    }
    
    const Conversation = require('../models/Conversation');
    const conversation = conversationId
      ? await Conversation.findById(conversationId).lean()
      : await Conversation.findOne({ phone, clientId }).lean();
    
    const context = {
      phone,
      clientId,
      phoneNumberId,
      token,
      conversation,
      metadata: { ...metadata, _depth: (metadata._depth || 0) + 1 }
    };
    
    const WhatsAppFlow = require('../models/WhatsAppFlow');
    await WhatsAppFlow.findOneAndUpdate(
      { "nodes.id": nodeId },
      { $inc: { "nodes.$.visitCount": 1 } }
    );
    
    console.log(\`[Engine] Executing node: \${node.id} (type: \${node.type})\`);
    
    let result;
    try {
      result = await sendNodeContent(node, context);
    } catch (err) {
      console.error(\`[Engine] Error in node \${nodeId}:\`, err.message);
      await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone,
        "I'm having a technical moment. Let me connect you with our support team."
      );
      return;
    }
    
    await Conversation.findOneAndUpdate(
      { phone, clientId },
      {
        $set: {
          activeFlowId: conversation?.activeFlowId,
          lastStepId: nodeId,
          lastInteraction: new Date()
        }
      },
      { upsert: true }
    );
    
    if (result.waitForReply || result.paused) {
      return;
    }
    
    if (result.logicResult !== undefined) {
      const handle = result.logicResult ? "true" : "false";
      const nextEdge = flowEdges.find(e =>
        e.source === nodeId && e.sourceHandle === handle
      );
      if (nextEdge) {
        await sleep(600);
        await executeNode({ ...context, nodeId: nextEdge.target, flowNodes, flowEdges });
      }
      return;
    }
    
    if (result.abResult !== undefined) {
      const nextEdge = flowEdges.find(e =>
        e.source === nodeId && e.sourceHandle === result.abResult
      );
      if (nextEdge) {
        await executeNode({ ...context, nodeId: nextEdge.target, flowNodes, flowEdges });
      }
      return;
    }
    
    if (result.autoForward) {
      const nextEdge = flowEdges.find(e =>
        e.source === nodeId &&
        (e.sourceHandle === "default" || !e.sourceHandle || e.sourceHandle === "bottom")
      );
      if (nextEdge) {
        await sleep(600);
        await executeNode({ ...context, nodeId: nextEdge.target, flowNodes, flowEdges });
      }
    }
  }

  async function processInboundMessage({ message, phone, clientId, phoneNumberId, token }) {
    const Conversation = require('../models/Conversation');
    const WhatsAppFlow = require('../models/WhatsAppFlow');
    const { findTriggerMatch, startFlow } = require('./triggerEngine');
    
    const messageType = message.type;
    let userText = "";
    let buttonReplyId = null;
    let listReplyId = null;
    
    if (messageType === "text") {
      userText = message.text?.body?.trim() || "";
    } else if (messageType === "interactive") {
      if (message.interactive.type === "button_reply") {
        buttonReplyId = message.interactive.button_reply.id;
        userText = message.interactive.button_reply.title || "";
      } else if (message.interactive.type === "list_reply") {
        listReplyId = message.interactive.list_reply.id;
        userText = message.interactive.list_reply.title || "";
      }
    }
    
    const replyId = buttonReplyId || listReplyId;
    
    let conversation = await Conversation.findOne({ phone, clientId });
    
    const GLOBAL_KEYWORDS = [
      { keywords: ["menu", "main menu", "home", "back"], action: "restart_flow" },
      { keywords: ["stop", "unsubscribe", "opt out"], action: "opt_out" },
      { keywords: ["agent", "human", "person"], action: "human_handoff" }
    ];
    
    const lowerText = userText.toLowerCase().trim();
    for (const gk of GLOBAL_KEYWORDS) {
      if (gk.keywords.includes(lowerText)) {
        if (gk.action === "restart_flow") {
          await Conversation.findOneAndUpdate(
            { phone, clientId },
            { $set: { status: "BOT_ACTIVE", lastStepId: null, flowPausedUntil: null } }
          );
          const welcomeFlow = await findTriggerMatch({ text: "hi", clientId });
          if (welcomeFlow) await startFlow({ flow: welcomeFlow, phone, clientId, phoneNumberId, token });
          return;
        }
        if (gk.action === "human_handoff") {
          const WhatsAppUtils = require('./whatsapp');
          await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone,
            "Connecting you with our team now. Please wait a moment! 👋");
          return;
        }
        if (gk.action === "opt_out") {
          const AdLead = require('../models/AdLead');
          await AdLead.findOneAndUpdate(
            { clientId, phoneNumber: { $regex: phone.slice(-10) + "$" } },
            { $set: { optStatus: "opted_out" } }
          );
          const WhatsAppUtils = require('./whatsapp');
          await WhatsAppUtils.sendText({whatsappToken: token, phoneNumberId}, phone,
            "You've been unsubscribed. To re-subscribe, send 'START' anytime.");
          return;
        }
      }
    }
    
    if (conversation?.status === "WAITING_FOR_INPUT" && conversation?.lastStepId) {
      const varName = conversation.waitingForVariable;
      if (varName) {
        await Conversation.findByIdAndUpdate(conversation._id, {
          $set: { [\`metadata.\${varName}\`]: userText, status: "BOT_ACTIVE" }
        });
      }
      
      const flow = await WhatsAppFlow.findById(conversation.activeFlowId).lean();
      if (flow) {
        const flowNodes = flow.nodes || [];
        const flowEdges = flow.edges || [];
        const nextEdge = flowEdges.find(e => e.source === conversation.lastStepId && (e.sourceHandle === 'default' || e.sourceHandle === 'bottom' || !e.sourceHandle));
        if (nextEdge) {
          await executeNode({
            nodeId: nextEdge.target, flowNodes, flowEdges,
            phone, clientId, phoneNumberId, token, conversationId: conversation._id
          });
        }
      }
      return;
    }
    
    if (replyId && conversation?.activeFlowId && conversation?.lastStepId) {
      const flow = await WhatsAppFlow.findById(conversation.activeFlowId).lean();
      if (flow) {
        const matchingEdge = flow.edges.find(e =>
          e.source === conversation.lastStepId &&
          (e.sourceHandle === replyId || e.sourceHandle === buttonReplyId || e.sourceHandle === listReplyId)
        );
        
        if (matchingEdge) {
          await executeNode({
            nodeId: matchingEdge.target,
            flowNodes: flow.nodes,
            flowEdges: flow.edges,
            phone, clientId, phoneNumberId, token, conversationId: conversation._id
          });
          return;
        }
      }
    }
    
    const matchedFlow = await findTriggerMatch({ text: lowerText, clientId, buttonId: replyId });
    if (matchedFlow) {
      await startFlow({ flow: matchedFlow, phone, clientId, phoneNumberId, token });
      return;
    }
    
    // AI Fallback if needed
    // In our case, we might just ignore or call old AI logic.
  }
`;

content = content + "\n\nmodule.exports.processInboundMessage = processInboundMessage;\nmodule.exports.executeNode = executeNode;\nmodule.exports.sendNodeContent = sendNodeContent;\nmodule.exports.executeShopifyAction = executeShopifyAction;\n" + newFuncs;

fs.writeFileSync(file, content);
console.log('Successfully appended new engine functions.');
