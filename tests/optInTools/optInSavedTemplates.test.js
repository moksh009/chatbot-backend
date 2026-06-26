'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMongo, stopMemoryMongo } = require('../helpers/memoryMongo');
const OptInTool = require('../../models/OptInTool');
const OptInSavedTemplate = require('../../models/OptInSavedTemplate');
const {
  saveTemplateFromTool,
  listSavedTemplates,
} = require('../../services/optInSavedTemplatesService');
const { createTool } = require('../../services/optInToolsService');
const Client = require('../../models/Client');

const CLIENT = 'optin_saved_tpl_tenant';

describe('optIn saved templates', () => {
  let toolId;

  before(async () => {
    await startMemoryMongo();
    await Client.create({
      clientId: CLIENT,
      businessName: 'Saved Co',
      growthEmbedEnabled: true,
    });
    const tool = await OptInTool.create({
      clientId: CLIENT,
      name: 'Festive popup',
      type: 'popup',
      status: 'draft',
      design: { headline: 'Diwali sale', colors: { buttonBackground: '#7C3AED' } },
    });
    toolId = String(tool._id);
  });

  after(async () => {
    await stopMemoryMongo();
  });

  it('saveTemplateFromTool stores merchant design', async () => {
    const saved = await saveTemplateFromTool(CLIENT, toolId, 'My festive');
    assert.ok(saved?.id);
    const list = await listSavedTemplates(CLIENT);
    assert.equal(list.length, 1);
    assert.equal(list[0].design.headline, 'Diwali sale');
  });

  it('createTool from saved template clones design', async () => {
    const saved = await OptInSavedTemplate.findOne({ clientId: CLIENT }).lean();
    const tool = await createTool(CLIENT, {
      type: saved.type,
      name: 'Clone',
      design: saved.design,
      triggers: saved.triggers,
      prizes: saved.prizes,
    });
    assert.equal(tool.design.headline, 'Diwali sale');
  });
});
