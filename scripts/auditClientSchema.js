require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');

async function auditClients() {
  console.log(`[Audit] Starting Client Schema Parallel Run Audit...`);
  
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`[Audit] Connected to MongoDB.`);

    const clients = await Client.find({}).lean();
    let mismatchCount = 0;
    const mismatches = [];

    clients.forEach(client => {
      const issues = [];
      const cId = client.clientId;

      // Brand
      if (client.name !== undefined && client.name !== client.brand?.businessName) issues.push(`brand.businessName (${client.brand?.businessName}) !== name (${client.name})`);
      if (client.niche !== undefined && client.niche !== client.brand?.niche) issues.push(`brand.niche (${client.brand?.niche}) !== niche (${client.niche})`);
      
      // WhatsApp
      if (client.phoneNumberId !== undefined && client.phoneNumberId !== client.whatsapp?.phoneNumberId) issues.push(`whatsapp.phoneNumberId (${client.whatsapp?.phoneNumberId}) !== phoneNumberId (${client.phoneNumberId})`);
      if (client.wabaId !== undefined && client.wabaId !== client.whatsapp?.wabaId) issues.push(`whatsapp.wabaId (${client.whatsapp?.wabaId}) !== wabaId (${client.wabaId})`);
      if (client.whatsappToken !== undefined && client.whatsappToken !== client.whatsapp?.accessToken) issues.push(`whatsapp.accessToken !== whatsappToken`);
      
      // Commerce - Shopify
      if (client.shopDomain !== undefined && client.shopDomain !== client.commerce?.shopify?.domain) issues.push(`shopify.domain !== shopDomain`);
      if (client.shopifyAccessToken !== undefined && client.shopifyAccessToken !== client.commerce?.shopify?.accessToken) issues.push(`shopify.accessToken !== shopifyAccessToken`);
      if (client.shopifyClientSecret !== undefined && client.shopifyClientSecret !== client.commerce?.shopify?.clientSecret) issues.push(`shopify.clientSecret !== shopifyClientSecret`);
      if (client.shopifyWebhookSecret !== undefined && client.shopifyWebhookSecret !== client.commerce?.shopify?.webhookSecret) issues.push(`shopify.webhookSecret !== shopifyWebhookSecret`);

      // Commerce - WooCommerce
      if (client.woocommerceUrl !== undefined && client.woocommerceUrl !== client.commerce?.woocommerce?.url) issues.push(`woocommerce.url !== woocommerceUrl`);
      if (client.woocommerceKey !== undefined && client.woocommerceKey !== client.commerce?.woocommerce?.key) issues.push(`woocommerce.key !== woocommerceKey`);
      if (client.woocommerceSecret !== undefined && client.woocommerceSecret !== client.commerce?.woocommerce?.secret) issues.push(`woocommerce.secret !== woocommerceSecret`);

      // AI
      if (client.geminiApiKey !== undefined && client.geminiApiKey !== client.ai?.geminiKey) issues.push(`ai.geminiKey !== geminiApiKey`);
      if (client.openaiApiKey !== undefined && client.openaiApiKey !== client.ai?.openaiKey) issues.push(`ai.openaiKey !== openaiApiKey`);
      if (client.systemPrompt !== undefined && client.systemPrompt !== client.ai?.systemPrompt) issues.push(`ai.systemPrompt !== systemPrompt`);

      // Social - Instagram
      if (client.instagramPageId !== undefined && client.instagramPageId !== client.social?.instagram?.pageId) issues.push(`instagram.pageId !== instagramPageId`);
      if (client.instagramAccessToken !== undefined && client.instagramAccessToken !== client.social?.instagram?.accessToken) issues.push(`instagram.accessToken !== instagramAccessToken`);
      if (client.instagramAppSecret !== undefined && client.instagramAppSecret !== client.social?.instagram?.appSecret) issues.push(`instagram.appSecret !== instagramAppSecret`);

      if (issues.length > 0) {
        mismatchCount++;
        mismatches.push({ clientId: cId, issues });
      }
    });

    console.log(`\n[Audit] Checked ${clients.length} clients.`);
    if (mismatchCount === 0) {
      console.log(`[Audit] ✅ SUCCESS: All dual-write fields match perfectly.`);
    } else {
      console.log(`[Audit] ❌ WARNING: Found mismatches in ${mismatchCount} clients.`);
      console.log(JSON.stringify(mismatches, null, 2));
    }

  } catch (error) {
    console.error(`[Audit] Error during audit:`, error);
  } finally {
    mongoose.disconnect();
    console.log(`[Audit] Finished.`);
  }
}

auditClients();
