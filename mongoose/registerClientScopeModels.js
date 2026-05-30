'use strict';

/**
 * Apply enforceClientScope to all tenant-scoped models (Phase 5).
 * Loaded once at boot after mongoose connects.
 */
const { enforceClientScope } = require('./plugins/enforceClientScope');

const TENANT_MODELS = [
  'AdLead',
  'Campaign',
  'CampaignMessage',
  'Conversation',
  'Message',
  'Order',
  'FollowUpSequence',
  'ScheduledMessage',
  'WhatsAppFlow',
  'KeywordTrigger',
  'Segment',
  'MessageEnvelope',
  'PixelEvent',
  'VisitorIdentity',
  'LinkClickEvent',
  'WarrantyRecord',
  'IGAutomation',
  'QRCode',
  'GrowthQrScan',
  'ConversationNote',
  'BotAnalytics',
  'SuppressionList',
  'Contact',
  'ExportJob',
  'FlowHistory',
  'FlowAnalytics',
  'IntentRule',
  'MetaTemplate',
  'CheckoutLink',
  'CartRecoveryAttempt',
  'IGConversation',
  'IGAutomationSession',
  'InventoryAdjustment',
  'InventoryLedger',
  'SkuMapping',
  'ShopifyProduct',
  'AmazonInventorySnapshot',
  'RestockRule',
  'StockoutEvent',
  'ReturnEvent',
  'InventoryLocation',
  'BundleDefinition',
  'BackorderRule',
  'RestockSuggestionDismissal',
  'PurchaseOrder',
  'Supplier',
  'KnowledgeDocument',
  'AiWallet',
  'AiTokenTransaction',
];

function registerClientScopeModels() {
  const mongoose = require('mongoose');
  for (const name of TENANT_MODELS) {
    const model = mongoose.models[name];
    if (!model?.schema) continue;
    if (model.schema.__clientScopeRegistered) continue;
    model.schema.plugin(enforceClientScope);
    model.schema.__clientScopeRegistered = true;
  }
}

module.exports = { registerClientScopeModels, TENANT_MODELS };
