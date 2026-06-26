'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo, clearCollections } = require('../helpers/memoryMongo');
const Client = require('../../models/Client');
const OptInTool = require('../../models/OptInTool');
const optInService = require('../../services/optInToolsService');

const CLIENT_A = 'optin_tenant_a';
const CLIENT_B = 'optin_tenant_b';

describe('optInToolsService', () => {
  before(async () => {
    await startMemoryMongo();
    await Client.create([
      { clientId: CLIENT_A, businessName: 'Brand A', shopifyConnected: true, shopDomain: 'a.myshopify.com' },
      { clientId: CLIENT_B, businessName: 'Brand B', shopifyConnected: true, shopDomain: 'b.myshopify.com' },
    ]);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('ensureEmbedPublicKey generates key on first tool create', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({
      clientId: CLIENT_A,
      businessName: 'Brand A',
      shopifyConnected: true,
      growthEmbedPublicKey: '',
    });

    const tool = await optInService.createTool(CLIENT_A, { type: 'popup' });
    assert.ok(tool.id);
    assert.equal(tool.status, 'draft');
    assert.equal(tool.type, 'popup');

    const client = await Client.findOne({ clientId: CLIENT_A }).lean();
    assert.ok(client.growthEmbedPublicKey);
    assert.ok(client.growthEmbedPublicKey.length >= 32);
  });

  it('tenant isolation — client B cannot read client A tool by id', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create([
      { clientId: CLIENT_A, businessName: 'A' },
      { clientId: CLIENT_B, businessName: 'B' },
    ]);
    const created = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'A popup' });
    const cross = await optInService.getToolForClient(CLIENT_B, created.id);
    assert.equal(cross, null);
  });

  it('listTools returns honest zero metrics for empty workspace', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({ clientId: CLIENT_A, businessName: 'A' });
    const { tools, metrics } = await optInService.listTools(CLIENT_A);
    assert.equal(tools.length, 0);
    assert.equal(metrics.liveTools, 0);
    assert.equal(metrics.totalViews, 0);
    assert.equal(metrics.totalSignups, 0);
    assert.equal(metrics.signupRate, 0);
  });

  it('getPublicConfig returns only live tools for embed key', async () => {
    await clearCollections(['Client', 'OptInTool']);
    const key = 'b'.repeat(48);
    await Client.create({
      clientId: CLIENT_A,
      businessName: 'A',
      growthEmbedPublicKey: key,
      growthEmbedEnabled: true,
    });
    const draft = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'Draft popup' });
    const liveDoc = await OptInTool.findById(draft.id);
    liveDoc.status = 'live';
    liveDoc.publishedAt = new Date();
    await liveDoc.save();

    const cfg = await optInService.getPublicConfig(key);
    assert.equal(cfg.success, true);
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].type, 'popup');
  });

  it('deleteTool blocks live tools', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({ clientId: CLIENT_A, businessName: 'A' });
    const tool = await optInService.createTool(CLIENT_A, { type: 'popup' });
    await OptInTool.updateOne({ _id: tool.id }, { $set: { status: 'live' } });
    const result = await optInService.deleteTool(CLIENT_A, tool.id);
    assert.equal(result.deleted, false);
    assert.equal(result.reason, 'live_tool');
  });

  it('publishTool allows connected Shopify credentials without legacy shopifyConnected flag', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({
      clientId: CLIENT_A,
      businessName: 'Brand A',
      shopDomain: 'a.myshopify.com',
      shopifyAccessToken: 'shpat_test_publish_token_abc',
      shopifyConnectionStatus: 'connected',
    });
    const tool = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'Launch popup' });

    const shopifyHelper = require('../../utils/shopify/shopifyHelper');
    const originalInject = shopifyHelper.injectOptInScript;
    shopifyHelper.injectOptInScript = async () => ({ success: true, message: 'mock inject' });

    try {
      const result = await optInService.publishTool(CLIENT_A, tool.id, 'https://api.test');
      assert.equal(result.success, true);
      assert.equal(result.tool.status, 'live');
    } finally {
      shopifyHelper.injectOptInScript = originalInject;
    }
  });

  it('publishTool allows Shopify credentials on shopifyStores[] without legacy top-level token', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({
      clientId: CLIENT_A,
      businessName: 'Brand A',
      shopifyConnectionStatus: 'connected',
      shopifyStores: [
        {
          shopDomain: 'store-a.myshopify.com',
          accessToken: 'shpat_test_store_array_token_xyz',
          isPrimary: true,
          status: 'connected',
        },
      ],
    });
    const tool = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'Store array popup' });

    const shopifyHelper = require('../../utils/shopify/shopifyHelper');
    const originalInject = shopifyHelper.injectOptInScript;
    shopifyHelper.injectOptInScript = async () => ({ success: true, message: 'mock inject' });

    try {
      const result = await optInService.publishTool(CLIENT_A, tool.id, 'https://api.test');
      assert.equal(result.success, true);
    } finally {
      shopifyHelper.injectOptInScript = originalInject;
    }
  });

  it('publishTool allows credentials stored under config.commerce paths', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({
      clientId: CLIENT_A,
      businessName: 'Brand A',
      shopifyConnectionStatus: 'connected',
      config: {
        shopDomain: 'config-store.myshopify.com',
        shopifyAccessToken: 'shpat_test_config_path_token_xyz',
      },
    });
    const tool = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'Config path popup' });

    const shopifyHelper = require('../../utils/shopify/shopifyHelper');
    const originalInject = shopifyHelper.injectOptInScript;
    shopifyHelper.injectOptInScript = async () => ({ success: true, message: 'mock inject' });

    try {
      const result = await optInService.publishTool(CLIENT_A, tool.id, 'https://api.test');
      assert.equal(result.success, true);
    } finally {
      shopifyHelper.injectOptInScript = originalInject;
    }
  });

  it('publishTool blocks when Shopify is not connected', async () => {
    await clearCollections(['Client', 'OptInTool']);
    await Client.create({ clientId: CLIENT_A, businessName: 'Brand A' });
    const tool = await optInService.createTool(CLIENT_A, { type: 'popup', name: 'Draft popup' });

    const result = await optInService.publishTool(CLIENT_A, tool.id, 'https://api.test');
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.match(result.message, /Connect Shopify/i);
  });
});
