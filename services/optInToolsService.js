'use strict';

const crypto = require('crypto');
const OptInTool = require('../models/OptInTool');
const Client = require('../models/Client');
const {
  defaultDesignForType,
  defaultTriggers,
  defaultPrizesForSpin,
  defaultNameForType,
} = require('../constants/optInToolDefaults');
const { getTemplateById, getTemplateDesignDefaults } = require('../constants/optInToolTemplates');
const { resolveMerchantWaPhone } = require('../utils/optIn/resolveMerchantWaPhone');
const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
const { getCachedClient, CONNECTION_STATUS_SELECT, invalidateClientCache } = require('../utils/core/clientCache');
const {
  isShopifyCredentialConnected,
  repairLegacyShopifyFields,
} = require('../utils/shopify/resolveShopifyCredentials');
const {
  injectOptInScriptIntoLiquid,
  removeOptInScriptFromLiquid,
} = require('../utils/optIn/optInThemeInject');

const TOOL_TYPES = new Set(['whatsapp_widget', 'popup', 'spin_wheel', 'mystery_discount']);

const PUBLISH_CLIENT_SELECT = `${CONNECTION_STATUS_SELECT} config growthEmbedPublicKey growthEmbedEnabled`;

async function loadClientForPublish(clientId) {
  await repairLegacyShopifyFields(clientId).catch((err) => {
    console.warn('[optInTools] repairLegacyShopifyFields', err.message);
  });
  invalidateClientCache(clientId);
  return getCachedClient(clientId, PUBLISH_CLIENT_SELECT);
}

function isShopifyReadyForPublish(client) {
  if (!client) return false;
  if (isShopifyCredentialConnected(client)) return true;
  return buildConnectionStatusPayload(client).shopify_connected === true;
}

function serializeTool(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  return {
    ...o,
    id: String(o._id),
    impressions: normalizeRollup(o.impressions),
    signups: normalizeRollup(o.signups),
    couponRedemptions: normalizeRollup(o.couponRedemptions),
  };
}

function normalizeRollup(rollup) {
  if (!rollup) return { total: 0, byDay: {} };
  const byDay =
    rollup.byDay instanceof Map
      ? Object.fromEntries(rollup.byDay)
      : rollup.byDay && typeof rollup.byDay === 'object'
        ? rollup.byDay
        : {};
  return { total: Number(rollup.total) || 0, byDay };
}

function serializeToolForPublic(tool, client) {
  return {
    id: String(tool._id),
    type: tool.type,
    design: tool.design || {},
    triggers: tool.triggers || {},
    prizes: (tool.prizes || []).map((p) => ({
      label: p.label,
      couponMode: p.couponMode,
      probability: p.probability,
    })),
    mysteryRevealType: tool.mysteryRevealType || 'scratch',
    sendWhatsAppWelcome: tool.sendWhatsAppWelcome !== false,
    thankYouConfig: tool.thankYouConfig || {},
    shopDomain: client?.shopDomain || '',
    merchantWaPhone: resolveMerchantWaPhone(client, tool.design || {}),
    branding: {
      name: client?.brand?.businessName || client?.businessName || 'Our brand',
    },
  };
}

async function ensureEmbedPublicKey(clientId) {
  const client = await Client.findOne({ clientId }).select('growthEmbedPublicKey growthEmbedEnabled');
  if (!client) throw new Error('Client not found');
  if (client.growthEmbedPublicKey && client.growthEmbedPublicKey.length >= 16) {
    return client.growthEmbedPublicKey;
  }
  const key = crypto.randomBytes(24).toString('hex');
  await Client.updateOne(
    { clientId },
    { $set: { growthEmbedPublicKey: key, growthEmbedEnabled: true } }
  );
  return key;
}

async function getHubMetrics(clientId) {
  const [liveCount, tools] = await Promise.all([
    OptInTool.countDocuments({ clientId, status: 'live' }),
    OptInTool.find({ clientId }).select('impressions signups').lean(),
  ]);
  let totalViews = 0;
  let totalSignups = 0;
  for (const t of tools) {
    totalViews += Number(t.impressions?.total) || 0;
    totalSignups += Number(t.signups?.total) || 0;
  }
  const signupRate = totalViews > 0 ? Math.round((totalSignups / totalViews) * 1000) / 10 : 0;
  return {
    liveTools: liveCount,
    totalViews,
    totalSignups,
    signupRate,
  };
}

const STATUS_ALIAS = { published: 'live', paused: 'draft' };

function normalizeStatusValue(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return STATUS_ALIAS[s] || s;
}

async function listTools(clientId, { status, type, search, fields } = {}) {
  const query = { clientId };

  if (status) {
    const statuses = String(status)
      .split(',')
      .map(normalizeStatusValue)
      .filter(Boolean);
    if (statuses.length === 1) {
      query.status = statuses[0];
    } else if (statuses.length > 1) {
      query.status = { $in: statuses };
    }
  }
  if (type && TOOL_TYPES.has(type)) query.type = type;

  const projection = fields
    ? String(fields).split(',').map((f) => f.trim()).filter(Boolean).join(' ')
    : null;

  let tools = projection
    ? await OptInTool.find(query).select(projection).sort({ updatedAt: -1 }).lean()
    : await OptInTool.find(query).sort({ updatedAt: -1 }).lean();

  if (search) {
    const q = String(search).toLowerCase().trim();
    tools = tools.filter(
      (t) =>
        String(t.name || '').toLowerCase().includes(q) ||
        String(t.type || '').toLowerCase().includes(q)
    );
  }

  if (projection) {
    return { tools: tools.map((t) => ({ ...t, id: String(t._id) })) };
  }

  const metrics = await getHubMetrics(clientId);
  return { tools: tools.map((t) => serializeTool(t)), metrics };
}

async function getToolForClient(clientId, toolId) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return null;
  return serializeTool(tool);
}

async function createTool(clientId, payload = {}) {
  const type = TOOL_TYPES.has(payload.type) ? payload.type : 'popup';
  const templateId = String(payload.templateId || '').trim();
  const template = templateId ? getTemplateById(templateId) : null;

  await ensureEmbedPublicKey(clientId);

  const design = templateId
    ? getTemplateDesignDefaults(templateId, template?.type || type)
    : { ...defaultDesignForType(type), ...(payload.design || {}) };
  if (templateId === 'mystery_tap') {
    design.mysteryRevealType = 'tap_hold';
  } else if (templateId === 'mystery_scratch') {
    design.mysteryRevealType = 'scratch';
  }

  const doc = {
    clientId,
    name: String(payload.name || '').trim() || defaultNameForType(type, templateId),
    type: template?.type || type,
    status: 'draft',
    templateId: templateId || '',
    design,
    triggers: { ...defaultTriggers(), ...(payload.triggers || {}) },
    prizes:
      payload.prizes ||
      (type === 'spin_wheel' || type === 'mystery_discount' ? defaultPrizesForSpin() : []),
    mysteryRevealType:
      payload.mysteryRevealType ||
      (templateId === 'mystery_tap' ? 'tap_hold' : 'scratch'),
    sendWhatsAppWelcome: payload.sendWhatsAppWelcome !== false,
    thankYouConfig: payload.thankYouConfig || { showBestsellers: true, shopNowUrl: '', socialLinks: {} },
  };

  const tool = await OptInTool.create(doc);
  return serializeTool(tool);
}

async function updateTool(clientId, toolId, payload = {}) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return null;

  const allowed = [
    'name',
    'design',
    'triggers',
    'prizes',
    'mysteryRevealType',
    'sendWhatsAppWelcome',
    'welcomeTemplateSlot',
    'thankYouConfig',
    'templateId',
  ];
  for (const key of allowed) {
    if (payload[key] !== undefined) tool[key] = payload[key];
  }
  tool.updatedAt = new Date();
  await tool.save();
  return serializeTool(tool);
}

async function duplicateTool(clientId, toolId) {
  const source = await OptInTool.findOne({ _id: toolId, clientId }).lean();
  if (!source) return null;
  const { _id, createdAt, updatedAt, publishedAt, impressions, signups, couponRedemptions, status, ...rest } =
    source;
  const copy = await OptInTool.create({
    ...rest,
    clientId,
    name: `${source.name} (copy)`,
    status: 'draft',
    publishedAt: null,
    themeInjectVersion: 0,
    impressions: { total: 0, byDay: {} },
    signups: { total: 0, byDay: {} },
    couponRedemptions: { total: 0, byDay: {} },
  });
  return serializeTool(copy);
}

async function deleteTool(clientId, toolId) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return { deleted: false, reason: 'not_found' };
  if (tool.status === 'live') {
    return { deleted: false, reason: 'live_tool', message: 'Unpublish before deleting a live tool.' };
  }
  await OptInTool.deleteOne({ _id: toolId, clientId });
  return { deleted: true };
}

async function enforceSingleLiveWhatsappWidget(clientId, excludeToolId) {
  await OptInTool.updateMany(
    {
      clientId,
      type: 'whatsapp_widget',
      status: 'live',
      _id: { $ne: excludeToolId },
    },
    { $set: { status: 'draft' } }
  );
}

function validateToolForPublish(tool, client) {
  const errors = [];
  if (!tool.name?.trim()) errors.push('Tool name is required.');
  if (!TOOL_TYPES.has(tool.type)) errors.push('Invalid tool type.');
  if (tool.type === 'whatsapp_widget') {
    const digits = resolveMerchantWaPhone(client, tool.design || {});
    if (!digits || digits.length < 10) {
      errors.push('WhatsApp business number required — connect WhatsApp or enter a number in the editor.');
    }
  }
  if ((tool.type === 'spin_wheel' || tool.type === 'mystery_discount') && tool.prizes?.length) {
    const probSum = tool.prizes.reduce((s, p) => s + (Number(p.probability) || 0), 0);
    if (probSum !== 100) errors.push('Prize probabilities must sum to 100.');
  }
  return errors;
}

async function publishTool(clientId, toolId, backendUrl) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return { success: false, status: 404, message: 'Tool not found' };

  const client = await loadClientForPublish(clientId);
  if (!client) return { success: false, status: 404, message: 'Client not found' };
  if (!isShopifyReadyForPublish(client)) {
    return { success: false, status: 400, message: 'Connect Shopify before publishing opt-in tools.' };
  }

  const validationErrors = validateToolForPublish(tool, client);
  if (validationErrors.length) {
    return { success: false, status: 400, message: validationErrors.join(' '), errors: validationErrors };
  }

  const embedKey = await ensureEmbedPublicKey(clientId);
  const { injectOptInScript } = require('../utils/shopify/shopifyHelper');
  const injectResult = await injectOptInScript(clientId, backendUrl, embedKey);

  if (!injectResult?.success) {
    return {
      success: false,
      status: 400,
      code: injectResult?.code,
      message: injectResult?.message || 'Theme inject failed. Ensure write_themes scope is granted.',
    };
  }

  if (tool.type === 'whatsapp_widget') {
    await enforceSingleLiveWhatsappWidget(clientId, tool._id);
  }

  tool.status = 'live';
  tool.publishedAt = new Date();
  tool.themeInjectVersion = (tool.themeInjectVersion || 0) + 1;
  await tool.save();

  await Client.updateOne(
    { clientId },
    {
      $set: {
        growthEmbedEnabled: true,
        shopifyOptInToolsInstalledAt: new Date(),
      },
    }
  );

  if (tool.design?.discount?.mode === 'auto_shopify') {
    const { replenishCouponPool } = require('./optInCouponService');
    replenishCouponPool(clientId, tool._id).catch((e) => {
      console.warn('[optInTools] coupon pool pregen failed', e.message);
    });
  }

  return {
    success: true,
    tool: serializeTool(tool),
    themeInject: injectResult,
    embedKey,
  };
}

async function syncThemeEmbed(clientId, backendUrl) {
  const client = await loadClientForPublish(clientId);
  if (!client) return { success: false, status: 404, message: 'Client not found' };
  if (!isShopifyReadyForPublish(client)) {
    return { success: false, status: 400, message: 'Connect Shopify before syncing theme.' };
  }
  const embedKey = await ensureEmbedPublicKey(clientId);
  const { injectOptInScript } = require('../utils/shopify/shopifyHelper');
  const injectResult = await injectOptInScript(clientId, backendUrl, embedKey);
  if (!injectResult?.success) {
    return {
      success: false,
      status: 400,
      message: injectResult?.message || 'Theme sync failed. Ensure write_themes scope is granted.',
    };
  }
  return { success: true, themeInject: injectResult, embedKey };
}

async function unpublishTool(clientId, toolId) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return { success: false, status: 404, message: 'Tool not found' };

  tool.status = 'draft';
  tool.updatedAt = new Date();
  await tool.save();

  const liveRemaining = await OptInTool.countDocuments({ clientId, status: 'live' });
  if (liveRemaining === 0) {
    const { removeOptInScript } = require('../utils/shopify/shopifyHelper');
    await removeOptInScript(clientId).catch(() => {});
    await Client.updateOne({ clientId }, { $set: { growthEmbedEnabled: false } });
  }

  return { success: true, tool: serializeTool(tool) };
}

async function getPublicConfig(embedKey) {
  const client = await Client.findOne({
    growthEmbedPublicKey: embedKey,
    growthEmbedEnabled: { $ne: false },
    isActive: { $ne: false },
  })
    .select('clientId businessName brand.businessName shopDomain growthEmbedEnabled whatsappDisplayPhoneNumber platformVars wabaAccounts whatsappConnected')
    .lean();

  if (!client) {
    return { success: false, reason: 'unknown_key' };
  }

  const tools = await OptInTool.find({ clientId: client.clientId, status: 'live' })
    .sort({ publishedAt: -1 })
    .lean();

  return {
    success: true,
    clientId: client.clientId,
    shopDomain: client.shopDomain || '',
    branding: {
      name: client.brand?.businessName || client.businessName || 'Our brand',
    },
    tools: tools.map((t) => serializeToolForPublic(t, client)),
  };
}

async function getToolWorkspaceMeta(clientId) {
  const client = await Client.findOne({ clientId })
    .select('whatsappDisplayPhoneNumber platformVars.adminWhatsappNumber wabaAccounts whatsappConnected')
    .lean();
  if (!client) return { whatsappConnected: false, merchantWaPhone: '' };
  return {
    whatsappConnected: client.whatsappConnected === true,
    merchantWaPhone: resolveMerchantWaPhone(client, {}),
  };
}

module.exports = {
  TOOL_TYPES,
  serializeTool,
  serializeToolForPublic,
  ensureEmbedPublicKey,
  getHubMetrics,
  listTools,
  getToolForClient,
  createTool,
  updateTool,
  duplicateTool,
  deleteTool,
  publishTool,
  unpublishTool,
  syncThemeEmbed,
  getPublicConfig,
  getToolWorkspaceMeta,
  validateToolForPublish,
  enforceSingleLiveWhatsappWidget,
  injectOptInScriptIntoLiquid,
  removeOptInScriptFromLiquid,
};
